/**
 * Commandes d'information : état du bot, identité, serveurs, salons, rôles, membres, emojis.
 */
import { c, rgb, kv, table, print, heading, formatDuration, formatBytes, formatDate, yesNo } from '../lib/output.js';
import { usageError } from '../lib/errors.js';

const CHANNEL_TYPE_ALIASES = {
  text: ['GuildText'], texte: ['GuildText'], voice: ['GuildVoice'], vocal: ['GuildVoice'], category: ['GuildCategory'], categorie: ['GuildCategory'], catégorie: ['GuildCategory'],
  announcement: ['GuildAnnouncement'], news: ['GuildAnnouncement'], annonce: ['GuildAnnouncement'], stage: ['GuildStageVoice'], forum: ['GuildForum'], media: ['GuildMedia'],
  thread: ['PublicThread', 'PrivateThread', 'AnnouncementThread'], fil: ['PublicThread', 'PrivateThread', 'AnnouncementThread'],
};
const TYPE_LABELS = { GuildText: 'texte', GuildVoice: 'vocal', GuildCategory: 'catégorie', GuildAnnouncement: 'annonces', GuildStageVoice: 'stage', GuildForum: 'forum', GuildMedia: 'média', PublicThread: 'fil', PrivateThread: 'fil privé', AnnouncementThread: 'fil d\'annonce', GuildDirectory: 'répertoire' };

