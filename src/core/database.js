import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

const CORE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS migrations (module TEXT NOT NULL, version INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY(module, version));
   CREATE TABLE IF NOT EXISTS guilds (id TEXT PRIMARY KEY, name TEXT, icon TEXT, owner_id TEXT, member_count INTEGER DEFAULT 0, joined_at INTEGER, left_at INTEGER, prefix TEXT, locale TEXT DEFAULT 'fr');
   CREATE TABLE IF NOT EXISTS guild_modules (guild_id TEXT NOT NULL, module TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(guild_id, module));
   CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT NOT NULL, module TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated_at INTEGER, PRIMARY KEY(guild_id, module));
   CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, actor_id TEXT, actor_tag TEXT, source TEXT, module TEXT, action TEXT, params TEXT, ok INTEGER, result TEXT, created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_audit_guild ON audit_log(guild_id, created_at DESC);
   CREATE TABLE IF NOT EXISTS scheduled_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, module TEXT NOT NULL, type TEXT NOT NULL, run_at INTEGER NOT NULL, repeat_ms INTEGER, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_jobs_run ON scheduled_jobs(run_at);
   CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, user_id TEXT, scope TEXT NOT NULL DEFAULT 'admin', guild_ids TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER);
   CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS panel_users (user_id TEXT PRIMARY KEY, username TEXT, global_name TEXT, avatar TEXT, access_token TEXT, refresh_token TEXT, token_expires_at INTEGER, guilds TEXT, is_local_admin INTEGER DEFAULT 0, updated_at INTEGER);
   CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);`,
];

export function openDatabase(dbPath = config.databasePath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, 'core', CORE_MIGRATIONS);
  attachHelpers(db);
  logger.info({ module: 'db', path: dbPath }, 'Base de données ouverte');
  return db;
}

export function migrate(db, moduleName, migrations = []) {
  if (!migrations.length) return;
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (module TEXT NOT NULL, version INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY(module, version))`);
  const applied = new Set(db.prepare('SELECT version FROM migrations WHERE module = ?').all(moduleName).map((r) => r.version));
  const insert = db.prepare('INSERT INTO migrations (module, version, applied_at) VALUES (?, ?, ?)');
  migrations.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      insert.run(moduleName, version, Date.now());
    })();
    logger.debug({ module: 'db' }, `Migration ${moduleName}#${version} appliquée`);
  });
}

function attachHelpers(db) {
  db.kvGet = (key, def = null) => {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : def;
  };
  db.kvSet = (key, value) => {
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), Date.now());
  };
  db.kvDel = (key) => db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

export const json = {
  parse(v, def = null) {
    if (v === null || v === undefined) return def;
    try { return JSON.parse(v); } catch { return def; }
  },
  str(v) { return JSON.stringify(v ?? null); },
};
