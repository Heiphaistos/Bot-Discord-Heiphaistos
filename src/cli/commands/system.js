/**
 * Commandes système (jeton admin / propriétaire) : journaux, serveurs, déploiement, redémarrage, présence.
 */
import { c, table, print, printJson, success, info, warn, formatDate, kv } from '../lib/output.js';
import { usageError } from '../lib/errors.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVEL_NAMES = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [v, k]));
const LEVEL_COLORS = { 10: c.gray, 20: c.gray, 30: c.green, 40: c.yellow, 50: c.red, 60: (s) => c.bold(c.red(s)) };
const ACTIVITY_TYPES = ['Playing', 'Streaming', 'Listening', 'Watching', 'Competing', 'Custom'];

function formatLog(l) {
  const lvl = LEVEL_NAMES[l.level] || String(l.level);
  const col = LEVEL_COLORS[l.level] || ((s) => s);
  const time = formatDate(l.time).slice(11);
  return `${c.gray(time)} ${col(lvl.toUpperCase().padEnd(5))} ${l.module ? c.cyan(`[${l.module}]`) : ''} ${l.msg ?? ''}${l.err ? c.red(` — ${l.err}`) : ''}`.replace(/\s+$/, '');
}

export function registerSystemCommands(program, rt) {
  program.command('logs').description('Journaux récents du bot (propriétaire)')
    .option('--limit <n>', 'Nombre de lignes (≤ 500)', '100')
    .option('--level <niveau>', 'Niveau minimum : trace, debug, info, warn, error, fatal')
    .option('--module <nom>', 'Filtrer par module')
    .option('-f, --follow', 'Suivre en continu (interrogation toutes les 3 s, Ctrl+C pour arrêter)')
    .action(async (o) => {
      let min = 0;
      if (o.level) {
        min = LEVELS[String(o.level).toLowerCase()] ?? Number(o.level);
        if (!min && min !== 0) throw usageError(`Niveau inconnu : ${o.level}`, `Niveaux : ${Object.keys(LEVELS).join(', ')}`);
        if (Number.isNaN(min)) throw usageError(`Niveau inconnu : ${o.level}`, `Niveaux : ${Object.keys(LEVELS).join(', ')}`);
      }
      const keep = (l) => (l.level ?? 0) >= min && (!o.module || l.module === o.module);
      const limit = Math.min(Math.max(Number(o.limit) || 100, 1), 500);
      const api = rt.api();
      const first = await api.get('/system/logs', { query: { limit: o.follow ? 500 : limit } });
      const seen = new Set();
      const keyOf = (l) => `${l.time}|${l.level}|${l.msg}`;
      const emit = (l) => (rt.json ? process.stdout.write(`${JSON.stringify(l)}\n`) : print(formatLog(l)));
      const initial = (first.logs || []).filter(keep);
      for (const l of first.logs || []) seen.add(keyOf(l));
      if (!o.follow) {
        if (rt.json) return printJson({ ok: true, logs: initial.slice(-limit) });
        if (!initial.length) return info('Aucune ligne de journal (pour ces filtres).');
        return initial.slice(-limit).forEach(emit);
      }
      initial.slice(-limit).forEach(emit);
      info(c.gray('— suivi des journaux (Ctrl+C pour arrêter) —'));
      const controller = new AbortController();
      rt.abort = controller;
      const onSigint = () => controller.abort();
      if (!rt.inShell) process.once('SIGINT', onSigint);
      let lost = false;
      try {
        while (!controller.signal.aborted) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 3000);
            controller.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
          if (controller.signal.aborted) break;
          try {
            const res = await api.get('/system/logs', { query: { limit: 500 }, signal: controller.signal });
            if (lost) { info(c.green('Connexion au panel rétablie.')); lost = false; }
            for (const l of res.logs || []) {
              const k = keyOf(l);
              if (seen.has(k)) continue;
              seen.add(k);
              if (keep(l)) emit(l);
            }
            if (seen.size > 5000) { const arr = [...seen].slice(-2000); seen.clear(); arr.forEach((k) => seen.add(k)); }
          } catch (err) {
            if (controller.signal.aborted) break;
            if (!lost) warn(`Panel injoignable (${err.message}) — nouvelle tentative toutes les 3 s…`);
            lost = true;
          }
        }
      } finally {
        process.off('SIGINT', onSigint);
        rt.abort = null;
      }
      info(c.gray('Suivi arrêté.'));
    });

  const system = program.command('system').description('Administration globale du bot (propriétaire)');
  system.command('guilds').description('Tous les serveurs où le bot est présent').action(async () => {
    const res = await rt.api().get('/system/guilds');
    rt.output(res, () => {
      print(table(res.guilds, [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Nom' }, { key: 'memberCount', label: 'Membres', align: 'right' }, { key: 'ownerId', label: 'Propriétaire' }], { empty: 'Le bot n\'est présent sur aucun serveur (ou n\'est pas connecté).' }));
      info(c.gray(`\n${res.guilds.length} serveur(s), ${res.guilds.reduce((a, g) => a + (g.memberCount || 0), 0)} membres au total.`));
    });
  });
  system.command('leave <guildId>').description('Faire quitter un serveur au bot').action(async (guildId) => {
    if (!/^\d+$/.test(guildId)) throw usageError('ID de serveur numérique attendu');
    if (!(await rt.confirm(`Le bot va QUITTER le serveur ${guildId}. Continuer ?`))) return;
    const res = await rt.api().post(`/system/leave/${guildId}`);
    rt.output(res, () => success(`Le bot a quitté le serveur ${guildId}`));
  });

  program.command('deploy-commands').description('(Re)déployer les commandes slash (serveur de dev, ou --global)')
    .option('--global', 'Déploiement global (propagation jusqu\'à 1 h côté Discord)')
    .action(async (o) => {
      const res = await rt.api().post('/system/deploy-commands', { global: !!o.global }, { timeoutMs: 180000 });
      rt.output(res, () => {
        success(res.deployed === false ? 'Commandes inchangées : aucun déploiement nécessaire' : `Commandes slash déployées${o.global ? ' globalement' : ' (serveur de développement)'}`);
        const rest = Object.fromEntries(Object.entries(res).filter(([k]) => k !== 'ok'));
        if (Object.keys(rest).length) print(kv(rest));
      });
    });

  program.command('restart').description('Redémarrer le bot (le gestionnaire de processus doit le relancer)').action(async () => {
    if (!(await rt.confirm('Redémarrer le bot ?'))) return;
    const res = await rt.api().post('/system/restart');
    rt.output(res, () => {
      success(res.message || 'Redémarrage demandé');
      info(c.gray('Suivez le retour en ligne avec : heiphais status  (ou heiphais logs -f)'));
    });
  });

  program.command('presence').description('Changer le statut / l\'activité du bot')
    .option('--status <statut>', 'online, idle, dnd, invisible', 'online')
    .option('--activity <texte>', 'Texte de l\'activité (vide = aucune)')
    .option('--type <type>', `Type d'activité : ${ACTIVITY_TYPES.join(', ')}`, 'Playing')
    .action(async (o) => {
      const status = String(o.status).toLowerCase();
      if (!['online', 'idle', 'dnd', 'invisible'].includes(status)) throw usageError(`Statut invalide : ${o.status}`, 'Valeurs : online, idle, dnd, invisible');
      const type = ACTIVITY_TYPES.find((t) => t.toLowerCase() === String(o.type).toLowerCase());
      if (!type) throw usageError(`Type d'activité invalide : ${o.type}`, `Valeurs : ${ACTIVITY_TYPES.join(', ')}`);
      const res = await rt.api().post('/system/presence', { status, activity: o.activity || null, type });
      rt.output(res, () => success(`Présence : ${status}${o.activity ? ` — ${type} ${o.activity}` : ''}`));
    });
}
