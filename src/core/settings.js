import { json } from './database.js';

/**
 * Per-guild settings & module enable state.
 * Each module declares `settings` schema: { key: { type, default, label, description, ... } }
 */
export function createSettingsStore(db, modules) {
  const cache = new Map(); // `${guildId}:${module}` -> object
  const enabledCache = new Map();

  const stmts = {
    get: db.prepare('SELECT data FROM guild_settings WHERE guild_id = ? AND module = ?'),
    set: db.prepare('INSERT INTO guild_settings (guild_id, module, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, module) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
    del: db.prepare('DELETE FROM guild_settings WHERE guild_id = ? AND module = ?'),
    getEnabled: db.prepare('SELECT enabled FROM guild_modules WHERE guild_id = ? AND module = ?'),
    setEnabled: db.prepare('INSERT INTO guild_modules (guild_id, module, enabled) VALUES (?, ?, ?) ON CONFLICT(guild_id, module) DO UPDATE SET enabled = excluded.enabled'),
    allEnabled: db.prepare('SELECT module, enabled FROM guild_modules WHERE guild_id = ?'),
    allSettings: db.prepare('SELECT module, data FROM guild_settings WHERE guild_id = ?'),
  };

  function schemaOf(moduleName) {
    return modules.get(moduleName)?.settings || {};
  }

  function defaults(moduleName) {
    const out = {};
    for (const [key, def] of Object.entries(schemaOf(moduleName))) {
      out[key] = def.default === undefined ? null : (typeof def.default === 'object' && def.default !== null ? structuredClone(def.default) : def.default);
    }
    return out;
  }

  function get(guildId, moduleName) {
    const ck = `${guildId}:${moduleName}`;
    if (cache.has(ck)) return cache.get(ck);
    const row = stmts.get.get(String(guildId), moduleName);
    const stored = row ? json.parse(row.data, {}) : {};
    const merged = { ...defaults(moduleName), ...stored };
    cache.set(ck, merged);
    return merged;
  }

  function coerce(def, value) {
    if (value === null || value === undefined || value === '') return def.type === 'list' ? [] : null;
    switch (def.type) {
      case 'number': case 'integer': { const n = Number(value); if (Number.isNaN(n)) throw new Error(`Valeur numérique invalide: ${value}`); return def.type === 'integer' ? Math.round(n) : n; }
      case 'boolean': return typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on', 'oui'].includes(String(value).toLowerCase());
      case 'list': { const arr = Array.isArray(value) ? value : String(value).split(/[,\n]/).map((s) => s.trim()).filter(Boolean); return arr.map((v) => String(v)); }
      case 'json': return typeof value === 'string' ? JSON.parse(value) : value;
      case 'choice': if (def.choices && !def.choices.some((c) => (c.value ?? c) === value)) throw new Error(`Valeur non autorisée pour ${def.label || 'ce champ'}: ${value}`); return value;
      default: return typeof value === 'string' ? value : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }

  function set(guildId, moduleName, patch) {
    const schema = schemaOf(moduleName);
    const current = { ...get(guildId, moduleName) };
    for (const [key, value] of Object.entries(patch || {})) {
      if (!schema[key]) throw new Error(`Paramètre inconnu pour le module ${moduleName}: ${key}`);
      current[key] = coerce(schema[key], value);
    }
    // Only persist keys that are in the schema
    const toStore = {};
    for (const key of Object.keys(schema)) toStore[key] = current[key];
    stmts.set.run(String(guildId), moduleName, JSON.stringify(toStore), Date.now());
    cache.set(`${guildId}:${moduleName}`, { ...defaults(moduleName), ...toStore });
    return cache.get(`${guildId}:${moduleName}`);
  }

  function reset(guildId, moduleName) {
    stmts.del.run(String(guildId), moduleName);
    cache.delete(`${guildId}:${moduleName}`);
    return get(guildId, moduleName);
  }

  function isEnabled(guildId, moduleName) {
    const mod = modules.get(moduleName);
    if (!mod) return false;
    if (mod.core) return true;
    const ck = `${guildId}:${moduleName}`;
    if (enabledCache.has(ck)) return enabledCache.get(ck);
    const row = stmts.getEnabled.get(String(guildId), moduleName);
    const enabled = row ? !!row.enabled : mod.defaultEnabled !== false;
    enabledCache.set(ck, enabled);
    return enabled;
  }

  function setEnabled(guildId, moduleName, enabled) {
    const mod = modules.get(moduleName);
    if (!mod) throw new Error(`Module inconnu: ${moduleName}`);
    if (mod.core && !enabled) throw new Error(`Le module ${moduleName} est essentiel et ne peut pas être désactivé`);
    stmts.setEnabled.run(String(guildId), moduleName, enabled ? 1 : 0);
    enabledCache.set(`${guildId}:${moduleName}`, !!enabled);
    return !!enabled;
  }

  function allForGuild(guildId) {
    const out = {};
    for (const [name] of modules) out[name] = { enabled: isEnabled(guildId, name), settings: get(guildId, name) };
    return out;
  }

  function exportGuild(guildId) {
    const modulesState = {};
    for (const r of stmts.allEnabled.all(String(guildId))) modulesState[r.module] = !!r.enabled;
    const settings = {};
    for (const r of stmts.allSettings.all(String(guildId))) settings[r.module] = json.parse(r.data, {});
    return { modules: modulesState, settings };
  }

  function importGuild(guildId, data) {
    for (const [name, enabled] of Object.entries(data.modules || {})) if (modules.has(name)) setEnabled(guildId, name, enabled);
    for (const [name, values] of Object.entries(data.settings || {})) if (modules.has(name)) {
      const schema = schemaOf(name);
      const filtered = Object.fromEntries(Object.entries(values).filter(([k]) => schema[k]));
      set(guildId, name, filtered);
    }
  }

  function invalidate(guildId) {
    for (const key of [...cache.keys()]) if (key.startsWith(`${guildId}:`)) cache.delete(key);
    for (const key of [...enabledCache.keys()]) if (key.startsWith(`${guildId}:`)) enabledCache.delete(key);
  }

  return { get, set, reset, isEnabled, setEnabled, allForGuild, exportGuild, importGuild, defaults, schemaOf, invalidate };
}
