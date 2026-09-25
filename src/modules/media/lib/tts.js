import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ActionError } from '../../../core/actions.js';
import { runFfmpeg } from './voice.js';
import { DEFAULT_UA } from './http.js';

export const TTS_LANGS = [
  { name: 'Français', value: 'fr', pico: 'fr-FR' }, { name: 'Anglais', value: 'en', pico: 'en-US' }, { name: 'Anglais (UK)', value: 'en-GB', pico: 'en-GB' }, { name: 'Espagnol', value: 'es', pico: 'es-ES' },
  { name: 'Allemand', value: 'de', pico: 'de-DE' }, { name: 'Italien', value: 'it', pico: 'it-IT' }, { name: 'Portugais', value: 'pt', pico: null }, { name: 'Néerlandais', value: 'nl', pico: null },
  { name: 'Japonais', value: 'ja', pico: null }, { name: 'Coréen', value: 'ko', pico: null }, { name: 'Chinois', value: 'zh-CN', pico: null }, { name: 'Arabe', value: 'ar', pico: null },
  { name: 'Russe', value: 'ru', pico: null }, { name: 'Polonais', value: 'pl', pico: null }, { name: 'Turc', value: 'tr', pico: null },
];

export const VOICES = {
  normal: { label: 'Normale', af: null },
  lente: { label: 'Lente', af: 'atempo=0.8' },
  rapide: { label: 'Rapide', af: 'atempo=1.35' },
  grave: { label: 'Grave', af: 'aresample=48000,asetrate=38400,aresample=48000,atempo=1.25' },
  aigue: { label: 'Aiguë', af: 'aresample=48000,asetrate=60000,aresample=48000,atempo=0.8' },
  robot: { label: 'Robot', af: "aresample=48000,afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75" },
  echo: { label: 'Écho', af: 'aecho=0.8:0.88:60:0.4' },
};

/** Split text into chunks of at most `max` characters, on sentence then word boundaries. */
export function splitText(text, max = 200) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…;:,]+[.!?…;:,]*\s*/g) || [clean];
  const out = []; let cur = '';
  const pushWord = (w) => { while (w.length > max) { out.push(w.slice(0, max)); w = w.slice(max); } return w; };
  for (const s of sentences) {
    if ((cur + s).trim().length <= max) { cur += s; continue; }
    if (cur.trim()) out.push(cur.trim()); cur = '';
    if (s.trim().length <= max) { cur = s; continue; }
    for (const word of s.split(' ')) {
      if ((cur + ' ' + word).trim().length <= max) cur = `${cur} ${word}`.trim();
      else { if (cur) out.push(cur); cur = pushWord(word); }
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function tmpDir() { const d = path.join(os.tmpdir(), `hb-tts-${crypto.randomBytes(6).toString('hex')}`); fs.mkdirSync(d, { recursive: true }); return d; }

async function googleChunks(text, lang, dir) {
  const chunks = splitText(text, 200);
  const files = [];
  for (let i = 0; i < chunks.length; i++) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunks[i])}&tl=${encodeURIComponent(lang)}&total=${chunks.length}&idx=${i}&textlen=${chunks[i].length}&client=tw-ob`;
    let res;
    try { res = await fetch(url, { headers: { 'user-agent': DEFAULT_UA, referer: 'https://translate.google.com/' }, signal: AbortSignal.timeout(10000) }); } catch (err) { throw new Error(`Google TTS injoignable (${err.cause?.code || err.message})`); }
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('audio')) throw new Error(`Google TTS a refusé la requête (HTTP ${res.status})`);
    const f = path.join(dir, `part${i}.mp3`);
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    files.push(f);
  }
  return files;
}

function which(bin) {
  return new Promise((resolve) => {
    const p = spawn(bin, ['--help'], { stdio: 'ignore' });
    p.on('error', () => resolve(false)); p.on('close', () => resolve(true));
  });
}

async function localTts(text, lang, dir) {
  const out = path.join(dir, 'local.wav');
  const LANG = TTS_LANGS.find((l) => l.value === lang);
  for (const bin of ['espeak-ng', 'espeak']) {
    if (!(await which(bin))) continue;
    await new Promise((resolve, reject) => {
      const p = spawn(bin, ['-v', lang.split('-')[0].toLowerCase(), '-s', '165', '-w', out, '--stdin'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => p.kill('SIGKILL'), 30000);
      p.on('error', reject); p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${bin} : ${err.trim() || `code ${code}`}`)); });
      p.stdin.end(text);
    });
    return { file: out, engine: bin };
  }
  if (LANG?.pico && await which('pico2wave')) {
    await new Promise((resolve, reject) => {
      const safe = text.startsWith('-') ? ` ${text}` : text;
      const p = spawn('pico2wave', ['-l', LANG.pico, '-w', out, safe], { stdio: 'ignore' });
      const t = setTimeout(() => p.kill('SIGKILL'), 30000);
      p.on('error', reject); p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`pico2wave : code ${code}`)); });
    });
    return { file: out, engine: 'pico2wave' };
  }
  return null;
}

/**
 * Synthesize `text` to an MP3 buffer.
 * @returns {Promise<{ buffer: Buffer, engine: string, chunks: number }>}
 */
export async function synthesize(text, { lang = 'fr', voice = 'normal', engine = 'auto' } = {}) {
  const dir = tmpDir();
  try {
    let inputs = null; let used = null; let googleError = null;
    if (engine !== 'local') {
      try { inputs = await googleChunks(text, lang, dir); used = 'google'; } catch (err) { googleError = err.message; if (engine === 'google') throw new ActionError(err.message); }
    }
    if (!inputs) {
      const local = await localTts(text, lang, dir);
      if (!local) throw new ActionError(`Synthèse vocale indisponible : ${googleError ? `${googleError} ; ` : ''}aucun moteur local (espeak-ng, espeak ou pico2wave) n'est installé.`);
      inputs = [local.file]; used = local.engine;
    }
    const out = path.join(dir, 'out.mp3');
    const af = VOICES[voice]?.af;
    const input = inputs.length > 1 ? `concat:${inputs.join('|')}` : inputs[0];
    const args = ['-y', '-i', input, ...(af ? ['-af', af] : []), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', out];
    const r = await runFfmpeg(args, { timeoutMs: 60000 });
    if (r.code !== 0 || !fs.existsSync(out)) throw new ActionError(`Conversion audio échouée : ${r.stderr.split('\n').filter(Boolean).pop() || 'erreur ffmpeg'}`);
    return { buffer: fs.readFileSync(out), engine: used, chunks: inputs.length };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => null);
  }
}