export function registerInfoCommands(program, rt) {
  program.command('status').description('État du bot (connexion, ping, ressources, compteurs)').action(async () => {
    const s = await rt.api().get('/status');
    rt.output(s, () => print(kv([
      ['Bot', s.bot ? `${c.bold(s.bot.tag)} ${c.gray(s.bot.id)}` : c.red('non connecté à Discord')],
      ['Prêt', s.ready ? c.green('oui') : c.red('non')],
      ['Ping', typeof s.ping === 'number' && s.ping >= 0 ? `${s.ping} ms` : c.gray('-')],
      ['En ligne depuis', formatDuration(s.uptime)],
      ['Serveurs', String(s.guilds)],
      ['Utilisateurs', String(s.users)],
      ['Salons', String(s.channels)],
      ['Version', `${s.version} ${c.gray(`(Node ${s.node})`)}`],
      ['Système', s.platform],
      ['Mémoire', `${formatBytes(s.memory?.rss)} RSS · ${formatBytes(s.memory?.heapUsed)} heap`],
      ['Charge CPU', (s.cpuLoad || []).map((x) => x.toFixed(2)).join(' / ')],
      ['Modules', `${s.modules} · ${s.commands} commandes slash · ${s.actions} actions`],
      ['Tâches planifiées', String(s.scheduledJobs)],
      ['Intégrations', Object.entries(s.integrations || {}).map(([k, v]) => `${k} ${v ? c.green('✔') : c.gray('✗')}`).join('  ')],
    ])));
  });

  program.command('me').description('Identité associée au jeton, droits et serveurs accessibles').action(async () => {
    const me = await rt.api().get('/me');
    rt.output(me, () => {
      print(kv([
        ['Utilisateur', `${c.bold(me.user?.username || '?')} ${c.gray(me.user?.id || '')}`],
        ['Propriétaire', yesNo(me.isOwner)],
        ['Authentification', me.source === 'cli' ? 'jeton API' : me.source],
        ['Bot', me.botUser ? `${me.botUser.tag} ${c.gray(me.botUser.id)}` : c.red('non connecté')],
        ['Version', `${me.config?.botName || 'HeiphaisBot'} ${me.config?.version || ''}`],
        ['Invitation', me.config?.inviteUrl || c.gray('-')],
        ['Serveurs accessibles', String(me.guilds?.length || 0)],
      ]));
      if (me.guilds?.length) print(`\n${table(me.guilds, [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Nom' }, { key: 'memberCount', label: 'Membres', align: 'right' }])}`);
    });
  });

  program.command('guilds').description('Serveurs accessibles avec ce jeton').action(async () => {
    const res = await rt.api().get('/guilds');
    const def = rt.config().guild;
    rt.output(res, () => print(table(res.guilds, [
      { key: 'id', label: 'ID', format: (v) => (v === def ? `${v} ${c.green('*')}` : v) },
      { key: 'name', label: 'Nom' },
      { key: 'memberCount', label: 'Membres', align: 'right' },
      { key: 'ownerId', label: 'Propriétaire' },
    ], { empty: 'Aucun serveur accessible (le bot est-il connecté ? heiphais status)' })));
  });

  program.command('guild [id]').description('Résumé d\'un serveur (compteurs, propriétaire, préfixe, permissions du bot)').action(async (id) => {
    const gid = await rt.guild(id);
    const { guild: g } = await rt.api().get(`/guilds/${gid}/`);
    rt.output({ ok: true, guild: g }, () => {
      const n = g.counts || {};
      print(heading(`${g.name} (${g.id})`));
      print(kv([
        ['Propriétaire', g.owner ? `${g.owner.tag} ${c.gray(g.owner.id)}` : g.ownerId],
        ['Membres', `${g.memberCount}${n.online !== undefined ? ` · ${n.online} en ligne` : ''}${n.bots !== undefined ? ` · ${n.bots} bots (en cache)` : ''}`],
        ['Salons', `${n.channels} (${n.text} texte, ${n.voice} vocaux)`],
        ['Rôles', String(n.roles)],
        ['Emojis', String(n.emojis)],
        ['Boosts', `${g.boosts ?? 0} (niveau ${g.tier ?? 0})`],
        ['Vérification', String(g.verificationLevel)],
        ['Langue', g.locale],
        ['Créé le', formatDate(g.createdAt)],
        ['Bot arrivé le', formatDate(g.joinedAt)],
        ['Préfixe', g.prefix],
        ['Description', g.description || c.gray('-')],
        ['Permissions du bot', g.botPermissions?.includes('Administrator') ? c.green('Administrator') : `${g.botPermissions?.length || 0} permission(s)`],
      ]));
      info2(`Détails : heiphais channels ${g.id} · heiphais roles ${g.id} · heiphais modules --guild ${g.id}`);
    });
  });

  program.command('channels [id]').description('Salons d\'un serveur (arborescence par catégorie)')
    .option('--type <type>', 'Filtrer : text, voice, category, announcement, forum, stage, thread')
    .action(async (id, o) => {
      const gid = await rt.guild(id);
      const res = await rt.api().get(`/guilds/${gid}/channels`);
      let channels = res.channels || [];
      if (o.type) {
        const key = String(o.type).toLowerCase();
        const types = CHANNEL_TYPE_ALIASES[key] || Object.keys(TYPE_LABELS).filter((t) => t.toLowerCase().includes(key));
        if (!types.length) throw usageError(`Type de salon inconnu : ${o.type}`, `Types : ${Object.keys(CHANNEL_TYPE_ALIASES).join(', ')}`);
        channels = channels.filter((ch) => types.includes(ch.type));
      }
      rt.output({ ok: true, channels }, () => {
        const byId = new Map((res.channels || []).map((ch) => [ch.id, ch]));
        let rows = channels;
        if (!o.type) {
          // Arborescence : salons sans catégorie, puis chaque catégorie suivie de ses salons.
          const cats = channels.filter((ch) => ch.type === 'GuildCategory');
          const orphans = channels.filter((ch) => ch.type !== 'GuildCategory' && !byId.has(ch.parentId));
          rows = [...orphans];
          for (const cat of cats) rows.push(cat, ...channels.filter((ch) => ch.parentId === cat.id));
          rows.push(...channels.filter((ch) => !rows.includes(ch)));
        }
        print(table(rows, [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'Nom', format: (v, r) => (r.type === 'GuildCategory' ? c.bold(String(v).toUpperCase()) : `${r.parentId && !o.type ? '  ' : ''}${['GuildText', 'GuildAnnouncement', 'GuildForum'].includes(r.type) ? '#' : ''}${v}`) },
          { key: 'type', label: 'Type', format: (v) => TYPE_LABELS[v] || v },
          { key: 'parentId', label: 'Catégorie', format: (v) => (v ? byId.get(v)?.name || v : c.gray('-')) },
          { key: 'nsfw', label: 'NSFW', format: (v) => (v ? c.red('oui') : '') },
        ], { empty: 'Aucun salon.' }));
      });
    });

  program.command('roles [id]').description('Rôles d\'un serveur (du plus haut au plus bas)').action(async (id) => {
    const gid = await rt.guild(id);
    const res = await rt.api().get(`/guilds/${gid}/roles`);
    rt.output(res, () => print(table(res.roles, [
      { key: 'id', label: 'ID' },
      { key: 'name', label: 'Nom', format: (v, r) => `${r.color && r.color !== '#000000' ? rgb(r.color, '●') : c.gray('○')} ${v}` },
      { key: 'color', label: 'Couleur' },
      { key: 'position', label: 'Pos.', align: 'right' },
      { key: 'members', label: 'Membres', align: 'right' },
      { key: 'permissions', label: 'Permissions', format: (v) => (v?.includes('Administrator') ? c.red('Administrator') : `${v?.length || 0}`) },
      { key: 'managed', label: 'Géré', format: (v) => (v ? 'bot/intégration' : '') },
      { key: 'hoist', label: 'Séparé', format: (v) => (v ? 'oui' : '') },
    ])));
  });

  program.command('members [id]').description('Membres d\'un serveur (cache ou recherche)')
    .option('-s, --search <texte>', 'Rechercher par nom')
    .option('--limit <n>', 'Nombre maximum (≤ 100)', '25')
    .action(async (id, o) => {
      const gid = await rt.guild(id);
      const res = await rt.api().get(`/guilds/${gid}/members`, { query: { q: o.search, limit: o.limit } });
      rt.output(res, () => print(table(res.members, [
        { key: 'id', label: 'ID' },
        { key: 'username', label: 'Utilisateur' },
        { key: 'displayName', label: 'Affiché' },
        { key: 'bot', label: 'Bot', format: (v) => (v ? c.magenta('bot') : '') },
        { key: 'joinedAt', label: 'Arrivé le' },
        { key: 'roles', label: 'Rôles', align: 'right', format: (v) => String(v?.length || 0) },
      ], { empty: o.search ? `Aucun membre ne correspond à « ${o.search} ».` : 'Aucun membre en cache.' })));
    });

  program.command('member <userId>').description('Détails d\'un membre (rôles, permissions, timeout)').action(async (userId) => {
    const gid = await rt.guild();
    const api = rt.api();
    const { member: m } = await api.get(`/guilds/${gid}/members/${encodeURIComponent(userId)}`);
    let roleNames = {};
    if (!rt.json) roleNames = Object.fromEntries(((await api.get(`/guilds/${gid}/roles`).catch(() => ({ roles: [] }))).roles || []).map((r) => [r.id, r.name]));
    rt.output({ ok: true, member: m }, () => print(kv([
      ['Utilisateur', `${c.bold(m.tag)} ${c.gray(m.id)}${m.bot ? ` ${c.magenta('[bot]')}` : ''}`],
      ['Nom affiché', m.displayName],
      ['Surnom', m.nickname || c.gray('-')],
      ['Compte créé le', formatDate(m.createdAt)],
      ['Arrivé le', formatDate(m.joinedAt)],
      ['Booste depuis', m.premiumSince ? formatDate(m.premiumSince) : c.gray('-')],
      ['Timeout jusqu\'au', m.timeoutUntil && m.timeoutUntil > Date.now() ? c.red(formatDate(m.timeoutUntil)) : c.gray('-')],
      ['Rôles', m.roles?.length ? m.roles.map((r) => roleNames[r] || r).join(', ') : c.gray('aucun')],
      ['Permissions', m.permissions?.includes('Administrator') ? c.red('Administrator') : (m.permissions || []).join(', ')],
      ['Avatar', m.avatar],
    ])));
  });

  program.command('emojis [id]').description('Emojis personnalisés d\'un serveur').action(async (id) => {
    const gid = await rt.guild(id);
    const res = await rt.api().get(`/guilds/${gid}/emojis`);
    rt.output(res, () => print(table(res.emojis, [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Nom', format: (v) => `:${v}:` }, { key: 'animated', label: 'Animé' }, { key: 'url', label: 'URL' },
    ], { empty: 'Aucun emoji personnalisé.' })));
  });

  function info2(s) { if (!rt.quiet) print(c.gray(`\n${s}`)); }
}
