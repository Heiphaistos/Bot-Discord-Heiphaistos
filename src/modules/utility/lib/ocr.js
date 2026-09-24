/** OCR engines: OCR.space (API key or free "helloworld" demo key) and local tesseract CLI. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ActionError } from '../../../core/actions.js';
import { fetchWithTimeout, downloadBuffer, assertPublicUrl } from './net.js';

// our code → [OCR.space code, tesseract code, label]
export const OCR_LANGS = {
  fr: ['fre', 'fra', 'Français'], en: ['eng', 'eng', 'Anglais'], es: ['spa', 'spa', 'Espagnol'], de: ['ger', 'deu', 'Allemand'], it: ['ita', 'ita', 'Italien'],
  pt: ['por', 'por', 'Portugais'], nl: ['dut', 'nld', 'Néerlandais'], pl: ['pol', 'pol', 'Polonais'], ru: ['rus', 'rus', 'Russe'], tr: ['tur', 'tur', 'Turc'],
  ja: ['jpn', 'jpn', 'Japonais'], ko: ['kor', 'kor', 'Coréen'], zh: ['chs', 'chi_sim', 'Chinois simplifié'], ar: ['ara', 'ara', 'Arabe'], auto: ['auto', 'eng', 'Automatique'],
};

function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout))));
  });
}

let tesseractPath;
export async function findTesseract() {
  if (tesseractPath !== undefined) return tesseractPath;
  try { tesseractPath = (await run('which', ['tesseract'], { timeout: 5000 })).trim() || null; } catch { tesseractPath = null; }
  return tesseractPath;
}

async function ocrSpace(imageUrl, lang, apiKey) {
  const form = new URLSearchParams();
  form.set('url', imageUrl);
  form.set('apikey', apiKey);
  const l = OCR_LANGS[lang]?.[0] || 'eng';
  // Engine 2 supports automatic language detection; engine 1 needs an explicit language
  form.set('OCREngine', l === 'auto' ? '2' : (['chs', 'jpn', 'kor', 'ara'].includes(l) ? '1' : '2'));
  form.set('language', l);
  form.set('scale', 'true');
  form.set('detectOrientation', 'true');
  const res = await fetchWithTimeout('https://api.ocr.space/parse/image', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, 30000);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(`OCR.space HTTP ${res.status}`);
  if (data.IsErroredOnProcessing) throw new Error(`OCR.space : ${[].concat(data.ErrorMessage || data.ErrorDetails || 'erreur').join(' ')}`);
  const text = (data.ParsedResults || []).map((r) => r.ParsedText || '').join('\n').trim();
  return { text, engine: apiKey === 'helloworld' ? 'OCR.space (clé de démonstration)' : 'OCR.space' };
}

async function tesseract(bin, imageUrl, lang) {
  const { buffer } = await downloadBuffer(imageUrl, { maxBytes: 10 * 1024 * 1024 });
  const file = path.join(os.tmpdir(), `hb-ocr-${crypto.randomBytes(6).toString('hex')}`);
  await fs.writeFile(file, buffer);
  try {
    const want = OCR_LANGS[lang]?.[1] || 'eng';
    let langs = [];
    try { langs = (await run(bin, ['--list-langs'], { timeout: 5000 })).split('\n').slice(1).map((s) => s.trim()).filter(Boolean); } catch { /* ignore */ }
    const useLang = !langs.length || langs.includes(want) ? want : (langs.includes('eng') ? 'eng' : langs[0]);
    const text = await run(bin, [file, 'stdout', '-l', useLang], { timeout: 45000 });
    return { text: text.trim(), engine: `Tesseract (${useLang})` };
  } finally { await fs.unlink(file).catch(() => null); }
}

/**
 * Extract text from an image URL.
 * opts = { apiKey, allowDemo }
 */
export async function ocrImage(imageUrl, lang = 'fr', { apiKey = null, allowDemo = true } = {}) {
  await assertPublicUrl(imageUrl);
  const errors = [];
  if (apiKey) {
    try { return await ocrSpace(imageUrl, lang, apiKey); } catch (err) { errors.push(err.message); }
  }
  const bin = await findTesseract();
  if (bin) {
    try { return await tesseract(bin, imageUrl, lang); } catch (err) { errors.push(`Tesseract : ${err.userFacing ? err.message : (err.stderr || err.message).toString().slice(0, 200)}`); }
  }
  if (allowDemo) {
    try { return await ocrSpace(imageUrl, lang, 'helloworld'); } catch (err) { errors.push(err.message); }
  }
  throw new ActionError(`OCR indisponible${errors.length ? ` (${errors.join(' ; ')})` : ''}. Configurez une clé OCR.space gratuite (paramètre « ocrSpaceKey » du module utility ou variable OCR_SPACE_API_KEY) ou installez tesseract-ocr sur le serveur.`, 'OCR_UNAVAILABLE', 503);
}
