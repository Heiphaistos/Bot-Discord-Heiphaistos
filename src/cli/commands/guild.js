/**
 * Commandes par serveur : journal d'audit, tâches planifiées, export/import de configuration, préfixe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { c, table, print, printJson, success, info, formatDuration } from '../lib/output.js';
import { usageError } from '../lib/errors.js';

export function registerGuildCommands(program, rt) {
  program.command('audit').description('Journal d\'audit du serveur (actions exécutées via Discord, panel, CLI)')
    .option('--limit <n>', 'Nombre d\'entrées (≤ 500)', '30')
    .option('--offset <n>', 'Décalage (pagination)')
    .option('--module <nom>', 'Filtrer par module')
    .option('--actor <id>', 'Filtrer par ID de l\'auteur')
    .action(async (o) => {
      const gid = await rt.guild();
      const res = await rt.api().get(`/guilds/${gid}/audit`, { query: { limit: o.limit, offset: o.offset, module: o.module, actor: o.actor } });
      rt.output(res, () => print(table(res.entries, [
        { key: 'id', label: 'ID', align: 'right' },
        { key: 'created_at', label: 'Date' },
        { key: 'actor_tag', label: 'Auteur', get: (e) => e.actor_tag || e.actor_id },
        { key: 'source', label: 'Source' },
        { key: 'action', label: 'Action', get: (e) => `${e.module}.${e.action}` },
        { key: 'ok', label: 'OK', format: (v) => (v ? c.green('✔') : c.red('✖')) },
        { key: 'params', label: 'Paramètres', format: (v) => (v && Object.keys(v).length ? JSON.stringify(v) : c.gray('-')) },
      ], { empty: 'Journal vide.' })));
    });

  program.command('jobs').description('Tâches planifiées du serveur (rappels, fins de ban, concours…)').action(async () => {
    const gid = await rt.guild();
    const res = await rt.api().get(`/guilds/${gid}/jobs`);
    rt.output(res, () => print(table(res.jobs, [
      { key: 'id', label: 'ID', align: 'right' },
      { key: 'module', label: 'Module' },
      { key: 'type', label: 'Type' },
      { key: 'run_at', label: 'Exécution', format: (v) => `${new Date(v).toLocaleString('fr-FR')} ${c.gray(v > Date.now() ? `(dans ${formatDuration(v - Date.now())})` : '(en retard)')}` },
      { key: 'repeat_ms', label: 'Répétition', format: (v) => (v ? `toutes les ${formatDuration(v)}` : c.gray('-')) },
      { key: 'payload', label: 'Données', format: (v) => (typeof v === 'string' ? v : JSON.stringify(v)) },
    ], { empty: 'Aucune tâche planifiée.' })));
  });

  const job = program.command('job').description('Gestion d\'une tâche planifiée');
  job.command('cancel <id>').description('Annuler une tâche planifiée').action(async (id) => {
    if (!/^\d+$/.test(id)) throw usageError('L\'ID de tâche doit être numérique (voir heiphais jobs)');
    const gid = await rt.guild();
    if (!(await rt.confirm(`Annuler la tâche n°${id} ?`))) return;
    const res = await rt.api().delete(`/guilds/${gid}/jobs/${id}`);
    rt.output(res, () => (res.ok ? success(`Tâche n°${id} annulée`) : info(`La tâche n°${id} n'a pas pu être annulée (déjà exécutée ?)`)));
  });

  program.command('export').description('Exporter la configuration du serveur (modules + réglages) en JSON')
    .option('-o, --out <fichier>', 'Écrire dans un fichier (sinon sortie standard)')
    .action(async (o) => {
      const gid = await rt.guild();
      const res = await rt.api().get(`/guilds/${gid}/export`);
      if (!o.out) return printJson(res.export);
      const file = path.resolve(o.out);
      fs.writeFileSync(file, `${JSON.stringify(res.export, null, 2)}\n`);
      rt.output({ ok: true, file }, () => success(`Configuration exportée : ${file} (${Object.keys(res.export.settings || {}).length} module(s) configuré(s))`));
    });

  program.command('import <fichier>').description('Importer une configuration exportée (écrase les réglages concernés)').action(async (file) => {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw usageError(`Lecture de ${file} impossible : ${err.message}`); }
    const payload = data?.export && typeof data.export === 'object' ? data.export : data;
    if (!payload || typeof payload !== 'object' || (!payload.settings && !payload.modules)) throw usageError(`${file} ne ressemble pas à un export HeiphaisBot (clés « modules » / « settings » attendues)`);
    const gid = await rt.guild();
    if (payload.guildId && payload.guildId !== gid) info(c.yellow(`Export provenant du serveur ${payload.guildId}, importé sur ${gid}.`));
    if (!(await rt.confirm(`Importer ${file} sur le serveur ${gid} (réglages existants écrasés) ?`))) return;
    const res = await rt.api().post(`/guilds/${gid}/import`, { export: payload });
    rt.output(res, () => success(`Configuration importée sur le serveur ${gid}`));
  });

  program.command('prefix [nouveau]').description('Afficher ou changer le préfixe des commandes texte').action(async (nouveau) => {
    const gid = await rt.guild();
    if (nouveau === undefined) {
      const res = await rt.api().get(`/guilds/${gid}/prefix`);
      return rt.output(res, () => print(res.prefix));
    }
    if (String(nouveau).length > 5) throw usageError('Le préfixe fait au plus 5 caractères');
    const res = await rt.api().put(`/guilds/${gid}/prefix`, { prefix: nouveau });
    rt.output(res, () => success(`Préfixe : ${c.bold(res.prefix)}`));
  });
}
