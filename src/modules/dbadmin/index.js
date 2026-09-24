import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { ActionError } from '../../core/actions.js';
import { embed, codeBlock, truncate, discordTimestamp, COLORS } from '../../core/utils.js';
import { config } from '../../config.js';
import { MAX_ROWS, assertIdent, quoteIdent, prepareReadQuery, prepareWriteScript, renderTable, toCsv, rowsToObjects, bindable, cellText, timestampCutoff } from './sql.js';

const OWNER = 'owner';
const INLINE_LIMIT = 1900;
const FILE_LIMIT = 8 * 1024 * 1024;
const PROTECTED_PRUNE = new Set(['migrations', 'guilds', 'guild_modules', 'guild_settings', 'api_tokens', 'panel_users', 'kv', 'scheduled_jobs']);
const confirmParam = { type: 'boolean', description: 'Confirmer l\'opération d\'écriture', default: false };

const S = (ctx, guild) => (guild ? ctx.settings.get(guild.id, 'dbadmin') : ctx.settings.defaults('dbadmin'));
const dbPath = (ctx) => ctx.db.name || config.databasePath;

function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  n = Number(n); const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

function requireConfirm(params, what) {
  if (params.confirm !== true) throw new ActionError(`Opération d'écriture : ${what}. Relancez avec \`confirm: true\` pour confirmer.`, 'CONFIRM_REQUIRED');
}

// ------------------------------------------------------------------ read-only connection
let ro = null;
/** Second connection opened with { readonly: true } — writes are impossible at the SQLite level. */
function readonlyDb(ctx) {
  const file = dbPath(ctx);
  if (ro && ro.open && ro.name === file) return ro;
  try { ro?.close(); } catch { /* ignore */ }
  if (!file || file === ':memory:' || !fs.existsSync(file)) throw new ActionError('Base en mémoire : connexion en lecture seule impossible', 'NO_READONLY');
  ro = new Database(file, { readonly: true, fileMustExist: true });
  ro.pragma('busy_timeout = 5000');
  return ro;
}

// ------------------------------------------------------------------ schema helpers
function listTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
}
function requireTable(db, name) {
  const t = assertIdent(name, 'table');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) throw new ActionError(`Table inconnue : ${t}`, 'NOT_FOUND', 404);
  return t;
}
function tableColumns(db, table) { return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all(); }
function countRows(db, table) { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n; } catch { return null; } }

/** Size per table (table pages + its indexes) via dbstat when compiled in, else null. */
function tableSizes(db) {
  try {
    const pages = db.prepare('SELECT name, SUM(pgsize) AS size FROM dbstat GROUP BY name').all();
    const owner = new Map(db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index')").all().map((r) => [r.name, r.tbl_name]));
    const out = new Map();
    for (const p of pages) { const t = owner.get(p.name) || p.name; out.set(t, (out.get(t) || 0) + p.size); }
    return out;
  } catch { return null; }
}

function tablesInfo(db) {
  const sizes = tableSizes(db);
  const idx = new Map(db.prepare("SELECT tbl_name, COUNT(*) AS n FROM sqlite_master WHERE type = 'index' GROUP BY tbl_name").all().map((r) => [r.tbl_name, r.n]));
  return listTables(db).map((name) => ({ name, rows: countRows(db, name), size: sizes ? sizes.get(name) ?? 0 : null, size_h: sizes ? fmtBytes(sizes.get(name) ?? 0) : 'n/d', indexes: idx.get(name) || 0 }));
}

function tableAutocomplete(ctx, { value }) {
  try { return listTables(ctx.db).filter((t) => t.includes(String(value || '').toLowerCase())).slice(0, 25).map((t) => ({ name: t, value: t })); } catch { return []; }
}

/** Clear the settings cache of every known guild after raw writes. */
function invalidateSettings(ctx) {
  const ids = new Set(ctx.client.guilds.cache.keys());
  try { for (const r of ctx.db.prepare('SELECT DISTINCT guild_id FROM guild_settings UNION SELECT DISTINCT guild_id FROM guild_modules').all()) ids.add(r.guild_id); } catch { /* ignore */ }
  for (const id of ids) ctx.settings.invalidate(id);
}

function logOp(ctx, actor, { kind, target = null, sql = null, changes = null, ok = true, error = null, durationMs = null }) {
  try {
    ctx.db.prepare('INSERT INTO dba_log (actor_id, actor_tag, source, kind, target, sql, changes, ok, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(actor?.id || null, actor?.tag || null, actor?.source || null, kind, target, sql ? String(sql).slice(0, 8000) : null, changes, ok ? 1 : 0, error ? String(error).slice(0, 2000) : null, durationMs, Date.now());
  } catch (err) { ctx.log('dbadmin').warn({ err }, 'Journalisation dba_log impossible'); }
}

/** Render a result set: inline monospace table, otherwise CSV/JSON attachment. */
function renderResult({ title, columns, rows, format = 'auto', filename = 'resultat', footer, data = {} }) {
  const objects = rowsToObjects(columns, rows);
  const out = { data: { columns, rows: objects, count: rows.length, ...data } };
  const table = columns.length ? renderTable(columns, rows) : '(aucune colonne)';
  if (format === 'json') {
    out.embed = embed({ title, description: `${rows.length} ligne(s) — JSON en pièce jointe.`, footer });
    out.files = [{ attachment: Buffer.from(JSON.stringify(objects, null, 2)), name: `${filename}.json` }];
  } else if (format === 'csv' || (format === 'auto' && table.length > INLINE_LIMIT)) {
    out.embed = embed({ title, description: `${rows.length} ligne(s) — ${format === 'csv' ? 'CSV' : 'résultat trop large, CSV'} en pièce jointe.\n${codeBlock(truncate(table, 1200))}`, footer });
    out.files = [{ attachment: Buffer.from(toCsv(columns, rows)), name: `${filename}.csv` }];
  } else {
    out.embed = embed({ title, description: rows.length ? codeBlock(table) : 'Aucune ligne.', footer });
  }
  return out;
}

function textResult({ title, text, color = COLORS.info, filename = 'sortie.txt', footer, data = {} }) {
  const clean = String(text || '').trimEnd() || '(vide)';
  if (clean.length <= INLINE_LIMIT) return { embed: embed({ title, color, description: codeBlock(clean), footer }), data };
  return { embed: embed({ title, color, description: `Sortie tronquée (${clean.length} caractères), version complète en pièce jointe.\n${codeBlock(`${clean.slice(0, 1400)}\n…`)}`, footer }), files: [{ attachment: Buffer.from(clean), name: filename }], data };
}

function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); }

