import { json } from './database.js';

/**
 * Persistent job scheduler backed by SQLite.
 * Modules register handlers via `jobs: { type: async (ctx, job) => {} }`.
 */
export function createScheduler(ctx) {
  const { db, logger } = ctx;
  const handlers = new Map(); // `${module}:${type}` -> fn
  let timer = null;
  let running = false;

  const stmts = {
    insert: db.prepare('INSERT INTO scheduled_jobs (guild_id, module, type, run_at, repeat_ms, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    due: db.prepare('SELECT * FROM scheduled_jobs WHERE run_at <= ? ORDER BY run_at ASC LIMIT 50'),
    del: db.prepare('DELETE FROM scheduled_jobs WHERE id = ?'),
    reschedule: db.prepare('UPDATE scheduled_jobs SET run_at = ? WHERE id = ?'),
    get: db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?'),
    list: db.prepare('SELECT * FROM scheduled_jobs WHERE (? IS NULL OR guild_id = ?) AND (? IS NULL OR module = ?) ORDER BY run_at ASC LIMIT ?'),
    byModuleType: db.prepare('SELECT * FROM scheduled_jobs WHERE module = ? AND type = ? AND (? IS NULL OR guild_id = ?)'),
  };

  function register(moduleName, type, fn) { handlers.set(`${moduleName}:${type}`, fn); }

  function schedule({ guildId = null, module, type, runAt, repeatMs = null, payload = {} }) {
    const at = runAt instanceof Date ? runAt.getTime() : Number(runAt);
    const info = stmts.insert.run(guildId ? String(guildId) : null, module, type, at, repeatMs, JSON.stringify(payload), Date.now());
    return Number(info.lastInsertRowid);
  }

  function cancel(id) { return stmts.del.run(id).changes > 0; }

  /** Cancel jobs matching module/type and a predicate on payload. */
  function cancelWhere(module, type, guildId = null, predicate = () => true) {
    let n = 0;
    for (const row of stmts.byModuleType.all(module, type, guildId, guildId)) {
      if (predicate(json.parse(row.payload, {}), row)) { stmts.del.run(row.id); n++; }
    }
    return n;
  }

  function find(module, type, guildId = null, predicate = () => true) {
    return stmts.byModuleType.all(module, type, guildId, guildId).map(hydrate).filter((j) => predicate(j.payload, j));
  }

  function list({ guildId = null, module = null, limit = 100 } = {}) {
    return stmts.list.all(guildId, guildId, module, module, limit).map(hydrate);
  }

  function hydrate(row) { return { ...row, payload: json.parse(row.payload, {}) }; }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const rows = stmts.due.all(Date.now());
      for (const row of rows) {
        const job = hydrate(row);
        const handler = handlers.get(`${job.module}:${job.type}`);
        // Remove or reschedule before executing to avoid double runs
        if (job.repeat_ms && job.repeat_ms > 0) {
          let next = job.run_at + job.repeat_ms;
          while (next <= Date.now()) next += job.repeat_ms;
          stmts.reschedule.run(next, job.id);
        } else stmts.del.run(job.id);
        if (!handler) { logger.warn({ module: 'scheduler' }, `Aucun handler pour le job ${job.module}:${job.type}`); continue; }
        try { await handler(ctx, job); } catch (err) { logger.error({ module: 'scheduler', err }, `Erreur job ${job.module}:${job.type}#${job.id}`); }
      }
    } finally { running = false; }
  }

  function start(intervalMs = 10000) { if (!timer) { timer = setInterval(() => tick().catch(() => {}), intervalMs); timer.unref?.(); tick().catch(() => {}); } }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { register, schedule, cancel, cancelWhere, find, list, get: (id) => { const r = stmts.get.get(id); return r ? hydrate(r) : null; }, tick, start, stop };
}
