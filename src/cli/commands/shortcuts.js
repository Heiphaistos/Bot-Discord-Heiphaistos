/**
 * Raccourcis ergonomiques (appellent tous rt.runAction) :
 * modération, messages, rôles, cas, et groupes génériques par module (backup, ticket, music, docker…).
 */
import { c, print, table, info } from '../lib/output.js';
import { usageError } from '../lib/errors.js';
import { optionTokensToAssignments, paramsSummary } from '../lib/params.js';
import { readParamsFile } from './modules.js';

const text = (words) => (Array.isArray(words) && words.length ? words.join(' ') : undefined);

/**
 * Groupes génériques : « heiphais <nom> <sous-commande> [args] » → action du module.
 * slashGroup : préfixe essayé en premier (docker ps → /docker ps ou docker_ps).
 */
export const GROUPS = [
  { name: 'backup', module: 'backup', slashGroup: 'backup', description: 'Sauvegardes du serveur (module backup)', subs: ['create', 'list', 'restore <id>', 'delete <id>'] },
  { name: 'ticket', module: 'tickets', slashGroup: 'ticket', description: 'Tickets de support (module tickets)', subs: ['list', 'close <id>'] },
  { name: 'giveaway', module: 'giveaways', slashGroup: 'giveaway', description: 'Concours (module giveaways)', subs: ['start prize=… duration=1d winners=1 channel=<id>', 'list', 'end <id>', 'reroll <id>'] },
  { name: 'announce', module: 'announcements', slashGroup: 'announce', defaultAction: 'send', description: 'Annonces (module announcements ; sans sous-commande → announcements.send)', subs: ['channel=<id> message="…"', 'send …'] },
  { name: 'music', module: 'music', slashGroup: 'music', description: 'Musique (module music)', subs: ['play <recherche|url>', 'skip', 'stop', 'queue', 'pause', 'resume', 'volume <n>'] },
  { name: 'hooks', module: 'integrations', slashGroup: 'hooks', description: 'Webhooks sortants (module integrations, /hooks …)', subs: [] },
  { name: 'integration', module: 'integrations', slashGroup: 'integration', description: 'Intégrations ForgeHook/ForgeArchive (module integrations)', subs: [] },
  { name: 'sys', module: 'sysadmin', slashGroup: 'sys', description: 'Administration système du VPS (module sysadmin, /sys …)', subs: [] },
  { name: 'docker', module: 'sysadmin', slashGroup: 'docker', description: 'Conteneurs Docker (module sysadmin, /docker …)', subs: ['ps', 'logs <conteneur>', 'restart <conteneur>'] },
  { name: 'proxmox', module: 'sysadmin', slashGroup: 'proxmox', description: 'Proxmox (module sysadmin, /proxmox …)', subs: [] },
  { name: 'net', module: 'network', slashGroup: 'net', description: 'Outils réseau (module network, /net …)', subs: ['ping <hôte>', 'dns <domaine>', 'whois <domaine>'] },
];

