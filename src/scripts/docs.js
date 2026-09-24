/**
 * Génère docs/COMMANDES.md : la liste complète des modules, commandes slash, actions et paramètres.
 * Usage : node src/scripts/docs.js
 */
process.env.PANEL_SESSION_SECRET ||= 'docs';
process.env.DATABASE_PATH ||= `/tmp/heiphaisbot-docs-${process.pid}.db`;
process.env.LOG_LEVEL ||= 'silent';
const fs = await import('node:fs');
const path = await import('node:path');
const { logger } = await import('../core/logger.js');
const { openDatabase } = await import('../core/database.js');
const { createClient } = await import('../core/client.js');
const { loadModules } = await import('../core/loader.js');
const { createContext } = await import('../core/context.js');
const { ROOT } = await import('../config.js');

const CATEGORIES = { general: 'Général', moderation: 'Modération', security: 'Sécurité', community: 'Communauté', utility: 'Utilitaires', fun: 'Fun', music: 'Musique & médias', economy: 'Économie & jeux', gaming: 'Gaming', integrations: 'Intégrations', system: 'Système & DevOps' };

const db = openDatabase();
const modules = await loadModules({ logger });
const ctx = createContext({ client: createClient(), db, modules });
const actions = ctx.actions.list();

const byCat = new Map();
for (const mod of modules.values()) { const c = mod.category || 'general'; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(mod); }

let out = `# HeiphaisBot — Référence des modules et commandes\n\n`;
out += `> Généré automatiquement par \`node src/scripts/docs.js\`. ${modules.size} modules, ${ctx.slash.builders.length} commandes slash de premier niveau, ${actions.length} actions.\n\n`;
out += `Chaque action est disponible en commande slash, via l'API (\`POST /api/guilds/:id/actions/<module>/<action>\`), via la CLI (\`heiphais <module> <action> k=v\`) et dans le panel.\n\n`;
out += `## Sommaire\n\n`;
for (const [cat, mods] of byCat) out += `- **${CATEGORIES[cat] || cat}** : ${mods.map((m) => `[${m.label || m.name}](#${m.name})`).join(', ')}\n`;
out += '\n';
for (const [cat, mods] of byCat) {
  out += `\n# ${CATEGORIES[cat] || cat}\n`;
  for (const mod of mods) {
    const acts = actions.filter((a) => a.module === mod.name);
    out += `\n## ${mod.icon || '📦'} ${mod.label || mod.name} <a id="${mod.name}"></a>\n\n`;
    out += `\`${mod.name}\` — ${mod.description || ''} ${mod.core ? '*(module essentiel)*' : mod.defaultEnabled === false ? '*(désactivé par défaut)*' : ''}\n\n`;
    const settings = Object.entries(mod.settings || {});
    if (settings.length) {
      out += `**Paramètres (${settings.length})** : ${settings.map(([k, d]) => `\`${k}\` (${d.type}${d.default !== undefined && d.default !== null && typeof d.default !== 'object' ? `, défaut \`${String(d.default).slice(0, 40)}\`` : ''}) — ${d.label || ''}`).join(' · ')}\n\n`;
    }
    if (acts.length) {
      out += `| Commande | Action | Description | Paramètres | Permissions |\n|---|---|---|---|---|\n`;
      for (const a of acts) {
        const params = Object.entries(a.params).map(([k, p]) => `\`${k}\`${p.required ? '*' : ''} (${p.type})`).join(', ');
        const perms = a.permissions === 'owner' ? 'Propriétaire du bot' : Array.isArray(a.permissions) && a.permissions.length ? a.permissions.join(', ') : 'Tous';
        out += `| ${a.slash ? `\`${a.slash}\`` : '—'} | \`${a.name}\` | ${a.description.replace(/\|/g, '\\|')} | ${params || '—'} | ${perms} |\n`;
      }
      out += '\n';
    }
    const menus = (mod.contextMenus || []).map((c) => c.data.name);
    if (menus.length) out += `**Menus contextuels** : ${menus.map((m) => `« ${m} »`).join(', ')}\n\n`;
    const views = mod.panel?.views || [];
    if (views.length) out += `**Vues du panel** : ${views.map((v) => v.title).join(', ')}\n\n`;
  }
}
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'COMMANDES.md'), out);
console.log(`docs/COMMANDES.md généré : ${modules.size} modules, ${ctx.slash.builders.length} commandes, ${actions.length} actions`);
ctx.scheduler.stop();
db.close();
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch { /* ignore */ } }
process.exit(0);
