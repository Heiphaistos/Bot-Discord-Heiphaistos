// État global du panel : utilisateur, catalogue des modules, caches par serveur.
import { api } from './api.js';

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) { try { fn(payload); } catch (err) { console.error(err); } }
}

export const state = {
  me: null,          // réponse de GET /api/me
  catalog: null,     // modules décrits (GET /api/modules)
  catalogMap: new Map(),
  guildId: null,     // serveur courant
  guilds: new Map(), // cache par serveur
};

function gcache(gid) {
  if (!state.guilds.has(gid)) state.guilds.set(gid, { channels: null, roles: null, modules: null, members: new Map(), pending: {} });
  return state.guilds.get(gid);
}

export async function loadMe(opts = {}) {
  const me = await api.get('/me', opts);
  state.me = me;
  emit('me', me);
  return me;
}

export async function loadCatalog(force = false) {
  if (state.catalog && !force) return state.catalog;
  const res = await api.get('/modules');
  state.catalog = res.modules || [];
  state.catalogMap = new Map(state.catalog.map((m) => [m.name, m]));
  emit('catalog', state.catalog);
  return state.catalog;
}

export const getModuleDesc = (name) => state.catalogMap.get(name) || null;
export function getActionDesc(moduleName, actionName) {
  return getModuleDesc(moduleName)?.actions.find((a) => a.name === actionName) || null;
}
export const guildInfo = (gid) => state.me?.guilds?.find((g) => g.id === gid) || null;
export const isOwner = () => !!state.me?.isOwner;
export const botName = () => state.me?.config?.botName || 'HeiphaisBot';

async function cached(gid, key, loader, force) {
  const c = gcache(gid);
  if (c[key] && !force) return c[key];
  if (c.pending[key] && !force) return c.pending[key];
  const p = loader().then((v) => { c[key] = v; delete c.pending[key]; emit(key, gid); return v; }, (err) => { delete c.pending[key]; throw err; });
  c.pending[key] = p;
  return p;
}

export const getChannels = (gid, force = false) => cached(gid, 'channels', async () => (await api.get(`/guilds/${gid}/channels`, { silent: true })).channels || [], force);
export const getRoles = (gid, force = false) => cached(gid, 'roles', async () => (await api.get(`/guilds/${gid}/roles`, { silent: true })).roles || [], force);
export const getGuildModules = (gid, force = false) => cached(gid, 'modules', async () => (await api.get(`/guilds/${gid}/modules`)).modules || {}, force);

export const channelsSync = (gid) => (gid && state.guilds.get(gid)?.channels) || [];
export const rolesSync = (gid) => (gid && state.guilds.get(gid)?.roles) || [];
export const modulesSync = (gid) => (gid && state.guilds.get(gid)?.modules) || null;
export const channelById = (gid, id) => channelsSync(gid).find((c) => c.id === id) || null;
export const roleById = (gid, id) => rolesSync(gid).find((r) => r.id === id) || null;

export function isModuleEnabled(gid, name) {
  const mods = modulesSync(gid);
  const desc = getModuleDesc(name);
  if (desc?.core) return true;
  if (!mods) return desc ? desc.defaultEnabled : false;
  return !!mods[name]?.enabled;
}

export function setModuleEnabled(gid, name, enabled) {
  const c = gcache(gid);
  if (c.modules) c.modules[name] = { ...(c.modules[name] || {}), enabled };
  emit('modules', gid);
}

export function primeGuild(gid, { channels, roles } = {}) {
  const c = gcache(gid);
  if (channels) { c.channels = channels; emit('channels', gid); }
  if (roles) { c.roles = roles; emit('roles', gid); }
}

/** Membre (avec cache et déduplication) ; null si introuvable. */
export function getMember(gid, uid) {
  if (!gid || !uid) return Promise.resolve(null);
  const c = gcache(gid);
  if (c.members.has(uid)) return c.members.get(uid);
  const p = api.get(`/guilds/${gid}/members/${uid}`, { silent: true }).then((r) => r.member, () => null);
  c.members.set(uid, p);
  p.then((m) => { c.members.set(uid, Promise.resolve(m)); c.membersResolved ??= new Map(); c.membersResolved.set(uid, m); });
  return p;
}
export const memberSync = (gid, uid) => state.guilds.get(gid)?.membersResolved?.get(uid) || null;
export function rememberMembers(gid, members) {
  const c = gcache(gid);
  c.membersResolved ??= new Map();
  for (const m of members || []) { c.membersResolved.set(m.id, m); if (!c.members.has(m.id)) c.members.set(m.id, Promise.resolve(m)); }
}

export function invalidateGuild(gid) { state.guilds.delete(gid); emit('modules', gid); }