async function fetchJsonAttachment(url) {
  if (!/^https:\/\//i.test(url)) throw new ActionError('URL de fichier invalide (https requis)');
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new ActionError(`Téléchargement du fichier impossible (HTTP ${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 25 * 1024 * 1024) throw new ActionError('Fichier trop volumineux (25 Mo max)');
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new ActionError('Le fichier n\'est pas du JSON valide'); }
}

function backupDir(ctx) { const d = path.join(ctx.config.dataDir, 'dbadmin', 'backups'); fs.mkdirSync(d, { recursive: true }); return d; }

// ------------------------------------------------------------------ module
export default {
  name: 'dbadmin',
  label: 'Administration DB',
  description: 'Administration de la base SQLite du bot : tables, schéma, requêtes en lecture seule, écriture journalisée, export/import, maintenance.',
  category: 'system',
  icon: '🗄️',
  defaultEnabled: false,
  slashGroups: { db: 'Administration de la base SQLite (propriétaire)' },
  settings: {
    maxRows: { type: 'integer', label: 'Lignes max par requête', default: MAX_ROWS, min: 1, max: MAX_ROWS },
    backupKeep: { type: 'integer', label: 'Sauvegardes locales conservées', description: 'Utilisé quand le module sysadmin est absent/désactivé', default: 10, min: 1, max: 200 },
    cleanupDays: { type: 'integer', label: 'Délai de nettoyage des serveurs quittés (jours)', default: 30, min: 1, max: 3650 },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS dba_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, actor_tag TEXT, source TEXT, kind TEXT NOT NULL, target TEXT, sql TEXT, changes INTEGER, ok INTEGER NOT NULL DEFAULT 1, error TEXT, duration_ms INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_dba_log_created ON dba_log(created_at DESC);`,
  ],
  actions: {
    tables: {
      description: 'Tables : lignes et taille estimée', slash: { group: 'db', name: 'tables' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx) {
        const tables = tablesInfo(ctx.db);
        const total = tables.reduce((a, t) => a + (t.size || 0), 0);
        return renderResult({ title: `🗄️ ${tables.length} table(s)`, columns: ['table', 'lignes', 'taille', 'index'], rows: tables.map((t) => [t.name, t.rows ?? '?', t.size_h, t.indexes]), filename: 'tables', footer: tables[0]?.size === null ? 'Taille indisponible (dbstat non compilé)' : `Total ${fmtBytes(total)}`, data: { tables } });
      },
    },
    schema: {
      description: 'Schéma d\'une table', slash: { group: 'db', name: 'schema' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { table: { type: 'string', required: true, description: 'Table', autocomplete: tableAutocomplete, maxLength: 64 } },
      async run(ctx, { params }) {
        const t = requireTable(ctx.db, params.table);
        const cols = tableColumns(ctx.db, t);
        const sql = ctx.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql || '';
        const indexes = ctx.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name").all(t);
        const fks = ctx.db.prepare(`PRAGMA foreign_key_list(${quoteIdent(t)})`).all();
        const rows = countRows(ctx.db, t);
        const text = [renderTable(['#', 'colonne', 'type', 'non nul', 'défaut', 'pk'], cols.map((c) => [c.cid, c.name, c.type || '—', c.notnull ? 'oui' : '', c.dflt_value ?? '', c.pk || ''])), '', sql, ...indexes.filter((i) => i.sql).map((i) => `${i.sql};`), ...fks.map((f) => `-- FK ${f.from} → ${f.table}(${f.to})`)].join('\n');
        return textResult({ title: `📐 ${t} — ${rows ?? '?'} ligne(s)`, text, filename: `schema-${t}.sql.txt`, data: { table: t, rows, columns: cols, sql, indexes, foreignKeys: fks } });
      },
    },
    query: {
      description: 'Requête SELECT en lecture seule (200 lignes max)', slash: { group: 'db', name: 'query' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: {
        sql: { type: 'text', required: true, description: 'Requête SELECT / WITH / EXPLAIN', maxLength: 4000 },
        format: { type: 'choice', description: 'Rendu', default: 'auto', choices: ['auto', 'table', 'csv', 'json'].map((v) => ({ name: v, value: v })) },
      },
      async run(ctx, { params, guild }) {
        const max = Math.min(MAX_ROWS, S(ctx, guild).maxRows || MAX_ROWS);
        const q = prepareReadQuery(params.sql, max);
        const db = readonlyDb(ctx);
        let stmt;
        try { stmt = db.prepare(q.sql); } catch (err) { throw new ActionError(`Erreur SQL : ${err.message}`, 'SQL_ERROR'); }
        if (!stmt.reader) throw new ActionError('La requête ne renvoie pas de données', 'READ_ONLY');
        if (!stmt.readonly) throw new ActionError('Requête refusée : elle modifierait la base', 'READ_ONLY');
        const columns = stmt.columns().map((c) => c.name);
        const rows = []; let truncated = false;
        const t = performance.now();
        try {
          for (const r of stmt.raw(true).iterate()) { if (rows.length >= max) { truncated = true; break; } rows.push(r); }
        } catch (err) { throw new ActionError(`Erreur SQL : ${err.message}`, 'SQL_ERROR'); }
        const ms = performance.now() - t;
        const format = params.format === 'table' ? 'auto' : params.format;
        const res = renderResult({ title: `🔎 ${rows.length}${truncated ? '+' : ''} ligne(s) — ${ms.toFixed(1)} ms`, columns, rows, format, filename: 'requete', footer: [truncated ? `Limité à ${max} lignes` : null, q.injected ? `LIMIT ${max + 1} ajouté automatiquement` : null, 'lecture seule'].filter(Boolean).join(' · '), data: { truncated, limitInjected: q.injected, durationMs: ms, sql: q.sql } });
        if (params.format === 'table' && res.files) res.embed.setDescription(`${rows.length} ligne(s) — tableau trop large pour Discord, CSV en pièce jointe.`);
        return res;
      },
    },
    exec: {
      description: 'Exécuter du SQL d\'écriture (transaction, journalisé)', slash: { group: 'db', name: 'exec' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { sql: { type: 'text', required: true, description: 'Instructions SQL (INSERT/UPDATE/DELETE/…)', maxLength: 6000 }, confirm: confirmParam },
      async run(ctx, { params, actor }) {
        const stmts = prepareWriteScript(params.sql);
        requireConfirm(params, `exécuter ${stmts.length} instruction(s) SQL`);
        const db = ctx.db;
        const t = performance.now();
        let changes = 0; let returned = null;
        try {
          db.transaction(() => {
            for (const st of stmts) {
              const prepared = db.prepare(st.text);
              if (prepared.reader) { const rows = prepared.raw(true).all(); returned = { columns: prepared.columns().map((c) => c.name), rows: rows.slice(0, 50) }; }
              else changes += prepared.run().changes;
            }
          })();
        } catch (err) {
          logOp(ctx, actor, { kind: 'exec', sql: params.sql, ok: false, error: err.message, durationMs: Math.round(performance.now() - t) });
          throw new ActionError(`Erreur SQL (transaction annulée) : ${err.message}`, 'SQL_ERROR');
        }
        const ms = Math.round(performance.now() - t);
        logOp(ctx, actor, { kind: 'exec', sql: params.sql, changes, durationMs: ms });
        invalidateSettings(ctx);
        const extra = returned ? `\n${codeBlock(truncate(renderTable(returned.columns, returned.rows), 1500))}` : '';
        return { message: `${stmts.length} instruction(s) exécutée(s) en ${ms} ms — ${changes} ligne(s) modifiée(s).${extra}`, data: { statements: stmts.length, changes, durationMs: ms, returned: returned ? rowsToObjects(returned.columns, returned.rows) : null } };
      },
    },
    export: {
      description: 'Exporter une table (CSV ou JSON)', slash: { group: 'db', name: 'export' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { table: { type: 'string', required: true, description: 'Table', autocomplete: tableAutocomplete, maxLength: 64 }, format: { type: 'choice', description: 'Format', default: 'csv', choices: [{ name: 'csv', value: 'csv' }, { name: 'json', value: 'json' }] } },
      async run(ctx, { params }) {
        const t = requireTable(ctx.db, params.table);
        const stmt = readonlyDb(ctx).prepare(`SELECT * FROM ${quoteIdent(t)}`);
        const columns = stmt.columns().map((c) => c.name);
        const rows = stmt.raw(true).all();
        let buf = Buffer.from(params.format === 'json' ? JSON.stringify(rowsToObjects(columns, rows), null, 2) : toCsv(columns, rows));
        let name = `${t}-${stamp()}.${params.format}`;
        const rawBytes = buf.length;
        if (buf.length > FILE_LIMIT) { buf = zlib.gzipSync(buf); name += '.gz'; }
        const data = { table: t, format: params.format, rows: rows.length, bytes: rawBytes };
        if (rawBytes <= 512 * 1024) data.content = params.format === 'json' ? rowsToObjects(columns, rows) : buf.toString();
        if (buf.length > FILE_LIMIT) {
          const dir = path.join(ctx.config.dataDir, 'dbadmin', 'exports'); fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, name); fs.writeFileSync(file, buf);
          return { message: `Export trop volumineux pour Discord (${fmtBytes(buf.length)} compressé) : enregistré sur le serveur dans \`${file}\`.`, data: { ...data, file } };
        }
        return { embed: embed({ title: `📤 Export de ${t}`, description: `${rows.length} ligne(s), ${fmtBytes(rawBytes)}${name.endsWith('.gz') ? ' (compressé gzip)' : ''}.` }), files: [{ attachment: buf, name }], data };
      },
    },
    import: {
      description: 'Importer des lignes JSON dans une table', slash: { group: 'db', name: 'import' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        table: { type: 'string', required: true, description: 'Table cible', autocomplete: tableAutocomplete, maxLength: 64 },
        fichier: { type: 'attachment', description: 'Fichier JSON (tableau d\'objets)' },
        json: { type: 'json', description: 'Ou le JSON directement' },
        mode: { type: 'choice', description: 'En cas de conflit', default: 'insert', choices: [{ name: 'insert (erreur)', value: 'insert' }, { name: 'replace', value: 'replace' }, { name: 'ignore', value: 'ignore' }] },
        truncate: { type: 'boolean', description: 'Vider la table avant import', default: false },
        confirm: confirmParam,
      },
      async run(ctx, { params, actor }) {
        const t = requireTable(ctx.db, params.table);
        let payload = params.json ?? null;
        if (payload === null && params.fichier) payload = await fetchJsonAttachment(params.fichier);
        if (payload === null) throw new ActionError('Fournissez un fichier JSON (`fichier`) ou du JSON (`json`)');
        const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.content) ? payload.content : null;
        if (!rows) throw new ActionError('Format attendu : un tableau d\'objets (ou { "rows": [...] })');
        if (!rows.length) throw new ActionError('Aucune ligne à importer');
        if (rows.length > 100000) throw new ActionError('100 000 lignes maximum par import');
        if (rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new ActionError('Chaque ligne doit être un objet { colonne: valeur }');
        const known = new Set(tableColumns(ctx.db, t).map((c) => c.name));
        const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        const unknown = cols.filter((c) => !known.has(c));
        if (unknown.length) throw new ActionError(`Colonnes inconnues dans ${t} : ${unknown.slice(0, 10).join(', ')}`);
        requireConfirm(params, `importer ${rows.length} ligne(s) dans ${t}${params.truncate ? ' après l\'avoir vidée' : ''}`);
        const verb = params.mode === 'replace' ? 'INSERT OR REPLACE' : params.mode === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT';
        const stmt = ctx.db.prepare(`${verb} INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        const started = performance.now();
        let inserted = 0; let removed = 0;
        try {
          ctx.db.transaction(() => {
            if (params.truncate) removed = ctx.db.prepare(`DELETE FROM ${quoteIdent(t)}`).run().changes;
            for (const r of rows) inserted += stmt.run(...cols.map((c) => bindable(r[c]))).changes;
          })();
        } catch (err) {
          logOp(ctx, actor, { kind: 'import', target: t, ok: false, error: err.message });
          throw new ActionError(`Import annulé : ${err.message}`, 'SQL_ERROR');
        }
        const ms = Math.round(performance.now() - started);
        logOp(ctx, actor, { kind: 'import', target: t, sql: `${verb} ×${rows.length}${params.truncate ? ' (après DELETE)' : ''}`, changes: inserted + removed, durationMs: ms });
        invalidateSettings(ctx);
        return { message: `${inserted} ligne(s) importée(s) dans **${t}** (${params.mode})${params.truncate ? `, ${removed} supprimée(s) avant` : ''} en ${ms} ms.${inserted < rows.length ? ` ${rows.length - inserted} ignorée(s).` : ''}`, data: { table: t, received: rows.length, inserted, removed, durationMs: ms } };
      },
    },
    vacuum: {
      description: 'VACUUM + checkpoint WAL (compacte la base)', slash: { group: 'db', name: 'vacuum' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      async run(ctx, { actor }) {
        const file = dbPath(ctx);
        const before = fileSize(file) + fileSize(`${file}-wal`);
        const t = performance.now();
        try { ctx.db.exec('VACUUM'); ctx.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (err) { logOp(ctx, actor, { kind: 'vacuum', ok: false, error: err.message }); throw new ActionError(`VACUUM impossible : ${err.message}`); }
        const ms = Math.round(performance.now() - t);
        const after = fileSize(file) + fileSize(`${file}-wal`);
        logOp(ctx, actor, { kind: 'vacuum', sql: 'VACUUM; PRAGMA wal_checkpoint(TRUNCATE)', durationMs: ms });
        return { message: `VACUUM terminé en ${ms} ms : ${fmtBytes(before)} → ${fmtBytes(after)} (gain ${fmtBytes(Math.max(0, before - after))}).`, data: { before, after, durationMs: ms } };
      },
    },
    integrity: {
      description: 'Vérifier l\'intégrité (integrity_check, clés étrangères)', slash: { group: 'db', name: 'integrity' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { quick: { type: 'boolean', description: 'quick_check (plus rapide)', default: false } },
      async run(ctx, { params }) {
        const t = performance.now();
        const res = ctx.db.pragma(`${params.quick ? 'quick_check' : 'integrity_check'}(100)`).map((r) => Object.values(r)[0]);
        const fk = ctx.db.pragma('foreign_key_check');
        const ms = Math.round(performance.now() - t);
        const ok = res.length === 1 && res[0] === 'ok' && !fk.length;
        return { embed: embed({ color: ok ? COLORS.success : COLORS.error, title: ok ? '✅ Base intègre' : '❌ Problèmes détectés', fields: [
          { name: params.quick ? 'quick_check' : 'integrity_check', value: codeBlock(truncate(res.join('\n'), 950)) },
          { name: 'Clés étrangères', value: fk.length ? codeBlock(truncate(fk.map((f) => `${f.table}#${f.rowid} → ${f.parent}`).join('\n'), 950)) : 'OK' },
        ], footer: `${ms} ms` }), data: { ok, result: res, foreignKeyErrors: fk, durationMs: ms } };
      },
    },
    size: {
      description: 'Taille du fichier, WAL et pages libres', slash: { group: 'db', name: 'size' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx) {
        const file = dbPath(ctx);
        const p = (k) => ctx.db.pragma(k, { simple: true });
        const d = { file, main: fileSize(file), wal: fileSize(`${file}-wal`), shm: fileSize(`${file}-shm`), pageSize: p('page_size'), pageCount: p('page_count'), freelist: p('freelist_count'), journalMode: p('journal_mode'), autoVacuum: p('auto_vacuum'), sqlite: ctx.db.prepare('SELECT sqlite_version() AS v').get().v };
        d.freeBytes = d.freelist * d.pageSize;
        return { embed: embed({ title: '📏 Taille de la base', fields: [
          { name: 'Fichier', value: `\`${truncate(file, 200)}\`` }, { name: 'Base', value: fmtBytes(d.main), inline: true }, { name: 'WAL', value: fmtBytes(d.wal), inline: true }, { name: 'SHM', value: fmtBytes(d.shm), inline: true },
          { name: 'Pages', value: `${d.pageCount} × ${fmtBytes(d.pageSize)}`, inline: true }, { name: 'Pages libres', value: `${d.freelist} (${fmtBytes(d.freeBytes)})${d.freeBytes > d.main * 0.2 ? ' → `db vacuum` conseillé' : ''}`, inline: true },
          { name: 'Journal / auto_vacuum', value: `${d.journalMode} / ${['none', 'full', 'incremental'][d.autoVacuum] ?? d.autoVacuum}`, inline: true }, { name: 'SQLite', value: d.sqlite, inline: true },
        ] }), data: d };
      },
    },
    stats: {
      description: 'Statistiques : lignes par table, plus grosses tables', slash: { group: 'db', name: 'stats' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx) {
        const tables = tablesInfo(ctx.db);
        const counts = Object.fromEntries(ctx.db.prepare("SELECT type, COUNT(*) AS n FROM sqlite_master GROUP BY type").all().map((r) => [r.type, r.n]));
        const byRows = [...tables].sort((a, b) => (b.rows || 0) - (a.rows || 0));
        const bySize = tables[0]?.size !== null ? [...tables].sort((a, b) => (b.size || 0) - (a.size || 0)) : null;
        const totalRows = tables.reduce((a, t) => a + (t.rows || 0), 0);
        return { embed: embed({ title: '📊 Statistiques de la base', fields: [
          { name: 'Objets', value: `${counts.table || 0} tables · ${counts.index || 0} index · ${counts.view || 0} vues · ${counts.trigger || 0} déclencheurs` },
          { name: `Top lignes (total ${totalRows})`, value: codeBlock(renderTable(['table', 'lignes'], byRows.slice(0, 10).map((t) => [t.name, t.rows ?? '?']))), inline: true },
          { name: 'Top taille', value: bySize ? codeBlock(renderTable(['table', 'taille'], bySize.slice(0, 10).map((t) => [t.name, t.size_h]))) : 'dbstat indisponible', inline: true },
        ] }), data: { objects: counts, totalRows, tables } };
      },
    },
    backup: {
      description: 'Sauvegarder la base (via sysadmin si disponible)', slash: { group: 'db', name: 'backup' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      async run(ctx, { guild, actor }) {
        if (ctx.actions.get('sysadmin', 'dbbackup_now')) {
          try {
            const res = await ctx.actions.run({ module: 'sysadmin', action: 'dbbackup_now', guildId: guild?.id || null, actor, params: {}, skipPermissions: true, audit: false });
            logOp(ctx, actor, { kind: 'backup', target: 'sysadmin.dbbackup_now', sql: res?.data?.file || null });
            return res;
          } catch (err) {
            if (!(err instanceof ActionError) || !['MODULE_DISABLED', 'NOT_FOUND'].includes(err.code)) throw err;
          }
        }
        const dir = backupDir(ctx);
        const dest = path.join(dir, `heiphaisbot-${stamp()}.db`);
        const t = performance.now();
        try { await ctx.db.backup(dest); } catch (err) { logOp(ctx, actor, { kind: 'backup', target: dest, ok: false, error: err.message }); throw new ActionError(`Sauvegarde impossible : ${err.message}`); }
        const ms = Math.round(performance.now() - t);
        const keep = S(ctx, guild).backupKeep;
        const files = fs.readdirSync(dir).filter((f) => /^heiphaisbot-\d{8}-\d{6}\.db$/.test(f)).sort().reverse();
        const removed = files.slice(keep);
        for (const f of removed) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
        logOp(ctx, actor, { kind: 'backup', target: dest, durationMs: ms });
        return { message: `Sauvegarde créée : \`${dest}\` (${fmtBytes(fileSize(dest))}, ${ms} ms)${removed.length ? ` — ${removed.length} ancienne(s) supprimée(s)` : ''}.`, data: { file: dest, size: fileSize(dest), durationMs: ms, removed, via: 'local' } };
      },
    },
    prune: {
      description: 'Supprimer les lignes plus vieilles que N jours', slash: { group: 'db', name: 'prune' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        table: { type: 'string', required: true, description: 'Table (ex : audit_log)', autocomplete: tableAutocomplete, maxLength: 64 },
        days: { type: 'integer', required: true, description: 'Âge minimum en jours', min: 1, max: 36500 },
        column: { type: 'string', description: 'Colonne date (défaut created_at)', default: 'created_at', maxLength: 64 },
        confirm: confirmParam,
      },
      async run(ctx, { params, actor }) {
        const t = requireTable(ctx.db, params.table);
        if (PROTECTED_PRUNE.has(t)) throw new ActionError(`La table ${t} est protégée contre la purge par date`);
        const col = assertIdent(params.column, 'colonne');
        if (!tableColumns(ctx.db, t).some((c) => c.name === col)) throw new ActionError(`Colonne inconnue : ${t}.${col}`);
        const sample = ctx.db.prepare(`SELECT MAX(${quoteIdent(col)}) AS v FROM ${quoteIdent(t)}`).get().v;
        if (sample === null || sample === undefined) return { info: true, message: `La table ${t} ne contient aucune valeur dans ${col}.`, data: { table: t, matched: 0 } };
        const cutoff = timestampCutoff(sample, Date.now() - params.days * 86400000);
        const where = `${quoteIdent(col)} IS NOT NULL AND ${quoteIdent(col)} < ?`;
        const matched = ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t)} WHERE ${where}`).get(cutoff.value).n;
        if (!params.confirm) return { info: true, message: `Aperçu : **${matched}** ligne(s) de **${t}** ont ${col} antérieur à ${params.days} jour(s) (unité détectée : ${cutoff.unit}). Relancez avec \`confirm: true\` pour supprimer.`, data: { table: t, column: col, matched, unit: cutoff.unit, cutoff: cutoff.value, deleted: 0 } };
        const started = performance.now();
        const deleted = ctx.db.prepare(`DELETE FROM ${quoteIdent(t)} WHERE ${where}`).run(cutoff.value).changes;
        const ms = Math.round(performance.now() - started);
        logOp(ctx, actor, { kind: 'prune', target: t, sql: `DELETE FROM ${t} WHERE ${col} < ${cutoff.value}`, changes: deleted, durationMs: ms });
        return { message: `${deleted} ligne(s) supprimée(s) de **${t}** (${col} > ${params.days} j). Pensez à \`db vacuum\` pour récupérer l'espace.`, data: { table: t, column: col, deleted, unit: cutoff.unit, durationMs: ms } };
      },
    },
    settings: {
      description: 'Lecture brute de guild_settings', slash: { group: 'db', name: 'settings' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { guild: { type: 'string', description: 'ID du serveur (défaut : courant)', maxLength: 22 }, module: { type: 'string', description: 'Module', maxLength: 32, autocomplete: (ctx, { value }) => [...ctx.modules.keys()].filter((m) => m.includes(String(value || '').toLowerCase())).slice(0, 25).map((m) => ({ name: m, value: m })) } },
      async run(ctx, { params, guild }) {
        const gid = params.guild || guild?.id;
        if (!gid || !/^\d{15,22}$/.test(gid)) throw new ActionError('Indiquez un ID de serveur valide (`guild`)');
        if (params.module) assertIdent(params.module.replace(/-/g, '_'), 'module');
        const rows = ctx.db.prepare('SELECT module, data, updated_at FROM guild_settings WHERE guild_id = ? AND (? IS NULL OR module = ?) ORDER BY module').all(gid, params.module || null, params.module || null);
        const enabled = ctx.db.prepare('SELECT module, enabled FROM guild_modules WHERE guild_id = ? AND (? IS NULL OR module = ?) ORDER BY module').all(gid, params.module || null, params.module || null);
        const parsed = rows.map((r) => { let data; try { data = JSON.parse(r.data); } catch { data = r.data; } return { module: r.module, updated_at: r.updated_at, data }; });
        const text = [`-- guild_modules (${enabled.length})`, enabled.map((e) => `${e.module}: ${e.enabled ? 'activé' : 'désactivé'}`).join('\n') || '(aucune ligne)', '', `-- guild_settings (${rows.length})`, ...parsed.map((p) => `[${p.module}] ${p.updated_at ? new Date(p.updated_at).toISOString() : ''}\n${JSON.stringify(p.data, null, 2)}`)].join('\n');
        return textResult({ title: `⚙️ Données brutes — ${ctx.client.guilds.cache.get(gid)?.name || gid}${params.module ? ` / ${params.module}` : ''}`, text, filename: `settings-${gid}.json.txt`, data: { guildId: gid, settings: parsed, modules: enabled } });
      },
    },
    kv: {
      description: 'Table kv : list, get, set, delete', slash: { group: 'db', name: 'kv' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        action: { type: 'choice', description: 'Opération', default: 'list', choices: ['list', 'get', 'set', 'delete'].map((v) => ({ name: v, value: v })) },
        key: { type: 'string', description: 'Clé (ou préfixe pour list)', maxLength: 200 },
        value: { type: 'text', description: 'Valeur (JSON ou texte) pour set', maxLength: 6000 },
      },
      async run(ctx, { params, actor }) {
        if (params.action === 'list') {
          const rows = ctx.db.prepare("SELECT key, LENGTH(value) AS size, updated_at FROM kv WHERE (? IS NULL OR key LIKE ? ESCAPE '\\') ORDER BY key LIMIT 200").all(params.key || null, params.key ? `${params.key.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);
          return renderResult({ title: `🔑 kv — ${rows.length} clé(s)`, columns: ['clé', 'taille', 'modifiée'], rows: rows.map((r) => [r.key, r.size, r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 19) : '—']), filename: 'kv', data: { keys: rows } });
        }
        if (!params.key) throw new ActionError('Paramètre `key` requis');
        if (params.action === 'get') {
          const row = ctx.db.prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(params.key);
          if (!row) throw new ActionError(`Clé inconnue : ${params.key}`, 'NOT_FOUND', 404);
          let value; try { value = JSON.parse(row.value); } catch { value = row.value; }
          return textResult({ title: `🔑 ${truncate(params.key, 200)}`, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2), filename: 'kv-value.txt', data: { key: params.key, value, updated_at: row.updated_at } });
        }
        if (params.action === 'set') {
          if (params.value === null || params.value === undefined) throw new ActionError('Paramètre `value` requis');
          let value; try { value = JSON.parse(params.value); } catch { value = params.value; }
          ctx.db.kvSet(params.key, value);
          logOp(ctx, actor, { kind: 'kv_set', target: params.key, sql: truncate(JSON.stringify(value), 2000), changes: 1 });
          return { message: `Clé \`${truncate(params.key, 200)}\` enregistrée (${typeof value === 'string' ? 'texte' : 'JSON'}).`, data: { key: params.key, value } };
        }
        const n = ctx.db.kvDel(params.key).changes;
        if (!n) throw new ActionError(`Clé inconnue : ${params.key}`, 'NOT_FOUND', 404);
        logOp(ctx, actor, { kind: 'kv_delete', target: params.key, changes: n });
        return { message: `Clé \`${truncate(params.key, 200)}\` supprimée.`, data: { key: params.key, deleted: n } };
      },
    },
    jobs: {
      description: 'Jobs planifiés : list / delete', slash: { group: 'db', name: 'jobs' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        action: { type: 'choice', description: 'Opération', default: 'list', choices: [{ name: 'list', value: 'list' }, { name: 'delete', value: 'delete' }] },
        id: { type: 'integer', description: 'ID du job (delete)', min: 1 },
        module: { type: 'string', description: 'Filtrer par module', maxLength: 32 },
      },
      async run(ctx, { params, actor }) {
        if (params.action === 'delete') {
          if (!params.id) throw new ActionError('Paramètre `id` requis');
          const job = ctx.scheduler.get(params.id);
          if (!job) throw new ActionError(`Job #${params.id} introuvable`, 'NOT_FOUND', 404);
          ctx.scheduler.cancel(job.id);
          logOp(ctx, actor, { kind: 'job_delete', target: `${job.module}:${job.type}#${job.id}`, sql: JSON.stringify(job.payload).slice(0, 2000), changes: 1 });
          return { message: `Job #${job.id} (${job.module}:${job.type}) supprimé.`, data: job };
        }
        const jobs = ctx.db.prepare('SELECT * FROM scheduled_jobs WHERE (? IS NULL OR module = ?) ORDER BY run_at ASC LIMIT 200').all(params.module || null, params.module || null);
        const fmtRepeat = (ms) => (ms ? (ms % 86400000 === 0 ? `${ms / 86400000} j` : ms % 3600000 === 0 ? `${ms / 3600000} h` : ms % 60000 === 0 ? `${ms / 60000} min` : `${ms} ms`) : '—');
        return renderResult({ title: `⏲️ ${jobs.length} job(s) planifié(s)`, columns: ['id', 'module', 'type', 'serveur', 'exécution', 'répétition'], rows: jobs.map((j) => [j.id, j.module, j.type, j.guild_id || '—', new Date(j.run_at).toISOString().slice(0, 16).replace('T', ' '), fmtRepeat(j.repeat_ms)]), filename: 'jobs', data: { jobs: jobs.map((j) => ({ ...j, payload: (() => { try { return JSON.parse(j.payload); } catch { return j.payload; } })() })) } });
      },
    },
    sessions: {
      description: 'Purger les sessions du panel (expirées ou toutes)', slash: { group: 'db', name: 'sessions' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { all: { type: 'boolean', description: 'Supprimer TOUTES les sessions (déconnecte tout le monde)', default: false }, confirm: confirmParam },
      async run(ctx, { params, actor }) {
        let n;
        if (params.all) { requireConfirm(params, 'supprimer toutes les sessions du panel'); n = ctx.db.prepare('DELETE FROM sessions').run().changes; }
        else n = ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
        const left = ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
        logOp(ctx, actor, { kind: 'sessions_purge', target: params.all ? 'all' : 'expired', changes: n });
        return { message: `${n} session(s) supprimée(s)${params.all ? ' (toutes)' : ' (expirées)'} — ${left} restante(s).`, data: { deleted: n, remaining: left } };
      },
    },
    migrations: {
      description: 'Migrations appliquées par module', slash: { group: 'db', name: 'migrations' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx) {
        const rows = ctx.db.prepare('SELECT module, COUNT(*) AS n, MAX(version) AS v, MAX(applied_at) AS at FROM migrations GROUP BY module ORDER BY module').all();
        const applied = new Map(rows.map((r) => [r.module, r]));
        const list = [...new Set([...applied.keys(), ...ctx.modules.keys()])].sort().map((m) => {
          const r = applied.get(m); const expected = m === 'core' ? null : ctx.modules.get(m)?.migrations?.length ?? null;
          return { module: m, applied: r?.n || 0, version: r?.v || 0, expected, applied_at: r?.at || null, pending: expected !== null && (r?.v || 0) < expected };
        }).filter((x) => x.applied || x.expected);
        return renderResult({ title: `🧬 Migrations (${list.length} modules)`, columns: ['module', 'version', 'attendue', 'dernière application'], rows: list.map((x) => [x.module, x.version, x.expected ?? '—', x.applied_at ? new Date(x.applied_at).toISOString().slice(0, 16).replace('T', ' ') : '—']), filename: 'migrations', footer: list.some((x) => x.pending) ? 'Des migrations sont en attente (redémarrage requis)' : undefined, data: { migrations: list } });
      },
    },
    guilds: {
      description: 'Table guilds (présence, départ)', slash: { group: 'db', name: 'guilds' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { left_only: { type: 'boolean', description: 'Seulement les serveurs quittés', default: false } },
      async run(ctx, { params }) {
        const rows = ctx.db.prepare(`SELECT id, name, member_count, joined_at, left_at FROM guilds ${params.left_only ? 'WHERE left_at IS NOT NULL' : ''} ORDER BY COALESCE(left_at, 0) DESC, name LIMIT 500`).all();
        const d = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '—');
        return renderResult({ title: `🏠 ${rows.length} serveur(s)`, columns: ['id', 'nom', 'membres', 'arrivée', 'départ', 'présent'], rows: rows.map((g) => [g.id, g.name, g.member_count, d(g.joined_at), d(g.left_at), ctx.client.guilds.cache.has(g.id) ? 'oui' : 'non']), filename: 'guilds', data: { guilds: rows.map((g) => ({ ...g, present: ctx.client.guilds.cache.has(g.id) })) } });
      },
    },
    cleanup: {
      description: 'Supprimer les données des serveurs quittés', slash: { group: 'db', name: 'cleanup' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { days: { type: 'integer', description: 'Quittés depuis plus de N jours', min: 1, max: 3650 }, confirm: confirmParam },
      async run(ctx, { params, guild, actor }) {
        const days = params.days || S(ctx, guild).cleanupDays;
        const cutoff = Date.now() - days * 86400000;
        const gone = ctx.db.prepare('SELECT id, name, left_at FROM guilds WHERE left_at IS NOT NULL AND left_at < ?').all(cutoff).filter((g) => !ctx.client.guilds.cache.has(g.id));
        if (!gone.length) return { info: true, message: `Aucun serveur quitté depuis plus de ${days} jour(s).`, data: { guilds: [], tables: {} } };
        const tables = listTables(ctx.db).filter((t) => tableColumns(ctx.db, t).some((c) => c.name === 'guild_id'));
        const counts = {};
        for (const t of tables) {
          const stmt = ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t)} WHERE guild_id = ?`);
          const n = gone.reduce((a, g) => a + stmt.get(g.id).n, 0);
          if (n) counts[t] = n;
        }
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}: ${n}`).join('\n') || '(aucune donnée liée)';
        if (!params.confirm) {
          return { embed: embed({ color: COLORS.warning, title: `🧹 Aperçu : ${gone.length} serveur(s), ${total} ligne(s)`, description: `Serveurs quittés depuis plus de ${days} j :\n${gone.slice(0, 15).map((g) => `• ${g.name || g.id} (\`${g.id}\`) — parti ${discordTimestamp(g.left_at)}`).join('\n')}${gone.length > 15 ? `\n… et ${gone.length - 15} autre(s)` : ''}\n${codeBlock(truncate(summary, 1500))}\nRelancez avec \`confirm: true\` pour supprimer.` }), data: { guilds: gone, tables: counts, total, deleted: 0 } };
        }
        const started = performance.now();
        let deleted = 0;
        try {
          ctx.db.transaction(() => {
            for (const t of Object.keys(counts)) { const del = ctx.db.prepare(`DELETE FROM ${quoteIdent(t)} WHERE guild_id = ?`); for (const g of gone) deleted += del.run(g.id).changes; }
            const delGuild = ctx.db.prepare('DELETE FROM guilds WHERE id = ?');
            for (const g of gone) deleted += delGuild.run(g.id).changes;
          })();
        } catch (err) { logOp(ctx, actor, { kind: 'cleanup_guilds', ok: false, error: err.message }); throw new ActionError(`Nettoyage annulé : ${err.message}`, 'SQL_ERROR'); }
        for (const g of gone) ctx.settings.invalidate(g.id);
        const ms = Math.round(performance.now() - started);
        logOp(ctx, actor, { kind: 'cleanup_guilds', target: gone.map((g) => g.id).join(',').slice(0, 2000), sql: summary, changes: deleted, durationMs: ms });
        return { message: `${gone.length} serveur(s) nettoyé(s) : ${deleted} ligne(s) supprimée(s) dans ${Object.keys(counts).length + 1} table(s) en ${ms} ms.`, data: { guilds: gone.map((g) => g.id), tables: counts, deleted, durationMs: ms } };
      },
    },
    log: {
      description: 'Journal des opérations d\'écriture dbadmin', slash: { group: 'db', name: 'log' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { limit: { type: 'integer', description: 'Nombre', min: 1, max: 100, default: 15 } },
      async run(ctx, { params }) {
        const rows = ctx.db.prepare('SELECT * FROM dba_log ORDER BY id DESC LIMIT ?').all(params.limit);
        return renderResult({ title: `📒 Journal dbadmin (${rows.length})`, columns: ['#', 'date', 'type', 'cible', 'lignes', 'ok', 'auteur'], rows: rows.map((r) => [r.id, new Date(r.created_at).toISOString().slice(5, 16).replace('T', ' '), r.kind, r.target || cellText(r.sql, { max: 30 }), r.changes ?? '—', r.ok ? '✓' : '✗', r.actor_tag || r.actor_id || '—']), filename: 'dba_log', data: { entries: rows } });
      },
    },
  },
  api(router, ctx) {
    router.addHook('preHandler', async (request) => { if (!request.auth?.isOwner) throw new ActionError('Réservé au propriétaire du bot', 'FORBIDDEN', 403); });
    router.get('/tables', async () => ({ ok: true, tables: tablesInfo(ctx.db) }));
    router.get('/log', async (request) => ({ ok: true, entries: ctx.db.prepare('SELECT * FROM dba_log ORDER BY id DESC LIMIT ?').all(Math.min(Number(request.query.limit) || 100, 500)) }));
  },
  panel: {
    views: [
      { id: 'tables', title: 'Tables', endpoint: 'tables', key: 'tables', columns: [{ key: 'name', label: 'Table' }, { key: 'rows', label: 'Lignes', type: 'number' }, { key: 'size_h', label: 'Taille' }, { key: 'indexes', label: 'Index', type: 'number' }],
        rowActions: [{ label: 'Schéma', action: 'schema', params: { table: '{{name}}' } }, { label: 'Purger (jours)', action: 'prune', params: { table: '{{name}}', confirm: true }, prompt: ['days', 'column'], confirm: true, danger: true }],
        quickActions: ['query', 'exec', 'integrity', 'size', 'vacuum', 'backup'] },
      { id: 'log', title: 'Journal', endpoint: 'log', key: 'entries', columns: [{ key: 'id', label: '#' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type' }, { key: 'target', label: 'Cible' }, { key: 'sql', label: 'SQL' }, { key: 'changes', label: 'Lignes', type: 'number' }, { key: 'ok', label: 'OK', type: 'boolean' }, { key: 'actor_id', label: 'Auteur', type: 'user' }] },
    ],
  },
};
