/**
 * Mode local (bootstrap sans API) : accès direct à la base SQLite du bot pour gérer les jetons API.
 * Même format que src/web/auth.js : `hb_` + 24 octets hex, sha256 stocké dans api_tokens.token_hash.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { PROJECT_ROOT } from './config.js';
import { CliError, EXIT } from './errors.js';

const API_TOKENS_DDL = `CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, user_id TEXT, scope TEXT NOT NULL DEFAULT 'admin', guild_ids TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER)`;

/** Chemin de la base : --db > DATABASE_PATH / DATA_DIR (.env du projet, via src/config.js). */
export async function localDatabasePath(explicit) {
  if (explicit) return path.resolve(explicit);
  process.env.DOTENV_CONFIG_QUIET ??= 'true';
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });
  const { config } = await import('../../config.js');
  return path.isAbsolute(config.databasePath) ? config.databasePath : path.resolve(PROJECT_ROOT, config.databasePath);
}

export async function openLocalDatabase(explicit, { create = false } = {}) {
  const file = await localDatabasePath(explicit);
  const exists = fs.existsSync(file);
  if (!exists && !create) {
    throw new CliError(`Base de données introuvable : ${file}`, {
      exitCode: EXIT.NOT_FOUND,
      hint: 'Lancez la CLI depuis le serveur du bot, ou précisez --db <chemin> (DATABASE_PATH dans .env).',
    });
  }
  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch (err) {
    throw new CliError(`better-sqlite3 indisponible : ${err.message}`, { hint: 'Exécutez npm install dans le dossier du bot.' });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db;
  try {
    db = new Database(file);
  } catch (err) {
    throw new CliError(`Impossible d'ouvrir ${file} : ${err.message}`, { hint: 'Vérifiez les droits d\'accès (exécutez la CLI avec l\'utilisateur du bot).' });
  }
  db.pragma('busy_timeout = 5000');
  db.exec(API_TOKENS_DDL);
  return { db, file, created: !exists };
}

export const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export async function createLocalToken({ name, scope = 'admin', guildIds = [], userId = null, expiresInDays = null, dbPath = null }) {
  const { db, file, created } = await openLocalDatabase(dbPath, { create: true });
  try {
    const raw = `hb_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
    const info = db.prepare('INSERT INTO api_tokens (name, token_hash, user_id, scope, guild_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, hashToken(raw), userId, scope === 'guild' ? 'guild' : 'admin', JSON.stringify(guildIds), Date.now(), expiresAt);
    return { id: Number(info.lastInsertRowid), token: raw, dbFile: file, createdDb: created, expiresAt };
  } finally {
    db.close();
  }
}

export async function listLocalTokens(dbPath = null) {
  const { db, file } = await openLocalDatabase(dbPath);
  try {
    const tokens = db.prepare('SELECT id, name, user_id, scope, guild_ids, created_at, last_used_at, expires_at FROM api_tokens ORDER BY id DESC').all()
      .map((t) => ({ ...t, guild_ids: safeParse(t.guild_ids, []) }));
    return { tokens, dbFile: file };
  } finally {
    db.close();
  }
}

export async function deleteLocalToken(id, dbPath = null) {
  const { db } = await openLocalDatabase(dbPath);
  try {
    return db.prepare('DELETE FROM api_tokens WHERE id = ?').run(Number(id)).changes > 0;
  } finally {
    db.close();
  }
}

function safeParse(v, def) {
  try { return v ? JSON.parse(v) : def; } catch { return def; }
}
