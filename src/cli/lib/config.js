/**
 * Configuration de la CLI : ~/.heiphais.json, variables d'environnement, options globales
 * et repli sur le fichier .env du projet (panel local).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { CliError, EXIT } from './errors.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CONFIG_KEYS = ['url', 'token', 'defaultGuild'];

export function configPath() {
  return process.env.HEIPHAIS_CONFIG || path.join(os.homedir(), '.heiphais.json');
}

export function readConfigFile() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new CliError(`Impossible de lire ${file} : ${err.message}`);
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    throw new CliError(`Fichier de configuration invalide (${file}) : ${err.message}`, { hint: 'Corrigez-le ou supprimez-le : heiphais config clear' });
  }
}

export function writeConfigFile(data) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* système sans chmod */ }
  return file;
}

/** Fusionne un patch dans le fichier ; une valeur null/undefined supprime la clé. */
export function updateConfigFile(patch) {
  const data = readConfigFile();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') delete data[k];
    else data[k] = v;
  }
  return writeConfigFile(data);
}

export function clearConfigFile() {
  const file = configPath();
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw new CliError(`Impossible de supprimer ${file} : ${err.message}`);
  }
}

/** Normalise une URL de panel : ajoute http://, retire le / final et un éventuel suffixe /api. */
export function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, '').replace(/\/api$/i, '');
  try {
    new URL(u);
  } catch {
    throw new CliError(`URL invalide : ${url}`, { exitCode: EXIT.USAGE, hint: 'Exemple : http://127.0.0.1:3000 ou https://panel.mondomaine.fr' });
  }
  return u;
}

/** Lit le .env du projet sans polluer process.env. */
export function readProjectEnv() {
  const file = path.join(PROJECT_ROOT, '.env');
  try {
    return { file, values: dotenv.parse(fs.readFileSync(file)) };
  } catch {
    return { file, values: null };
  }
}

/** URL du panel local déduite de PANEL_HOST / PANEL_PORT / PANEL_PUBLIC_URL (.env du projet puis environnement). */
export function urlFromProjectEnv() {
  const { values } = readProjectEnv();
  const env = { ...(values || {}) };
  for (const k of ['PANEL_HOST', 'PANEL_PORT', 'PANEL_PUBLIC_URL']) if (process.env[k]) env[k] = process.env[k];
  let port = env.PANEL_PORT && /^\d+$/.test(env.PANEL_PORT) ? env.PANEL_PORT : null;
  if (!port && env.PANEL_PUBLIC_URL) {
    try { port = new URL(env.PANEL_PUBLIC_URL).port || null; } catch { /* ignore */ }
  }
  port ||= '3000';
  let host = (env.PANEL_HOST || '').trim();
  if (!host || host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
  else if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  const fromEnv = !!(values && (values.PANEL_PORT || values.PANEL_HOST || values.PANEL_PUBLIC_URL)) || !!(process.env.PANEL_PORT || process.env.PANEL_HOST);
  return { url: `http://${host}:${port}`, source: fromEnv ? '.env du projet (PANEL_HOST/PANEL_PORT)' : 'défaut (127.0.0.1:3000)' };
}

/**
 * Résout la configuration effective.
 * Priorité : option globale > variable d'environnement > ~/.heiphais.json > .env du projet.
 */
export function resolveConfig(opts = {}) {
  const file = readConfigFile();
  const out = { file: configPath(), fileData: file };

  if (opts.url) Object.assign(out, { url: normalizeUrl(opts.url), urlSource: 'option --url' });
  else if (process.env.HEIPHAIS_API_URL) Object.assign(out, { url: normalizeUrl(process.env.HEIPHAIS_API_URL), urlSource: 'variable HEIPHAIS_API_URL' });
  else if (file.url) Object.assign(out, { url: normalizeUrl(file.url), urlSource: configPath() });
  else {
    const local = urlFromProjectEnv();
    Object.assign(out, { url: local.url, urlSource: local.source });
  }

  if (opts.token) Object.assign(out, { token: String(opts.token).trim(), tokenSource: 'option --token' });
  else if (process.env.HEIPHAIS_API_TOKEN) Object.assign(out, { token: process.env.HEIPHAIS_API_TOKEN.trim(), tokenSource: 'variable HEIPHAIS_API_TOKEN' });
  else if (file.token) Object.assign(out, { token: String(file.token).trim(), tokenSource: configPath() });
  else Object.assign(out, { token: null, tokenSource: null });

  if (opts.guild) Object.assign(out, { guild: String(opts.guild).trim(), guildSource: 'option --guild' });
  else if (process.env.HEIPHAIS_GUILD) Object.assign(out, { guild: process.env.HEIPHAIS_GUILD.trim(), guildSource: 'variable HEIPHAIS_GUILD' });
  else if (file.defaultGuild) Object.assign(out, { guild: String(file.defaultGuild), guildSource: configPath() });
  else Object.assign(out, { guild: null, guildSource: null });

  return out;
}

export function maskToken(token) {
  if (!token) return null;
  const t = String(token);
  if (t.length <= 12) return `${t.slice(0, 3)}…`;
  return `${t.slice(0, 7)}…${t.slice(-4)}`;
}

export function cliVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