export function registerShortcutCommands(program, rt) {
  const run = (module, action, params, extra = {}) => rt.runAction({ module, action, params, ...extra });

  // ---- Modération ----
  program.command('ban <user> [raison...]').description('Bannir un membre (moderation.ban)')
    .option('--duration <durée>', 'Ban temporaire (ex : 7d, 12h)')
    .option('--delete-days <n>', 'Jours de messages à supprimer (0-7)')
    .action((user, raison, o) => run('moderation', 'ban', { user, reason: text(raison), duration: o.duration, delete_days: o.deleteDays }));
  program.command('unban <user> [raison...]').description('Débannir un utilisateur (moderation.unban)')
    .action((user, raison) => run('moderation', 'unban', { user, reason: text(raison) }));
  program.command('kick <user> [raison...]').description('Expulser un membre (moderation.kick)')
    .action((user, raison) => run('moderation', 'kick', { user, reason: text(raison) }));
  program.command('timeout <user> <durée> [raison...]').description('Timeout (mute) d\'un membre, ex : 10m, 2h, 1d (moderation.timeout)')
    .action((user, duration, raison) => run('moderation', 'timeout', { user, duration, reason: text(raison) }));
  program.command('untimeout <user> [raison...]').description('Lever un timeout (moderation.untimeout)')
    .action((user, raison) => run('moderation', 'untimeout', { user, reason: text(raison) }));
  program.command('warn <user> <raison...>').description('Avertir un membre (moderation.warn_add)')
    .action((user, raison) => run('moderation', 'warn_add', { user, reason: text(raison) }));
  program.command('warns <user>').description('Avertissements d\'un membre (moderation.warn_list)')
    .action((user) => run('moderation', 'warn_list', { user }));
  program.command('unwarn <cas> [raison...]').description('Retirer un avertissement par numéro de cas (moderation.warn_remove)')
    .action((cas, raison) => run('moderation', 'warn_remove', { case_number: cas, reason: text(raison) }));
  program.command('purge <count>').description('Supprimer des messages en masse (moderation.purge)')
    .option('--channel <id>', 'Salon (requis hors Discord)')
    .option('--user <id>', 'Seulement ce membre')
    .option('--contains <texte>', 'Seulement les messages contenant ce texte')
    .option('--bots', 'Seulement les bots')
    .option('--attachments', 'Seulement avec pièces jointes')
    .action((count, o) => run('moderation', 'purge', { count, user: o.user, contains: o.contains, bots: o.bots, attachments: o.attachments }, { channel: o.channel }));
  for (const [name, desc] of [['lock', 'Verrouiller un salon'], ['unlock', 'Déverrouiller un salon']]) {
    program.command(name).description(`${desc} (moderation.${name})`)
      .option('--channel <id>', 'Salon (requis hors Discord)')
      .option('--reason <texte>', 'Raison')
      .action((o) => run('moderation', name, { reason: o.reason }, { channel: o.channel }));
  }
  program.command('slowmode <secondes>').description('Mode lent d\'un salon, 0 = désactivé (moderation.slowmode)')
    .option('--channel <id>', 'Salon (requis hors Discord)')
    .action((seconds, o) => run('moderation', 'slowmode', { seconds }, { channel: o.channel }));
  program.command('case <numero>').description('Voir un cas de modération (moderation.case_view)')
    .action((n) => run('moderation', 'case_view', { case_number: n }));
  program.command('cases').description('Lister les cas de modération (moderation.case_list)')
    .option('--user <id>', 'Filtrer par membre')
    .option('--type <type>', 'Filtrer par type (ban, kick, warn…)')
    .option('--limit <n>', 'Nombre (1-25)')
    .action((o) => run('moderation', 'case_list', { user: o.user, type: o.type, limit: o.limit }));

  const role = program.command('role').description('Ajouter / retirer un rôle à un membre');
  for (const mode of ['add', 'remove']) {
    role.command(`${mode} <user> <role> [raison...]`).description(`${mode === 'add' ? 'Ajouter' : 'Retirer'} un rôle (moderation.role_${mode})`)
      .action((user, r, raison) => run('moderation', `role_${mode}`, { user, role: r, reason: text(raison) }));
  }

  // ---- Messages (module admin) ----
  program.command('say <channel> <message...>').description('Faire parler le bot dans un salon (admin.say)')
    .action((channel, message) => run('admin', 'say', { channel, message: text(message) }));
  program.command('dm <user> <message...>').description('Envoyer un message privé via le bot (admin.dm)')
    .action((user, message) => run('admin', 'dm', { user, message: text(message) }));
  program.command('embed').description('Envoyer (ou modifier) un embed personnalisé (admin.embed)')
    .requiredOption('--channel <id>', 'Salon cible')
    .option('--title <texte>', 'Titre')
    .option('--description <texte>', 'Description (markdown ; \\n pour un saut de ligne)')
    .option('--color <couleur>', 'Couleur (#hex ou nom : rouge, vert, bleu…)')
    .option('--image <url>', 'Image')
    .option('--thumbnail <url>', 'Miniature')
    .option('--footer <texte>', 'Pied de page')
    .option('--author <texte>', 'Auteur')
    .option('--content <texte>', 'Texte au-dessus de l\'embed')
    .option('--fields <json>', 'Champs JSON : [{"name":"…","value":"…","inline":true}]')
    .option('--timestamp', 'Ajouter l\'horodatage')
    .option('--message-id <id>', 'Modifier ce message du bot au lieu d\'en envoyer un nouveau')
    .action((o) => run('admin', 'embed', {
      channel: o.channel, title: o.title, description: o.description?.replace(/\\n/g, '\n'), color: o.color, image: o.image, thumbnail: o.thumbnail,
      footer: o.footer, author: o.author, content: o.content, fields: o.fields, timestamp: o.timestamp, message_id: o.messageId,
    }));

  // ---- Groupes génériques ----
  for (const g of GROUPS) registerGroup(program, rt, g);
}

function registerGroup(program, rt, g) {
  const cmd = program.command(`${g.name} [args...]`)
    .description(g.description)
    .option('--channel <id>', 'Salon d\'origine / paramètre channel')
    .option('-f, --file <params.json>', 'Paramètres depuis un fichier JSON')
    .option('--dry-run', 'Afficher la requête sans l\'envoyer')
    .allowUnknownOption()
    .action(async (args, o) => {
      const tokens = optionTokensToAssignments(args);
      if (!tokens.length && !g.defaultAction) return listGroupActions(rt, g);
      await rt.runAction({ module: g.module, slashGroup: g.slashGroup, defaultAction: g.defaultAction, tokens, channel: o.channel, fileParams: o.file ? readParamsFile(o.file) : {}, dryRun: o.dryRun });
    });
  cmd.addHelpText('after', `
Sous-commandes${g.subs.length ? ' courantes' : ''} : ${g.subs.length ? `\n${g.subs.map((s) => `  heiphais ${g.name} ${s}`).join('\n')}` : `voir « heiphais ${g.name} » (liste depuis l'API).`}
Toute action du module ${g.module} est accessible : heiphais ${g.name} <action> [clé=valeur…]
(équivaut à heiphais run ${g.module} <action> …). Sans argument : liste des actions disponibles.`);
}

async function listGroupActions(rt, g) {
  const cat = await rt.catalog();
  const mod = await rt.findModule(g.module);
  let list = cat.actions.filter((a) => a.module === mod.name && !a.hidden);
  const inGroup = list.filter((a) => a.slash?.startsWith(`/${g.slashGroup} `));
  if (inGroup.length) list = inGroup;
  if (rt.json) return print(JSON.stringify({ ok: true, actions: list }, null, 2));
  print(table(list, [
    { key: 'name', label: 'Action' },
    { key: 'cli', label: 'Commande', get: (a) => `heiphais ${g.name} ${a.slash?.startsWith(`/${g.slashGroup} `) ? a.slash.slice(g.slashGroup.length + 2) : a.name}` },
    { key: 'params', label: 'Paramètres (* requis)', get: (a) => paramsSummary(a) },
    { key: 'description', label: 'Description' },
  ], { empty: `Le module ${g.module} n'expose aucune action.` }));
  info(c.gray(`\nDétail : heiphais action ${g.module} <action>`));
}

export { usageError };
