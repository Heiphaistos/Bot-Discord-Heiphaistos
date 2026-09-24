/**
 * Bibliothèque de règles prêtes à l'emploi.
 * Espaces réservés remplacés par `automation template use` : $CHANNEL, $ROLE, $TEXT, $SCHEDULE.
 */
export const TEMPLATES = {
  welcome_dm_delayed: {
    label: 'MP de bienvenue 10 min après l\'arrivée', needs: [], text: 'Salut {user.name} ! Ça fait 10 minutes que tu es sur **{guild.name}** : n\'hésite pas à te présenter et à lire le règlement. 😊',
    rule: { trigger: { type: 'memberJoin' }, conditions: [], actions: [{ type: 'wait', duration: '10m' }, { type: 'sendDM', content: '$TEXT' }] },
  },
  role_after_24h: {
    label: 'Rôle après 24 h de présence', needs: ['role'],
    rule: { trigger: { type: 'memberJoin' }, conditions: [], actions: [{ type: 'wait', duration: '24h' }, { type: 'addRole', role: '$ROLE' }] },
  },
  weekly_reminder: {
    label: 'Rappel hebdomadaire (vendredi 18 h)', needs: ['channel'], schedule: '0 18 * * 5', text: '📌 Rappel de la semaine : pensez à consulter les annonces et les évènements du week-end !',
    rule: { trigger: { type: 'schedule', schedule: '$SCHEDULE' }, conditions: [], actions: [{ type: 'sendMessage', channel: '$CHANNEL', content: '$TEXT' }] },
  },
  auto_purge: {
    label: 'Purge automatique quotidienne d\'un salon (4 h)', needs: ['channel'], schedule: '0 4 * * *',
    rule: { trigger: { type: 'schedule', schedule: '$SCHEDULE' }, conditions: [], actions: [{ type: 'runAction', module: 'moderation', action: 'purge', params: { channel: '$CHANNEL', count: 200 } }] },
  },
  announce_react: {
    label: 'Réaction automatique sur un salon d\'annonces', needs: ['channel'],
    rule: { trigger: { type: 'message', channel: '$CHANNEL', ignoreBots: false }, conditions: [], actions: [{ type: 'react', emoji: '👍' }, { type: 'react', emoji: '🎉' }] },
  },
  staff_ping_keyword: {
    label: 'Ping du staff sur mot-clé (aide, urgent…)', needs: ['channel', 'role'],
    rule: { trigger: { type: 'message', contains: ['urgent', 'besoin d\'aide', 'help me', 'modo'], wholeWord: true }, conditions: [], cooldownMs: 300000, actions: [{ type: 'sendMessage', channel: '$CHANNEL', content: '<@&$ROLE> {user.mention} a besoin d\'aide dans {channel.mention} ({trigger.keyword}) :\n> {message.content}\n{message.url}' }] },
  },
  night_close: {
    label: 'Fermeture d\'un salon la nuit (23 h)', needs: ['channel'], schedule: '0 23 * * *',
    rule: { trigger: { type: 'schedule', schedule: '$SCHEDULE' }, conditions: [], actions: [{ type: 'runAction', module: 'moderation', action: 'lock', params: { channel: '$CHANNEL', reason: 'Fermeture nocturne automatique' } }] },
  },
  morning_open: {
    label: 'Réouverture d\'un salon le matin (8 h)', needs: ['channel'], schedule: '0 8 * * *',
    rule: { trigger: { type: 'schedule', schedule: '$SCHEDULE' }, conditions: [], actions: [{ type: 'runAction', module: 'moderation', action: 'unlock', params: { channel: '$CHANNEL', reason: 'Réouverture automatique' } }] },
  },
  monday_message: {
    label: 'Message du lundi matin (9 h)', needs: ['channel'], schedule: '0 9 * * 1', text: '☀️ Bon lundi à tous ! Quels sont vos objectifs de la semaine ?',
    rule: { trigger: { type: 'schedule', schedule: '$SCHEDULE' }, conditions: [], actions: [{ type: 'sendMessage', channel: '$CHANNEL', content: '$TEXT' }] },
  },
  weekly_backup: {
    label: 'Sauvegarde hebdomadaire du serveur (dimanche 3 h)', needs: [], schedule: '0 3 * * 0',
    rule: { trigger: { type: 'schedule', schedule: '$SCHEDULE' }, conditions: [], actions: [{ type: 'runAction', module: 'backup', action: 'backup_create', params: {} }, { type: 'log', message: '💾 Sauvegarde hebdomadaire : {local.lastResult}' }] },
  },
  daily_db_backup: {
    label: 'Sauvegarde quotidienne de la base (propriétaire, 2 h)', needs: [], schedule: '0 2 * * *',
    rule: { trigger: { type: 'schedule', schedule: '$SCHEDULE' }, conditions: [], actions: [{ type: 'runAction', module: 'sysadmin', action: 'dbbackup_now', params: {} }, { type: 'log', message: '🗄️ Sauvegarde de la base : {local.lastResult}' }] },
  },
  leave_log: {
    label: 'Journal des départs', needs: ['channel'],
    rule: { trigger: { type: 'memberLeave' }, conditions: [], actions: [{ type: 'log', channel: '$CHANNEL', message: '👋 **{user.tag}** ({user.id}) a quitté le serveur. Membres : {guild.memberCount}' }] },
  },
  level_up_congrats: {
    label: 'Félicitations de passage de niveau', needs: ['channel'],
    rule: { trigger: { type: 'busEvent', event: 'levelUp' }, conditions: [], actions: [{ type: 'sendMessage', channel: '$CHANNEL', content: '🎉 GG {user.mention}, tu passes au niveau **{trigger.level}** !' }] },
  },
  voice_log: {
    label: 'Journal des connexions vocales', needs: ['channel'],
    rule: { trigger: { type: 'voiceJoin' }, conditions: [], actions: [{ type: 'log', channel: '$CHANNEL', message: '🔊 {user.mention} a rejoint <#{trigger.channelId}>' }] },
  },
  auto_thread: {
    label: 'Fil automatique pour chaque message d\'un salon', needs: ['channel'],
    rule: { trigger: { type: 'message', channel: '$CHANNEL' }, conditions: [], actions: [{ type: 'createThread', name: 'Discussion — {user.name}', autoArchive: 1440 }] },
  },
  new_account_alert: {
    label: 'Alerte compte récent (< 7 jours)', needs: ['channel'],
    rule: { trigger: { type: 'memberJoin' }, conditions: [{ type: 'accountAge', max: '7d' }], actions: [{ type: 'log', channel: '$CHANNEL', message: '⚠️ Compte récent : {user.mention} ({user.tag}) créé le {user.createdAt}' }] },
  },
  join_counter: {
    label: 'Compteur d\'arrivées (variable joins_total)', needs: [],
    rule: { trigger: { type: 'memberJoin' }, conditions: [], actions: [{ type: 'incrementVariable', name: 'joins_total', by: 1 }] },
  },
};

export const TEMPLATE_CHOICES = Object.entries(TEMPLATES).map(([value, t]) => ({ name: t.label.slice(0, 100), value }));

/** Instancie un modèle en remplaçant les espaces réservés. */
export function instantiateTemplate(name, { channel = null, role = null, text = null, schedule = null } = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) return null;
  const replacements = { $CHANNEL: channel || '', $ROLE: role || '', $TEXT: text || tpl.text || '', $SCHEDULE: schedule || tpl.schedule || '' };
  const walk = (v) => {
    if (typeof v === 'string') return v.replace(/\$(CHANNEL|ROLE|TEXT|SCHEDULE)/g, (m) => replacements[m]);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const rule = walk(structuredClone(tpl.rule));
  return { name: tpl.label, ...rule };
}
