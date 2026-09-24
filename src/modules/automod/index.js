import { PermissionsBitField, AutoModerationRuleEventType, AutoModerationRuleTriggerType, AutoModerationActionType, AutoModerationRuleKeywordPresetType } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, COLORS, parseDuration } from '../../core/utils.js';

// ---------------------------------------------------------------------------
// Définition des règles (valeurs par défaut fusionnées avec settings.rules)
// ---------------------------------------------------------------------------
const RULE_DEFS = {
  spam: { label: 'Anti-spam', description: 'X messages en Y secondes', enabled: true, action: 'timeout:10m', keys: { messages: 6, seconds: 5 } },
  duplicate: { label: 'Messages dupliqués', description: 'Même message répété', enabled: true, action: 'delete', keys: { count: 3, seconds: 60 } },
  mentions: { label: 'Mentions massives', description: 'Trop de mentions dans un message', enabled: true, action: 'timeout:10m', keys: { max: 5 } },
  invite: { label: 'Invitations Discord', description: 'Liens d\'invitation vers d\'autres serveurs', enabled: true, action: 'delete', keys: { allowOwn: true } },
  link: { label: 'Liens', description: 'Tout lien hors liste blanche', enabled: false, action: 'delete', keys: {} },
  words: { label: 'Mots interdits', description: 'Liste de mots (jokers * et /regex/)', enabled: true, action: 'warn', keys: {} },
  caps: { label: 'Majuscules', description: 'Pourcentage de majuscules', enabled: true, action: 'delete', keys: { percent: 70, minLength: 12 } },
  emoji: { label: 'Spam d\'emojis', description: 'Trop d\'emojis', enabled: true, action: 'delete', keys: { max: 12 } },
  newline: { label: 'Spam de sauts de ligne', description: 'Trop de lignes', enabled: true, action: 'delete', keys: { max: 20 } },
  zalgo: { label: 'Zalgo', description: 'Texte corrompu (caractères combinants)', enabled: true, action: 'delete', keys: { ratio: 0.2, repost: true } },
  affiliate: { label: 'Liens d\'affiliation', description: 'Nettoyage des paramètres de suivi (tag=, utm_*, aff…)', enabled: true, action: 'delete', keys: { repost: true } },
  files: { label: 'Fichiers dangereux', description: 'Extensions bloquées', enabled: true, action: 'delete', keys: {} },
  phishing: { label: 'Anti-phishing', description: 'Domaines malveillants (liste noire + Safe Browsing)', enabled: true, action: 'timeout:1h', keys: {} },
  nsfw: { label: 'Images NSFW (IA)', description: 'Analyse des images par IA', enabled: false, action: 'delete', keys: { threshold: 0.7 } },
  slowmode: { label: 'Slowmode dynamique', description: 'Ajuste le mode lent selon l\'activité', enabled: false, action: 'none', keys: { permin: 30, step: 5, max: 30 } },
};
const RULE_NAMES = Object.keys(RULE_DEFS);
const SEVERITY = { none: 0, delete: 1, warn: 2, timeout: 3, kick: 4, ban: 5 };
const RULE_PRIORITY = ['phishing', 'files', 'nsfw', 'invite', 'words', 'mentions', 'spam', 'affiliate', 'zalgo', 'duplicate', 'link', 'caps', 'emoji', 'newline'];
const DEFAULT_EXTENSIONS = ['exe', 'bat', 'cmd', 'scr', 'msi', 'vbs', 'vbe', 'js', 'jse', 'ps1', 'psm1', 'jar', 'com', 'pif', 'reg', 'hta', 'cpl', 'msc', 'lnk', 'wsf', 'wsh', 'sh', 'dll', 'apk', 'iso', 'dmg'];
const DEFAULT_WHITELIST = ['discord.com', 'discord.gg', 'discordapp.com', 'tenor.com', 'giphy.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'github.com', 'wikipedia.org', 'twitch.tv', 'spotify.com', 'imgur.com', 'reddit.com'];
const OFFICIAL_DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'discord.gg', 'discord.gift', 'discordapp.net', 'discord.media', 'discordstatus.com', 'discord.dev', 'discord.new', 'dis.gd', 'discord.co'];
const PHISH_SOURCE = 'https://phish.sinking.yachts/v2/all';
const PHISH_REFRESH_MS = 6 * 3600000;

// ---------------------------------------------------------------------------
// État mémoire (fenêtres anti-spam, compteurs de salon, caches)
// ---------------------------------------------------------------------------
const spamBuffer = new Map(); // `${guildId}:${userId}` -> [{ ts, id, hash, channelId }]
const channelRate = new Map(); // channelId -> [ts]
const sanctionCooldown = new Map(); // `${guildId}:${userId}` -> ts
const wordCache = new Map(); // guildId -> { key, compiled }
const inviteCache = new Map(); // code -> { guildId, at }
const urlVerdictCache = new Map(); // url -> { bad, at }
const phishDomains = new Set();
let phishLoaded = false;

export default {
  name: 'automod',
  label: 'Auto-modération',
  description: 'Anti-spam, anti-invite, anti-lien, mots interdits, majuscules, zalgo, liens d\'affiliation, fichiers dangereux, anti-phishing, NSFW par IA, slowmode dynamique et règles AutoMod natives.',
  category: 'security',
  icon: '🤖',
  defaultEnabled: true,
  slashGroups: { automod: 'Auto-modération', 'automod.words': 'Mots interdits', 'automod.whitelist': 'Liste blanche de domaines', 'automod.native': 'Règles AutoMod natives Discord', 'automod.ignore': 'Salons et rôles ignorés' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs', description: 'Où publier les déclenchements', channelTypes: ['GuildText'] },
    rules: { type: 'json', label: 'Configuration des règles', description: 'Objet {"spam":{"enabled":true,"action":"timeout:10m","messages":6,"seconds":5,"ignoredChannels":[],"ignoredRoles":[]},…}. Modifiez-le de préférence via /automod set.', default: {}, group: 'Règles' },
    bannedWords: { type: 'list', label: 'Mots interdits', description: 'Mots, jokers (*insulte*) ou regex (/re+gex/i). Accents et leet normalisés.', itemType: 'string', default: [], group: 'Règles' },
    linkWhitelist: { type: 'list', label: 'Domaines autorisés (anti-lien)', description: 'Domaines (et sous-domaines) autorisés par la règle "link"', itemType: 'string', default: DEFAULT_WHITELIST, group: 'Règles' },
    blockedExtensions: { type: 'list', label: 'Extensions de fichiers bloquées', itemType: 'string', default: DEFAULT_EXTENSIONS, group: 'Règles' },
    affiliateParams: { type: 'list', label: 'Paramètres d\'affiliation supplémentaires', description: 'Noms de paramètres d\'URL à supprimer en plus de la liste intégrée', itemType: 'string', default: [], group: 'Règles' },
    ignoredChannels: { type: 'list', label: 'Salons ignorés (toutes règles)', itemType: 'channel', default: [], group: 'Exceptions' },
    ignoredRoles: { type: 'list', label: 'Rôles ignorés (toutes règles)', itemType: 'role', default: [], group: 'Exceptions' },
    bypassStaff: { type: 'boolean', label: 'Le staff est exempté', description: 'Membres avec la permission "Gérer les messages" ou administrateurs', default: true, group: 'Exceptions' },
    notifyUser: { type: 'boolean', label: 'Prévenir l\'auteur', description: 'Envoie un message temporaire dans le salon', default: true },
    notifyTemplate: { type: 'text', label: 'Modèle du message d\'avertissement', description: 'Variables : {user.mention} {rule} {detail}', default: '{user.mention}, votre message a été supprimé : **{rule}**.' },
    safeBrowsingKey: { type: 'string', label: 'Clé Google Safe Browsing v4', description: 'Ou variable GOOGLE_SAFE_BROWSING_KEY', secret: true, group: 'Services externes' },
    sightengineUser: { type: 'string', label: 'Sightengine — api_user', description: 'Utilisé pour le filtre NSFW si ANTHROPIC_API_KEY est absent', group: 'Services externes' },
    sightengineSecret: { type: 'string', label: 'Sightengine — api_secret', secret: true, group: 'Services externes' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS automod_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, rule TEXT NOT NULL, user_id TEXT, user_tag TEXT, channel_id TEXT, message_id TEXT, action TEXT, detail TEXT, content TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_automod_hits_guild ON automod_hits(guild_id, created_at DESC);
     CREATE INDEX IF NOT EXISTS idx_automod_hits_rule ON automod_hits(guild_id, rule);
     CREATE TABLE IF NOT EXISTS automod_phish_domains (domain TEXT PRIMARY KEY, source TEXT, added_at INTEGER NOT NULL);`,
  ],
  async init(ctx) {
    loadPhishCache(ctx);
    if (!ctx.scheduler.find('automod', 'phish_refresh', null).length) {
      ctx.scheduler.schedule({ guildId: null, module: 'automod', type: 'phish_refresh', runAt: Date.now() + 15000, repeatMs: PHISH_REFRESH_MS, payload: {} });
    }
    if (!ctx.scheduler.find('automod', 'slowmode_decay', null).length) {
      ctx.scheduler.schedule({ guildId: null, module: 'automod', type: 'slowmode_decay', runAt: Date.now() + 60000, repeatMs: 60000, payload: {} });
    }
  },
  jobs: {
    async phish_refresh(ctx) { await refreshPhishList(ctx); },
    async slowmode_decay(ctx) { await decaySlowmodes(ctx); },
  },
  events: [
    { name: 'messageCreate', guildScoped: true, async execute(ctx, message) { await scanMessage(ctx, message, { edited: false }); } },
    { name: 'messageUpdate', guildScoped: true, async execute(ctx, oldMessage, newMessage) {
      if (newMessage.partial) newMessage = await newMessage.fetch().catch(() => null);
      if (!newMessage || oldMessage?.content === newMessage.content) return;
      await scanMessage(ctx, newMessage, { edited: true });
    } },
  ],
  actions: {
    status: {
      description: 'État de l\'auto-modération et de chaque règle', slash: { group: 'automod', name: 'status' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'automod');
        const rules = allRules(s);
        const lines = RULE_NAMES.map((n) => { const r = rules[n]; const keys = Object.entries(RULE_DEFS[n].keys).map(([k]) => `${k}=${fmt(r[k])}`).join(' '); return `${r.enabled ? '🟢' : '🔴'} **${RULE_DEFS[n].label}** \`${n}\` → \`${r.action}\`${keys ? ` (${keys})` : ''}`; });
        const providers = { nsfw: nsfwProvider(ctx, s), safeBrowsing: !!(s.safeBrowsingKey || process.env.GOOGLE_SAFE_BROWSING_KEY), phishDomains: phishDomains.size };
        const e = embed({ title: '🤖 Auto-modération', description: lines.join('\n'), fields: [
          { name: 'Mots interdits', value: String(s.bannedWords.length), inline: true }, { name: 'Domaines autorisés', value: String(s.linkWhitelist.length), inline: true }, { name: 'Extensions bloquées', value: String(s.blockedExtensions.length), inline: true },
          { name: 'Anti-phishing', value: `${providers.phishDomains} domaines en cache • Safe Browsing : ${providers.safeBrowsing ? '✅' : '❌'}`, inline: true }, { name: 'Filtre NSFW', value: providers.nsfw === 'none' ? '❌ non configuré (ANTHROPIC_API_KEY ou Sightengine)' : `✅ ${providers.nsfw}`, inline: true },
          { name: 'Exceptions', value: `${s.ignoredChannels.length} salon(s), ${s.ignoredRoles.length} rôle(s), staff ${s.bypassStaff ? 'exempté' : 'contrôlé'}`, inline: true },
        ] });
        return { embed: e, data: { rules, providers, bannedWords: s.bannedWords, linkWhitelist: s.linkWhitelist, blockedExtensions: s.blockedExtensions } };
      },
    },
    enable: {
      description: 'Activer une règle', slash: { group: 'automod', name: 'enable' }, permissions: ['ManageGuild'],
      params: { rule: { type: 'choice', required: true, description: 'Règle', choices: ruleChoices() } },
      async run(ctx, { guild, params }) { const r = patchRule(ctx, guild.id, params.rule, { enabled: true }); return { message: `Règle **${RULE_DEFS[params.rule].label}** activée (action : \`${r.action}\`).`, data: r }; },
    },
    disable: {
      description: 'Désactiver une règle', slash: { group: 'automod', name: 'disable' }, permissions: ['ManageGuild'],
      params: { rule: { type: 'choice', required: true, description: 'Règle', choices: ruleChoices() } },
      async run(ctx, { guild, params }) { const r = patchRule(ctx, guild.id, params.rule, { enabled: false }); return { message: `Règle **${RULE_DEFS[params.rule].label}** désactivée.`, data: r }; },
    },
    set: {
      description: 'Modifier un réglage d\'une règle (action, seuil…)', slash: { group: 'automod', name: 'set' }, permissions: ['ManageGuild'],
      params: {
        rule: { type: 'choice', required: true, description: 'Règle', choices: ruleChoices() },
        key: { type: 'string', required: true, description: 'Clé : action, enabled, ignoredChannels, ignoredRoles ou un seuil de la règle', autocomplete: true },
        value: { type: 'string', required: true, description: 'Valeur (ex: timeout:10m, 5, true, liste,séparée,par,virgules)', maxLength: 500 },
      },
      async run(ctx, { guild, params }) {
        const def = RULE_DEFS[params.rule];
        const allowed = ['enabled', 'action', 'ignoredChannels', 'ignoredRoles', ...Object.keys(def.keys)];
        if (!allowed.includes(params.key)) throw new ActionError(`Clé inconnue pour ${params.rule}. Clés : ${allowed.join(', ')}`);
        const value = coerceRuleValue(params.key, params.value, def);
        const r = patchRule(ctx, guild.id, params.rule, { [params.key]: value });
        return { message: `**${def.label}** : \`${params.key}\` = \`${fmt(value)}\``, data: r };
      },
      autocomplete: (ctx, { interaction, value }) => {
        const rule = interaction.options.getString('rule');
        const def = RULE_DEFS[rule];
        const keys = ['enabled', 'action', 'ignoredChannels', 'ignoredRoles', ...Object.keys(def?.keys || {})];
        return keys.filter((k) => k.toLowerCase().includes(value.toLowerCase())).map((k) => ({ name: k, value: k }));
      },
    },
    words_add: {
      description: 'Ajouter un mot interdit (jokers * ou /regex/)', slash: { group: 'automod', subgroup: 'words', name: 'add' }, permissions: ['ManageGuild'],
      params: { word: { type: 'string', required: true, description: 'Mot, *joker* ou /regex/i', maxLength: 200 } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'automod');
        const w = params.word.trim();
        if (w.startsWith('/')) { try { compilePattern(w); } catch (err) { throw new ActionError(`Regex invalide : ${err.message}`); } }
        if (s.bannedWords.some((x) => x.toLowerCase() === w.toLowerCase())) throw new ActionError('Ce mot est déjà dans la liste');
        const list = [...s.bannedWords, w];
        ctx.settings.set(guild.id, 'automod', { bannedWords: list });
        wordCache.delete(guild.id);
        return { message: `Mot interdit ajouté : \`${w}\` (${list.length} au total).`, data: { words: list } };
      },
    },
    words_remove: {
      description: 'Retirer un mot interdit', slash: { group: 'automod', subgroup: 'words', name: 'remove' }, permissions: ['ManageGuild'],
      params: { word: { type: 'string', required: true, description: 'Mot à retirer', autocomplete: true } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'automod');
        const list = s.bannedWords.filter((x) => x.toLowerCase() !== params.word.trim().toLowerCase());
        if (list.length === s.bannedWords.length) throw new ActionError('Mot introuvable dans la liste');
        ctx.settings.set(guild.id, 'automod', { bannedWords: list });
        wordCache.delete(guild.id);
        return { message: `Mot retiré : \`${params.word}\`.`, data: { words: list } };
      },
      autocomplete: (ctx, { guild, value }) => ctx.settings.get(guild.id, 'automod').bannedWords.filter((w) => w.toLowerCase().includes(value.toLowerCase())).map((w) => ({ name: w, value: w })),
    },
    words_list: {
      description: 'Lister les mots interdits', slash: { group: 'automod', subgroup: 'words', name: 'list' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const words = ctx.settings.get(guild.id, 'automod').bannedWords;
        return { embed: infoEmbed(words.length ? words.map((w) => `• \`${w}\``).join('\n').slice(0, 4000) : 'Aucun mot interdit.', `Mots interdits (${words.length})`), data: { words } };
      },
    },
    whitelist_add: {
      description: 'Autoriser un domaine (règle anti-lien)', slash: { group: 'automod', subgroup: 'whitelist', name: 'add' }, permissions: ['ManageGuild'],
      params: { domain: { type: 'string', required: true, description: 'Domaine (ex: example.com)', maxLength: 253 } },
      async run(ctx, { guild, params }) {
        const d = normalizeDomain(params.domain);
        if (!d) throw new ActionError('Domaine invalide');
        const s = ctx.settings.get(guild.id, 'automod');
        if (s.linkWhitelist.includes(d)) throw new ActionError('Ce domaine est déjà autorisé');
        const list = [...s.linkWhitelist, d];
        ctx.settings.set(guild.id, 'automod', { linkWhitelist: list });
        return { message: `Domaine autorisé : \`${d}\`.`, data: { whitelist: list } };
      },
    },
    whitelist_remove: {
      description: 'Retirer un domaine de la liste blanche', slash: { group: 'automod', subgroup: 'whitelist', name: 'remove' }, permissions: ['ManageGuild'],
      params: { domain: { type: 'string', required: true, description: 'Domaine', autocomplete: true } },
      async run(ctx, { guild, params }) {
        const d = normalizeDomain(params.domain);
        const s = ctx.settings.get(guild.id, 'automod');
        const list = s.linkWhitelist.filter((x) => x !== d);
        if (list.length === s.linkWhitelist.length) throw new ActionError('Domaine introuvable');
        ctx.settings.set(guild.id, 'automod', { linkWhitelist: list });
        return { message: `Domaine retiré : \`${d}\`.`, data: { whitelist: list } };
      },
      autocomplete: (ctx, { guild, value }) => ctx.settings.get(guild.id, 'automod').linkWhitelist.filter((w) => w.includes(value.toLowerCase())).map((w) => ({ name: w, value: w })),
    },
    whitelist_list: {
      description: 'Lister les domaines autorisés', slash: { group: 'automod', subgroup: 'whitelist', name: 'list' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      async run(ctx, { guild }) { const list = ctx.settings.get(guild.id, 'automod').linkWhitelist; return { embed: infoEmbed(list.map((d) => `• \`${d}\``).join('\n') || 'Aucun domaine.', `Domaines autorisés (${list.length})`), data: { whitelist: list } }; },
    },
    ignore_channel: {
      description: 'Ignorer / réintégrer un salon (toutes règles ou une seule)', slash: { group: 'automod', subgroup: 'ignore', name: 'channel' }, permissions: ['ManageGuild'],
      params: { channel: { type: 'channel', required: true, description: 'Salon' }, mode: { type: 'choice', description: 'Ajouter ou retirer', choices: [{ name: 'Ignorer', value: 'add' }, { name: 'Réintégrer', value: 'remove' }], default: 'add' }, rule: { type: 'choice', description: 'Règle (défaut : toutes)', choices: ruleChoices() } },
      async run(ctx, { guild, params }) { return toggleIgnore(ctx, guild, 'ignoredChannels', params.channel, params.mode, params.rule, `<#${params.channel}>`); },
    },
    ignore_role: {
      description: 'Ignorer / réintégrer un rôle (toutes règles ou une seule)', slash: { group: 'automod', subgroup: 'ignore', name: 'role' }, permissions: ['ManageGuild'],
      params: { role: { type: 'role', required: true, description: 'Rôle' }, mode: { type: 'choice', description: 'Ajouter ou retirer', choices: [{ name: 'Ignorer', value: 'add' }, { name: 'Réintégrer', value: 'remove' }], default: 'add' }, rule: { type: 'choice', description: 'Règle (défaut : toutes)', choices: ruleChoices() } },
      async run(ctx, { guild, params }) { return toggleIgnore(ctx, guild, 'ignoredRoles', params.role, params.mode, params.rule, `<@&${params.role}>`); },
    },
    test: {
      description: 'Analyser un texte et indiquer les règles qui se déclencheraient', slash: { group: 'automod', name: 'test' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: { text: { type: 'text', required: true, description: 'Texte à analyser', maxLength: 2000 } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'automod');
        const rules = allRules(s);
        const hits = await analyzeText(ctx, guild, params.text, s, rules, { includeDisabled: true });
        const lines = hits.map((h) => `${rules[h.rule].enabled ? '🟢' : '⚪'} **${RULE_DEFS[h.rule].label}** (\`${h.rule}\`, action \`${rules[h.rule].action}\`) — ${h.detail}`);
        return { embed: infoEmbed(lines.join('\n') || '✅ Aucune règle ne se déclencherait.', 'Test de l\'auto-modération'), data: { hits, wouldTrigger: hits.filter((h) => rules[h.rule].enabled).map((h) => h.rule) } };
      },
    },
    native_create: {
      description: 'Créer une règle AutoMod native Discord', slash: { group: 'automod', subgroup: 'native', name: 'create' }, permissions: ['ManageGuild'], botPermissions: ['ManageGuild'],
      params: {
        type: { type: 'choice', required: true, description: 'Type de règle', choices: [{ name: 'Mots-clés', value: 'keyword' }, { name: 'Spam de mentions', value: 'mention_spam' }, { name: 'Contenu suspect (spam Discord)', value: 'spam' }, { name: 'Préréglages (grossièretés, sexuel, insultes)', value: 'preset' }] },
        name: { type: 'string', description: 'Nom de la règle', maxLength: 100 },
        keywords: { type: 'list', description: 'Mots-clés (séparés par des virgules, jokers * autorisés)' },
        regex: { type: 'list', description: 'Motifs regex (Rust) séparés par des virgules' },
        mention_limit: { type: 'integer', description: 'Nombre maximum de mentions (mention_spam)', min: 1, max: 50, default: 5 },
        action: { type: 'choice', description: 'Action', choices: [{ name: 'Bloquer le message', value: 'block' }, { name: 'Bloquer + timeout', value: 'timeout' }, { name: 'Bloquer + alerte', value: 'alert' }], default: 'block' },
        timeout_duration: { type: 'duration', description: 'Durée du timeout (si action timeout)', default: '10m', max: 28 * 86400000 },
        alert_channel: { type: 'channel', description: 'Salon d\'alerte (défaut : salon des logs)', channelTypes: ['GuildText'] },
      },
      async run(ctx, { guild, params, actor }) {
        const s = ctx.settings.get(guild.id, 'automod');
        const triggerType = { keyword: AutoModerationRuleTriggerType.Keyword, mention_spam: AutoModerationRuleTriggerType.MentionSpam, spam: AutoModerationRuleTriggerType.Spam, preset: AutoModerationRuleTriggerType.KeywordPreset }[params.type];
        const triggerMetadata = {};
        if (params.type === 'keyword') {
          if (!params.keywords?.length && !params.regex?.length) throw new ActionError('Fournissez des mots-clés ou des regex');
          if (params.keywords?.length) triggerMetadata.keywordFilter = params.keywords.slice(0, 1000).map((k) => k.slice(0, 60));
          if (params.regex?.length) triggerMetadata.regexPatterns = params.regex.slice(0, 10).map((k) => k.slice(0, 260));
        } else if (params.type === 'mention_spam') triggerMetadata.mentionTotalLimit = params.mention_limit;
        else if (params.type === 'preset') triggerMetadata.presets = [AutoModerationRuleKeywordPresetType.Profanity, AutoModerationRuleKeywordPresetType.SexualContent, AutoModerationRuleKeywordPresetType.Slurs];
        const actions = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: 'Message bloqué par l\'auto-modération.' } }];
        if (params.action === 'timeout') {
          if (![AutoModerationRuleTriggerType.Keyword, AutoModerationRuleTriggerType.MentionSpam, AutoModerationRuleTriggerType.KeywordPreset].includes(triggerType)) throw new ActionError('Le timeout n\'est disponible que pour les règles mots-clés, préréglages et mentions');
          actions.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: Math.min(Math.floor(params.timeout_duration / 1000), 2419200) } });
        }
        const alertChannel = params.alert_channel || s.logChannel;
        if ((params.action === 'alert' || params.action === 'timeout') && alertChannel && guild.channels.cache.has(alertChannel)) actions.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: alertChannel } });
        const rule = await guild.autoModerationRules.create({
          name: params.name || `HeiphaisBot — ${params.type}`, eventType: AutoModerationRuleEventType.MessageSend, triggerType, triggerMetadata, actions, enabled: true,
          exemptChannels: s.ignoredChannels.filter((id) => guild.channels.cache.has(id)).slice(0, 50), exemptRoles: s.ignoredRoles.filter((id) => guild.roles.cache.has(id)).slice(0, 20), reason: `Créée par ${actor.tag || actor.id}`,
        }).catch((err) => { throw new ActionError(`Discord a refusé la règle : ${err.message}`); });
        return { message: `Règle native **${rule.name}** créée (\`${rule.id}\`).`, data: nativeRuleData(rule) };
      },
    },
    native_list: {
      description: 'Lister les règles AutoMod natives du serveur', slash: { group: 'automod', subgroup: 'native', name: 'list' }, permissions: ['ManageGuild'], botPermissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rules = await guild.autoModerationRules.fetch().catch(() => null);
        if (!rules) throw new ActionError('Impossible de récupérer les règles (permission Gérer le serveur requise)');
        const list = rules.map(nativeRuleData);
        const lines = list.map((r) => `${r.enabled ? '🟢' : '🔴'} **${r.name}** \`${r.id}\` — ${r.trigger}${r.creatorId === ctx.client.user.id ? ' *(HeiphaisBot)*' : ''}\n↳ ${r.actions.join(', ')}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune règle native.', `Règles AutoMod natives (${list.length})`), data: { rules: list } };
      },
    },
    native_delete: {
      description: 'Supprimer une règle AutoMod native', slash: { group: 'automod', subgroup: 'native', name: 'delete' }, permissions: ['ManageGuild'], botPermissions: ['ManageGuild'],
      params: { rule_id: { type: 'string', required: true, description: 'ID de la règle', autocomplete: true } },
      async run(ctx, { guild, params, actor }) {
        const rule = await guild.autoModerationRules.fetch(params.rule_id).catch(() => null);
        if (!rule) throw new ActionError('Règle introuvable');
        await rule.delete(`Supprimée par ${actor.tag || actor.id}`);
        return { message: `Règle native **${rule.name}** supprimée.` };
      },
      autocomplete: async (ctx, { guild, value }) => { const rules = await guild.autoModerationRules.fetch().catch(() => null); return rules ? rules.filter((r) => r.name.toLowerCase().includes(value.toLowerCase())).map((r) => ({ name: `${r.name} (${r.id})`, value: r.id })) : []; },
    },
    stats: {
      description: 'Statistiques des déclenchements', slash: { group: 'automod', name: 'stats' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: { days: { type: 'integer', description: 'Période en jours', min: 1, max: 365, default: 7 } },
      async run(ctx, { guild, params }) {
        const since = Date.now() - params.days * 86400000;
        const byRule = ctx.db.prepare('SELECT rule, COUNT(*) n FROM automod_hits WHERE guild_id = ? AND created_at >= ? GROUP BY rule ORDER BY n DESC').all(guild.id, since);
        const byUser = ctx.db.prepare('SELECT user_id, user_tag, COUNT(*) n FROM automod_hits WHERE guild_id = ? AND created_at >= ? AND user_id IS NOT NULL GROUP BY user_id ORDER BY n DESC LIMIT 10').all(guild.id, since);
        const byAction = ctx.db.prepare('SELECT action, COUNT(*) n FROM automod_hits WHERE guild_id = ? AND created_at >= ? GROUP BY action ORDER BY n DESC').all(guild.id, since);
        const total = byRule.reduce((a, r) => a + r.n, 0);
        return { embed: embed({ title: `Statistiques auto-modération (${params.days} j)`, description: `**${total}** déclenchement(s)`, fields: [
          { name: 'Par règle', value: byRule.map((r) => `${RULE_DEFS[r.rule]?.label || r.rule} : **${r.n}**`).join('\n') || '—', inline: true },
          { name: 'Par action', value: byAction.map((r) => `\`${r.action}\` : **${r.n}**`).join('\n') || '—', inline: true },
          { name: 'Membres les plus signalés', value: byUser.map((u) => `${u.user_tag || u.user_id} : **${u.n}**`).join('\n') || '—', inline: false },
        ] }), data: { total, byRule, byAction, byUser, days: params.days } };
      },
    },
    hits: {
      description: 'Derniers déclenchements', slash: { group: 'automod', name: 'hits' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: { rule: { type: 'choice', description: 'Filtrer par règle', choices: ruleChoices() }, user: { type: 'user', description: 'Filtrer par membre' }, limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM automod_hits WHERE guild_id = ? AND (? IS NULL OR rule = ?) AND (? IS NULL OR user_id = ?) ORDER BY id DESC LIMIT ?').all(guild.id, params.rule, params.rule, params.user, params.user, params.limit);
        const lines = rows.map((r) => `${discordTimestamp(r.created_at)} **${RULE_DEFS[r.rule]?.label || r.rule}** — ${r.user_tag || r.user_id} dans <#${r.channel_id}> → \`${r.action}\`\n↳ ${truncate(r.detail || '—', 120)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun déclenchement.', 'Déclenchements récents'), data: rows };
      },
    },
    phishing_refresh: {
      description: 'Rafraîchir la liste noire anti-phishing', slash: { group: 'automod', name: 'refresh' }, permissions: ['ManageGuild'], ephemeral: true,
      async run(ctx) { const res = await refreshPhishList(ctx); if (!res.ok) throw new ActionError(`Échec du rafraîchissement : ${res.error} (${phishDomains.size} domaines en cache conservés)`); return { message: `Liste anti-phishing mise à jour : **${res.count}** domaines.`, data: res }; },
    },
  },
  api(router, ctx) {
    router.get('/hits', async (request) => {
      const { rule, user, limit = 100, offset = 0 } = request.query;
      const rows = ctx.db.prepare('SELECT * FROM automod_hits WHERE guild_id = ? AND (? IS NULL OR rule = ?) AND (? IS NULL OR user_id = ?) ORDER BY id DESC LIMIT ? OFFSET ?').all(request.guild.id, rule || null, rule || null, user || null, user || null, Math.min(Number(limit) || 100, 500), Number(offset) || 0);
      const total = ctx.db.prepare('SELECT COUNT(*) n FROM automod_hits WHERE guild_id = ?').get(request.guild.id).n;
      return { ok: true, hits: rows.map((r) => ({ ...r, rule_label: RULE_DEFS[r.rule]?.label || r.rule })), total };
    });
    router.get('/rules', async (request) => ({ ok: true, rules: allRules(ctx.settings.get(request.guild.id, 'automod')), definitions: Object.fromEntries(Object.entries(RULE_DEFS).map(([k, d]) => [k, { label: d.label, description: d.description, keys: Object.keys(d.keys) }])) }));
    router.get('/stats', async (request) => {
      const since = Date.now() - (Number(request.query.days) || 7) * 86400000;
      return { ok: true, byRule: ctx.db.prepare('SELECT rule, COUNT(*) n FROM automod_hits WHERE guild_id = ? AND created_at >= ? GROUP BY rule').all(request.guild.id, since), byDay: ctx.db.prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day, COUNT(*) n FROM automod_hits WHERE guild_id = ? AND created_at >= ? GROUP BY day ORDER BY day").all(request.guild.id, since) };
    });
    router.get('/phishing', async () => ({ ok: true, count: phishDomains.size, lastRefresh: ctx.db.kvGet('automod:phish:lastRefresh') }));
  },
  panel: {
    views: [
      { id: 'hits', title: 'Déclenchements', endpoint: 'hits', key: 'hits', columns: [{ key: 'created_at', label: 'Date', type: 'date' }, { key: 'rule_label', label: 'Règle' }, { key: 'user_tag', label: 'Membre' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'action', label: 'Action' }, { key: 'detail', label: 'Détail' }], quickActions: ['test', 'status', 'enable', 'disable', 'set', 'words_add', 'stats'] },
    ],
  },
};

// ---------------------------------------------------------------------------
// Configuration des règles
// ---------------------------------------------------------------------------
function ruleChoices() { return RULE_NAMES.map((n) => ({ name: RULE_DEFS[n].label, value: n })); }
function ruleConfig(settings, name) {
  const def = RULE_DEFS[name];
  const stored = (settings.rules && typeof settings.rules === 'object' && settings.rules[name]) || {};
  return { name, label: def.label, enabled: def.enabled, action: def.action, ignoredChannels: [], ignoredRoles: [], ...def.keys, ...stored };
}
function allRules(settings) { return Object.fromEntries(RULE_NAMES.map((n) => [n, ruleConfig(settings, n)])); }
function patchRule(ctx, guildId, name, patch) {
  const s = ctx.settings.get(guildId, 'automod');
  const rules = { ...(s.rules && typeof s.rules === 'object' ? s.rules : {}) };
  rules[name] = { ...(rules[name] || {}), ...patch };
  ctx.settings.set(guildId, 'automod', { rules });
  return ruleConfig(ctx.settings.get(guildId, 'automod'), name);
}
function coerceRuleValue(key, raw, def) {
  const v = String(raw).trim();
  if (key === 'enabled') return ['1', 'true', 'oui', 'yes', 'on'].includes(v.toLowerCase());
  if (key === 'action') return parseActionSpec(v);
  if (key === 'ignoredChannels' || key === 'ignoredRoles') return v === 'null' || v === '' ? [] : v.split(/[,\s]+/).map((x) => x.match(/\d{15,22}/)?.[0]).filter(Boolean);
  const current = def.keys[key];
  if (typeof current === 'boolean') return ['1', 'true', 'oui', 'yes', 'on'].includes(v.toLowerCase());
  if (typeof current === 'number') { const n = Number(v); if (Number.isNaN(n) || n < 0) throw new ActionError(`${key} doit être un nombre positif`); return n; }
  return v;
}
function parseActionSpec(v) {
  const s = v.toLowerCase();
  if (['none', 'delete', 'warn', 'kick', 'ban'].includes(s)) return s;
  const m = s.match(/^(timeout|mute)(?::(.+))?$/);
  if (m) { const ms = parseDuration(m[2] || '10m'); if (!ms || ms > 28 * 86400000) throw new ActionError('Durée de timeout invalide (max 28j)'); return `timeout:${m[2] || '10m'}`; }
  throw new ActionError('Action invalide. Valeurs : none, delete, warn, timeout:<durée>, kick, ban');
}
function fmt(v) { if (Array.isArray(v)) return v.length ? v.join(',') : '∅'; if (v === null || v === undefined) return '∅'; return String(v); }
async function toggleIgnore(ctx, guild, key, id, mode, rule, label) {
  if (rule) {
    const r = ruleConfig(ctx.settings.get(guild.id, 'automod'), rule);
    const list = mode === 'add' ? [...new Set([...r[key], id])] : r[key].filter((x) => x !== id);
    patchRule(ctx, guild.id, rule, { [key]: list });
    return { message: `${label} ${mode === 'add' ? 'ignoré par' : 'réintégré dans'} la règle **${RULE_DEFS[rule].label}**.`, data: { rule, [key]: list } };
  }
  const s = ctx.settings.get(guild.id, 'automod');
  const list = mode === 'add' ? [...new Set([...s[key], id])] : s[key].filter((x) => x !== id);
  ctx.settings.set(guild.id, 'automod', { [key]: list });
  return { message: `${label} ${mode === 'add' ? 'ignoré par' : 'réintégré dans'} toutes les règles.`, data: { [key]: list } };
}
function nativeRuleData(rule) {
  const trig = { [AutoModerationRuleTriggerType.Keyword]: 'mots-clés', [AutoModerationRuleTriggerType.Spam]: 'spam', [AutoModerationRuleTriggerType.KeywordPreset]: 'préréglages', [AutoModerationRuleTriggerType.MentionSpam]: 'mentions', [AutoModerationRuleTriggerType.MemberProfile]: 'profil' };
  const act = { [AutoModerationActionType.BlockMessage]: 'blocage', [AutoModerationActionType.SendAlertMessage]: 'alerte', [AutoModerationActionType.Timeout]: 'timeout', [AutoModerationActionType.BlockMemberInteraction]: 'blocage membre' };
  return { id: rule.id, name: rule.name, enabled: rule.enabled, trigger: trig[rule.triggerType] || String(rule.triggerType), creatorId: rule.creatorId, actions: rule.actions.map((a) => act[a.type] || String(a.type)), keywords: rule.triggerMetadata?.keywordFilter || [], regex: rule.triggerMetadata?.regexPatterns || [], mentionLimit: rule.triggerMetadata?.mentionTotalLimit ?? null };
}

// ---------------------------------------------------------------------------
// Analyse des messages
// ---------------------------------------------------------------------------
async function scanMessage(ctx, message, { edited }) {
  if (!message.guild || !message.author || message.author.bot || message.webhookId || message.system) return;
  const guild = message.guild;
  const s = ctx.settings.get(guild.id, 'automod');
  const member = message.member || await guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;
  if (member.id === guild.ownerId) return;
  if (s.bypassStaff && (member.permissions.has(PermissionsBitField.Flags.ManageMessages) || member.permissions.has(PermissionsBitField.Flags.Administrator))) return;
  const chanIds = channelIds(message.channel);
  if (s.ignoredChannels.some((id) => chanIds.includes(id))) return;
  if (s.ignoredRoles.some((id) => member.roles.cache.has(id))) return;
  const rules = allRules(s);
  const active = (name) => { const r = rules[name]; return r.enabled && !r.ignoredChannels.some((id) => chanIds.includes(id)) && !r.ignoredRoles.some((id) => member.roles.cache.has(id)); };

  // Slowmode dynamique (pas de sanction, juste un compteur de salon)
  if (!edited && active('slowmode')) trackChannelRate(ctx, message, rules.slowmode).catch(() => null);

  const hits = [];
  const content = message.content || '';
  // Règles synchrones sur le contenu
  const textHits = await analyzeText(ctx, guild, content, s, rules, { includeDisabled: false, isActive: active, message });
  hits.push(...textHits);
  // Fichiers dangereux
  if (active('files') && message.attachments.size) {
    const blocked = [...message.attachments.values()].filter((a) => s.blockedExtensions.includes(extensionOf(a.name)));
    if (blocked.length) hits.push({ rule: 'files', detail: `Fichier(s) bloqué(s) : ${blocked.map((a) => a.name).join(', ')}` });
  }
  // Anti-spam (fenêtre glissante) & doublons — uniquement sur les nouveaux messages
  if (!edited) {
    const key = `${guild.id}:${member.id}`;
    const buf = spamBuffer.get(key) || [];
    const now = Date.now();
    const hash = normalizeForDup(content) + (message.attachments.size ? `|att:${[...message.attachments.values()].map((a) => a.name).join(',')}` : '');
    buf.push({ ts: now, id: message.id, hash, channelId: message.channel.id });
    const keep = Math.max(rules.spam.seconds, rules.duplicate.seconds, 5) * 1000;
    const pruned = buf.filter((m) => now - m.ts <= keep);
    spamBuffer.set(key, pruned);
    if (active('spam')) {
      const recent = pruned.filter((m) => now - m.ts <= rules.spam.seconds * 1000);
      if (recent.length >= rules.spam.messages) { hits.push({ rule: 'spam', detail: `${recent.length} messages en ${rules.spam.seconds}s`, related: recent }); spamBuffer.set(key, []); }
    }
    if (active('duplicate') && hash.length >= 3) {
      const dup = pruned.filter((m) => m.hash === hash && now - m.ts <= rules.duplicate.seconds * 1000);
      if (dup.length >= rules.duplicate.count) { hits.push({ rule: 'duplicate', detail: `Message répété ${dup.length} fois en ${rules.duplicate.seconds}s`, related: dup }); spamBuffer.set(key, pruned.filter((m) => m.hash !== hash)); }
    }
    if (active('mentions')) {
      const n = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
      if (n > rules.mentions.max) hits.push({ rule: 'mentions', detail: `${n} mentions (max ${rules.mentions.max})` });
    }
  }
  // Règles asynchrones coûteuses seulement si rien de synchrone n'a déjà été trouvé
  if (!hits.length && active('phishing')) {
    const urls = extractUrls(content).map((u) => u.href);
    if (urls.length) { const bad = await safeBrowsingCheck(ctx, s, urls); if (bad) hits.push({ rule: 'phishing', detail: `Google Safe Browsing : ${bad}` }); }
  }
  if (!hits.length && active('nsfw')) {
    const images = imageUrlsOf(message);
    if (images.length) {
      const verdict = await classifyNsfw(ctx, s, images[0], rules.nsfw.threshold);
      if (verdict?.nsfw) hits.push({ rule: 'nsfw', detail: `Image NSFW détectée (${verdict.provider}, score ${Math.round(verdict.score * 100)}%${verdict.category ? `, ${verdict.category}` : ''})` });
    }
  }
  if (!hits.length) return;
  hits.sort((a, b) => RULE_PRIORITY.indexOf(a.rule) - RULE_PRIORITY.indexOf(b.rule));
  const main = hits.reduce((best, h) => (SEVERITY[actionKind(rules[h.rule].action)] > SEVERITY[actionKind(rules[best.rule].action)] ? h : best), hits[0]);
  await applyHit(ctx, guild, message, member, main, hits, rules[main.rule], s);
}

/** Détecteurs purement textuels (utilisés par messageCreate et /automod test). */
async function analyzeText(ctx, guild, content, s, rules, { includeDisabled = false, isActive = null, message = null } = {}) {
  const on = (name) => (includeDisabled ? true : (isActive ? isActive(name) : rules[name].enabled));
  const hits = [];
  if (!content) return hits;
  const urls = extractUrls(content);
  if (on('phishing') && urls.length) {
    const bad = urls.find((u) => isPhishingHost(u.hostname));
    if (bad) hits.push({ rule: 'phishing', detail: `Domaine malveillant : \`${bad.hostname}\` (${phishDomains.has(rootDomain(bad.hostname)) || phishDomains.has(bad.hostname) ? 'liste noire' : 'imitation de Discord/Steam'})` });
  }
  if (on('invite')) {
    const codes = extractInviteCodes(content);
    if (codes.length) {
      let foreign = codes;
      if (rules.invite.allowOwn && guild) { const checks = await Promise.all(codes.map((c) => inviteGuildId(ctx, c))); foreign = codes.filter((c, i) => checks[i] !== guild.id); }
      if (foreign.length) hits.push({ rule: 'invite', detail: `Invitation(s) : ${foreign.map((c) => `discord.gg/${c}`).join(', ')}` });
    }
  }
  if (on('words')) {
    const m = matchBannedWords(guild?.id || 'test', s.bannedWords, content);
    if (m) hits.push({ rule: 'words', detail: `Mot interdit : \`${m.pattern}\` (« ${truncate(m.match, 40)} »)` });
  }
  if (on('affiliate') && urls.length) {
    const cleaned = urls.map((u) => ({ u, c: cleanAffiliateUrl(u.href, s.affiliateParams) })).filter((x) => x.c.affiliate);
    if (cleaned.length) hits.push({ rule: 'affiliate', detail: `Paramètres de suivi : ${[...new Set(cleaned.flatMap((x) => x.c.removed))].slice(0, 8).join(', ') || 'lien de redirection affilié'}`, cleanedContent: replaceUrls(content, cleaned.map((x) => [x.u.raw, x.c.cleaned])) });
  }
  if (on('link') && urls.length) {
    const bad = urls.filter((u) => !isWhitelisted(u.hostname, s.linkWhitelist) && !extractInviteCodes(u.raw).length);
    if (bad.length) hits.push({ rule: 'link', detail: `Lien(s) non autorisé(s) : ${bad.map((u) => u.hostname).slice(0, 5).join(', ')}` });
  }
  if (on('zalgo')) {
    const z = detectZalgo(content, rules.zalgo.ratio);
    if (z.isZalgo) hits.push({ rule: 'zalgo', detail: `${z.marks} caractères combinants (${Math.round(z.ratio * 100)}%)`, cleanedContent: z.cleaned });
  }
  if (on('caps')) {
    const c = capsRatio(content);
    if (c.letters >= rules.caps.minLength && c.percent >= rules.caps.percent) hits.push({ rule: 'caps', detail: `${c.percent}% de majuscules sur ${c.letters} lettres` });
  }
  if (on('emoji')) {
    const n = countEmojis(content);
    if (n > rules.emoji.max) hits.push({ rule: 'emoji', detail: `${n} emojis (max ${rules.emoji.max})` });
  }
  if (on('newline')) {
    const n = (content.match(/\n/g) || []).length;
    if (n > rules.newline.max) hits.push({ rule: 'newline', detail: `${n} sauts de ligne (max ${rules.newline.max})` });
  }
  if (includeDisabled && on('mentions')) {
    const n = (content.match(/<@[!&]?\d+>/g) || []).length + (/@everyone|@here/.test(content) ? 1 : 0);
    if (n > rules.mentions.max) hits.push({ rule: 'mentions', detail: `${n} mentions (max ${rules.mentions.max})` });
  }
  return hits;
}

async function applyHit(ctx, guild, message, member, hit, allHits, rule, s) {
  const log = ctx.log('automod');
  const kind = actionKind(rule.action);
  const deleted = kind !== 'none' ? await message.delete().then(() => true).catch(() => false) : false;
  if (hit.related?.length && deleted) {
    const ch = message.channel;
    const ids = hit.related.filter((m) => m.channelId === ch.id && m.id !== message.id).map((m) => m.id);
    if (ids.length && ch.bulkDelete) await ch.bulkDelete(ids, true).catch(() => null);
  }
  // Repost du contenu nettoyé (zalgo / affiliation)
  if (deleted && hit.cleanedContent && rule.repost && hit.cleanedContent.trim()) await repostAsUser(ctx, message.channel, member, hit.cleanedContent, RULE_DEFS[hit.rule].label);
  // Sanction
  let sanction = null;
  const cdKey = `${guild.id}:${member.id}`;
  const lastSanction = sanctionCooldown.get(cdKey) || 0;
  if (['warn', 'timeout', 'kick', 'ban'].includes(kind) && Date.now() - lastSanction > 15000) {
    sanctionCooldown.set(cdKey, Date.now());
    sanction = await runSanction(ctx, guild, member, rule.action, `Auto-modération : ${RULE_DEFS[hit.rule].label} — ${hit.detail}`).catch((err) => { log.warn({ err }, 'Sanction automod échouée'); return `échec (${err.message})`; });
  }
  const actionLabel = sanction || (deleted ? 'delete' : 'none');
  ctx.db.prepare('INSERT INTO automod_hits (guild_id, rule, user_id, user_tag, channel_id, message_id, action, detail, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(guild.id, hit.rule, member.id, member.user.tag, message.channel.id, message.id, actionLabel, truncate(hit.detail, 500), truncate(message.content || '', 1000), Date.now());
  ctx.bus.publish('automodTrigger', { guildId: guild.id, rule: hit.rule, ruleLabel: RULE_DEFS[hit.rule].label, userId: member.id, userTag: member.user.tag, channelId: message.channel.id, messageId: message.id, action: actionLabel, detail: hit.detail, otherRules: allHits.filter((h) => h !== hit).map((h) => h.rule) });
  await ctx.sendLog(guild, 'automod', embed({ color: kind === 'delete' ? COLORS.warning : COLORS.error, title: `🤖 AutoMod — ${RULE_DEFS[hit.rule].label}`, fields: [
    { name: 'Membre', value: `${member.user.tag} (<@${member.id}>)`, inline: true }, { name: 'Salon', value: `<#${message.channel.id}>`, inline: true }, { name: 'Action', value: `\`${actionLabel}\``, inline: true },
    { name: 'Détail', value: truncate(hit.detail, 1024) }, ...(allHits.length > 1 ? [{ name: 'Autres règles', value: allHits.filter((h) => h !== hit).map((h) => RULE_DEFS[h.rule].label).join(', ') }] : []),
    ...(message.content ? [{ name: 'Message', value: truncate(message.content, 1000) }] : []),
  ], footer: `ID: ${member.id}`, timestamp: Date.now() }));
  if (s.notifyUser && deleted && message.channel.send) {
    const text = ctx.utils.renderTemplate(s.notifyTemplate, ctx.utils.templateVars({ member, guild, channel: message.channel, extra: { rule: RULE_DEFS[hit.rule].label, detail: hit.detail } }));
    const notice = await message.channel.send({ content: text, allowedMentions: { users: [member.id] } }).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => null), 8000).unref?.();
  }
}

function actionKind(action) { return String(action || 'delete').split(':')[0]; }
async function runSanction(ctx, guild, member, actionSpec, reason) {
  const [kind, dur] = String(actionSpec).split(':');
  const actor = { id: ctx.client.user.id, tag: ctx.client.user.tag, source: 'system', isOwner: true };
  const base = { guildId: guild.id, actor, skipPermissions: true, audit: false };
  if (kind === 'warn') { await ctx.actions.run({ ...base, module: 'moderation', action: 'warn_add', params: { user: member.id, reason } }); return 'warn'; }
  if (kind === 'timeout' || kind === 'mute') { await ctx.actions.run({ ...base, module: 'moderation', action: 'timeout', params: { user: member.id, duration: dur || '10m', reason } }); return `timeout:${dur || '10m'}`; }
  if (kind === 'kick') { await ctx.actions.run({ ...base, module: 'moderation', action: 'kick', params: { user: member.id, reason } }); return 'kick'; }
  if (kind === 'ban') { await ctx.actions.run({ ...base, module: 'moderation', action: 'ban', params: { user: member.id, reason } }); return 'ban'; }
  return null;
}

async function repostAsUser(ctx, channel, member, content, reason) {
  const text = truncate(content, 1900);
  try {
    const target = channel.isThread() ? channel.parent : channel;
    if (target && target.fetchWebhooks && channel.guild.members.me?.permissionsIn(target).has(PermissionsBitField.Flags.ManageWebhooks)) {
      const hooks = await target.fetchWebhooks();
      let hook = hooks.find((h) => h.owner?.id === ctx.client.user.id && h.token);
      if (!hook) hook = await target.createWebhook({ name: 'HeiphaisBot AutoMod', avatar: ctx.client.user.displayAvatarURL(), reason: 'Repost des messages nettoyés' });
      await hook.send({ content: text, username: member.displayName.slice(0, 80), avatarURL: member.displayAvatarURL(), allowedMentions: { parse: [] }, ...(channel.isThread() ? { threadId: channel.id } : {}) });
      return true;
    }
  } catch (err) { ctx.log('automod').debug({ err }, 'Webhook indisponible, repli sur embed'); }
  await channel.send({ embeds: [embed({ author: { name: member.displayName, iconURL: member.displayAvatarURL() }, description: text, footer: `Message nettoyé (${reason})` })], allowedMentions: { parse: [] } }).catch(() => null);
  return false;
}

// ---------------------------------------------------------------------------
// Détecteurs purs (exportés pour les tests)
// ---------------------------------------------------------------------------
const URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:\/[^\s<>"'`)\]]*)?/gi;
export function extractUrls(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!url.hostname.includes('.')) continue;
      out.push({ raw, href: url.href, hostname: url.hostname.toLowerCase(), url });
    } catch { /* ignore */ }
  }
  return out;
}
export function extractInviteCodes(text) {
  const re = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite|discord\.com\/invites?|dsc\.gg|discord\.me|invite\.gg)\/([a-z0-9-]{2,32})/gi;
  return [...String(text || '').matchAll(re)].map((m) => m[1]);
}
async function inviteGuildId(ctx, code) {
  const c = inviteCache.get(code);
  if (c && Date.now() - c.at < 3600000) return c.guildId;
  const inv = await ctx.client.fetchInvite(code).catch(() => null);
  const guildId = inv?.guild?.id || null;
  inviteCache.set(code, { guildId, at: Date.now() });
  if (inviteCache.size > 2000) inviteCache.delete(inviteCache.keys().next().value);
  return guildId;
}
export function normalizeDomain(d) { const s = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]; return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null; }
export function rootDomain(host) { const p = String(host).toLowerCase().split('.'); return p.length > 2 ? p.slice(-2).join('.') : p.join('.'); }
export function isWhitelisted(host, list) { host = String(host).toLowerCase(); return (list || []).some((d) => { d = String(d).toLowerCase(); return host === d || host.endsWith(`.${d}`); }); }
export function isPhishingHost(host) {
  host = String(host).toLowerCase();
  if (phishDomains.has(host) || phishDomains.has(rootDomain(host))) return true;
  if (OFFICIAL_DISCORD_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  if (['steampowered.com', 'steamcommunity.com', 'steamgames.com'].some((d) => host === d || host.endsWith(`.${d}`))) return false;
  // Imitations : « dlscord », « discord-nitro », « steamcommunlty »…
  const folded = host.replace(/[^a-z0-9]/g, '').replace(/1|l/g, 'i').replace(/0/g, 'o').replace(/3/g, 'e');
  if (/d[i1l]sc[o0]rd/.test(host) || /discord/.test(folded)) return true;
  if (/steamcommun[il1]ty|steampowered|steamg[il1]ft/.test(folded)) return true;
  return false;
}

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '€': 'e', '!': 'i', '|': 'i', '+': 't', '(': 'c', '¢': 'c', 'ß': 'b' };
export function normalizeText(text) {
  return String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[0134578@$€!|+(¢ß]/g, (c) => LEET[c] ?? c);
}
export function compilePattern(raw) {
  const p = String(raw).trim();
  const rx = p.match(/^\/(.+)\/([a-z]*)$/i);
  if (rx) return { pattern: p, re: new RegExp(rx[1], rx[2].includes('i') ? rx[2].replace(/g/g, '') : `${rx[2].replace(/g/g, '')}i`), regex: true };
  const startWild = p.startsWith('*'); const endWild = p.endsWith('*');
  const core = normalizeText(p.replace(/^\*+|\*+$/g, ''));
  if (!core) return null;
  const sep = '[\\s._\\-*~`"\'#]*';
  const body = [...core].map((ch, i) => (ch === '*' ? '.*?' : `${escapeRe(ch)}+${i < core.length - 1 ? sep : ''}`)).join('');
  const re = new RegExp(`${startWild ? '' : '(?<![\\p{L}\\p{N}])'}${body}${endWild ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu');
  return { pattern: p, re, regex: false };
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function matchBannedWords(cacheKey, words, text) {
  if (!words?.length || !text) return null;
  const key = JSON.stringify(words);
  let entry = wordCache.get(cacheKey);
  if (!entry || entry.key !== key) {
    entry = { key, compiled: words.map((w) => { try { return compilePattern(w); } catch { return null; } }).filter(Boolean) };
    wordCache.set(cacheKey, entry);
  }
  const normalized = normalizeText(text);
  for (const c of entry.compiled) {
    const m = c.regex ? text.match(c.re) : normalized.match(c.re);
    if (m) return { pattern: c.pattern, match: m[0] };
  }
  return null;
}
export function capsRatio(text) {
  const letters = String(text || '').replace(/<a?:\w+:\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) || [];
  const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  return { letters: letters.length, upper, percent: letters.length ? Math.round((upper / letters.length) * 100) : 0 };
}
export function countEmojis(text) {
  const custom = (String(text || '').match(/<a?:\w+:\d+>/g) || []).length;
  const unicode = (String(text || '').replace(/<a?:\w+:\d+>/g, '').match(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu) || []).length;
  return custom + unicode;
}
const ZALGO_RE = /[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;
const ZALGO_RUN_RE = /[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯]{3,}/;
export function detectZalgo(text, ratioThreshold = 0.2) {
  const nfc = String(text || '').normalize('NFC');
  const marks = (nfc.match(ZALGO_RE) || []).length;
  const base = nfc.replace(ZALGO_RE, '').replace(/\s/g, '').length || 1;
  const ratio = marks / base;
  const isZalgo = marks >= 3 && (ratio >= ratioThreshold || ZALGO_RUN_RE.test(nfc));
  return { marks, ratio, cleaned: isZalgo ? cleanZalgo(nfc) : nfc, isZalgo };
}
/** Retire les grappes de caractères combinants (≥ 2 marques sur une même base) en préservant les accents simples. */
export function cleanZalgo(text) {
  const nfd = String(text || '').normalize('NFD');
  let out = ''; let base = ''; let marks = [];
  const flush = () => { out += marks.length <= 1 ? base + marks.join('') : base; base = ''; marks = []; };
  for (const ch of nfd) { if (/\p{M}/u.test(ch)) marks.push(ch); else { flush(); base = ch; } }
  flush();
  return out.normalize('NFC');
}
const TRACKING_PARAMS = new Set(['tag', 'ref', 'ref_', 'refid', 'ref_src', 'ref_url', 'referrer', 'affiliate', 'affiliate_id', 'affiliateid', 'aff', 'aff_id', 'affid', 'aff_sub', 'aff_sub2', 'afftrack', 'aff_fcid', 'aff_fsk', 'aff_platform', 'aff_trace_key', 'aff_request_id', 'sk', 'spm', 'scm', 'pvid', 'algo_pvid', 'algo_exp_id', 'gatewayadapt', 'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'igshid', 'igsh', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'hsctatracking', 'vero_id', 'wickedid', 'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid', 'ascsubtag', 'linkcode', 'camp', 'creative', 'creativeasin', 'linkid', 'psc', 'pd_rd_i', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p', 'pf_rd_r', 'pf_rd_i', 'pf_rd_m', 'pf_rd_s', 'pf_rd_t', '_encoding', 'th', 'srs', 'qid', 'sr', 'sprefix', 'crid', 'dib', 'dib_tag', 'cv', 'tt', 'cid', 'clickid', 'click_id', 'irclickid', 'irgwc', 'partner', 'partner_id', 'partnerid', 'subid', 'sub_id', 'zanpid', 'awc', 'sscid', 'cjevent', 'cjdata', 'epik', 'si', 'trk', 'trkcampaign', 'mkevt', 'mkcid', 'mkrid', 'campid', 'toolid', 'customid', 'shareid', 'share_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id']);
const AFFILIATE_REDIRECT_HOSTS = ['s.click.aliexpress.com', 'click.aliexpress.com', 'amzn.to', 'go.redirectingat.com', 'anrdoezrs.net', 'tkqlhce.com', 'jdoqocy.com', 'kqzyfj.com', 'dpbolvw.net', 'shareasale.com', 'linksynergy.com', 'click.linksynergy.com', 'awin1.com', 'prf.hn', 'shop-links.co', 'howl.me', 'fave.co', 'rstyle.me', 'sovrn.co', 'redirect.viglink.com', 'tidd.ly', 'tinyurl.com/r'];
export function cleanAffiliateUrl(href, extraParams = []) {
  let url;
  try { url = new URL(href); } catch { return { affiliate: false, cleaned: href, removed: [] }; }
  const host = url.hostname.toLowerCase();
  if (AFFILIATE_REDIRECT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return { affiliate: true, cleaned: null, removed: ['redirection affiliée'] };
  const removed = [];
  const extra = new Set((extraParams || []).map((p) => String(p).toLowerCase()));
  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase();
    const youtubeSi = k === 'si' && /(^|\.)(youtube\.com|youtu\.be)$/.test(host);
    if (k.startsWith('utm_') || k.startsWith('aff_') || k.startsWith('pf_rd_') || k.startsWith('pd_rd_') || extra.has(k) || (TRACKING_PARAMS.has(k) && (k !== 'si' || youtubeSi))) { url.searchParams.delete(key); removed.push(key); }
  }
  // Amazon : réduit /gp/product/ASIN ou /.../dp/ASIN au lien canonique
  if (/(^|\.)amazon\.[a-z.]+$/.test(host)) {
    const asin = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    if (asin) {
      const dropped = [...url.searchParams.keys()];
      if (url.pathname !== `/dp/${asin[1]}` || dropped.length) { url.pathname = `/dp/${asin[1]}`; url.search = ''; if (!removed.length) removed.push('chemin de suivi'); removed.push(...dropped.filter((k) => !removed.includes(k))); }
    }
    url.hash = '';
  }
  if (!removed.length) return { affiliate: false, cleaned: href, removed: [] };
  let cleaned = url.toString();
  if (cleaned.endsWith('?')) cleaned = cleaned.slice(0, -1);
  return { affiliate: true, cleaned, removed };
}
function replaceUrls(content, pairs) {
  let out = content;
  for (const [raw, cleaned] of pairs) out = out.split(raw).join(cleaned || '*(lien affilié retiré)*');
  return out;
}
function normalizeForDup(content) { return String(content || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function extensionOf(name) { const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/); return m ? m[1] : ''; }
function channelIds(channel) { const ids = [channel.id]; if (channel.parentId) ids.push(channel.parentId); if (channel.isThread?.() && channel.parent?.parentId) ids.push(channel.parent.parentId); return ids; }
function imageUrlsOf(message) {
  const urls = [];
  for (const a of message.attachments.values()) if ((a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')) urls.push(a.url);
  for (const e of message.embeds || []) { if (e.image?.url) urls.push(e.image.url); else if (e.thumbnail?.url) urls.push(e.thumbnail.url); }
  return urls.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Anti-phishing : liste noire (table + cache) et Google Safe Browsing
// ---------------------------------------------------------------------------
function loadPhishCache(ctx) {
  if (phishLoaded) return;
  try { for (const r of ctx.db.prepare('SELECT domain FROM automod_phish_domains').all()) phishDomains.add(r.domain); } catch { /* ignore */ }
  phishLoaded = true;
}
async function refreshPhishList(ctx) {
  const log = ctx.log('automod');
  try {
    const res = await fetch(PHISH_SOURCE, { headers: { 'X-Identity': 'HeiphaisBot (Discord bot)', accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || list.length < 100) throw new Error('réponse inattendue');
    const insert = ctx.db.prepare('INSERT OR IGNORE INTO automod_phish_domains (domain, source, added_at) VALUES (?, ?, ?)');
    const now = Date.now();
    ctx.db.transaction(() => { ctx.db.prepare("DELETE FROM automod_phish_domains WHERE source = 'sinking.yachts'").run(); for (const d of list) { const dom = String(d).toLowerCase().trim(); if (dom) insert.run(dom, 'sinking.yachts', now); } })();
    phishDomains.clear();
    for (const d of list) phishDomains.add(String(d).toLowerCase().trim());
    ctx.db.kvSet('automod:phish:lastRefresh', now);
    log.info(`Liste anti-phishing rafraîchie : ${phishDomains.size} domaines`);
    return { ok: true, count: phishDomains.size };
  } catch (err) {
    log.warn({ err }, `Rafraîchissement anti-phishing impossible, repli sur le cache (${phishDomains.size} domaines)`);
    return { ok: false, error: err.message, count: phishDomains.size };
  }
}
async function safeBrowsingCheck(ctx, s, urls) {
  const key = s.safeBrowsingKey || process.env.GOOGLE_SAFE_BROWSING_KEY;
  if (!key) return null;
  const now = Date.now();
  const toCheck = [];
  for (const u of urls.slice(0, 20)) { const c = urlVerdictCache.get(u); if (c && now - c.at < 3600000) { if (c.bad) return c.bad; } else toCheck.push(u); }
  if (!toCheck.length) return null;
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ client: { clientId: 'heiphaisbot', clientVersion: ctx.config.version }, threatInfo: { threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'], platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: toCheck.map((url) => ({ url })) } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const matches = data.matches || [];
    for (const u of toCheck) { const m = matches.find((x) => x.threat?.url === u); urlVerdictCache.set(u, { bad: m ? `${m.threatType} (${new URL(u).hostname})` : null, at: now }); }
    if (urlVerdictCache.size > 5000) urlVerdictCache.delete(urlVerdictCache.keys().next().value);
    const first = matches[0];
    return first ? `${first.threatType} (${first.threat?.url || ''})` : null;
  } catch (err) { ctx.log('automod').warn({ err }, 'Safe Browsing indisponible'); return null; }
}

// ---------------------------------------------------------------------------
// Filtre NSFW : Anthropic (API Messages) > Sightengine > désactivé
// ---------------------------------------------------------------------------
function nsfwProvider(ctx, s) {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (s.sightengineUser && s.sightengineSecret) return 'sightengine';
  return 'none';
}
async function classifyNsfw(ctx, s, imageUrl, threshold = 0.7) {
  const provider = nsfwProvider(ctx, s);
  const log = ctx.log('automod');
  if (provider === 'none') { if (!ctx.cache.get('automod:nsfw:warned')) { ctx.cache.set('automod:nsfw:warned', true); log.warn('Règle NSFW activée mais aucun fournisseur configuré (ANTHROPIC_API_KEY ou Sightengine) : filtre désactivé'); } return null; }
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5', max_tokens: 200,
          system: 'Tu es un classifieur de contenu pour un serveur Discord. Analyse l\'image et réponds UNIQUEMENT avec un objet JSON de la forme {"nsfw": true|false, "score": 0.0-1.0, "category": "nudity|sexual|gore|none"}. "score" est ta confiance que l\'image est inappropriée (nudité, contenu sexuel explicite ou gore). Pas de texte autour du JSON.',
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: imageUrl } }, { type: 'text', text: 'Classifie cette image.' }] }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${truncate(await res.text().catch(() => ''), 200)}`);
      const data = await res.json();
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const json = text.match(/\{[\s\S]*\}/);
      const parsed = json ? JSON.parse(json[0]) : {};
      const score = Number(parsed.score ?? (parsed.nsfw ? 1 : 0)) || 0;
      return { provider: 'anthropic', score, nsfw: score >= threshold, category: parsed.category && parsed.category !== 'none' ? parsed.category : null };
    }
    const qs = new URLSearchParams({ models: 'nudity-2.1,gore-2.0', url: imageUrl, api_user: s.sightengineUser, api_secret: s.sightengineSecret });
    const res = await fetch(`https://api.sightengine.com/1.0/check.json?${qs}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.error?.message || 'réponse Sightengine invalide');
    const n = data.nudity || {};
    const scores = { sexual_activity: n.sexual_activity || 0, sexual_display: n.sexual_display || 0, erotica: n.erotica || 0, gore: data.gore?.prob || 0 };
    const [category, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return { provider: 'sightengine', score, nsfw: score >= threshold, category: score >= threshold ? category : null };
  } catch (err) { log.warn({ err }, `Analyse NSFW (${provider}) échouée`); return null; }
}

// ---------------------------------------------------------------------------
// Slowmode dynamique
// ---------------------------------------------------------------------------
async function trackChannelRate(ctx, message, rule) {
  const ch = message.channel;
  if (!ch.setRateLimitPerUser || ch.isThread?.()) return;
  const now = Date.now();
  const arr = (channelRate.get(ch.id) || []).filter((t) => now - t <= 60000);
  arr.push(now);
  channelRate.set(ch.id, arr);
  if (arr.length < rule.permin) return;
  const state = ctx.db.kvGet(`automod:slowmode:${message.guild.id}`, {});
  const entry = state[ch.id];
  if (entry && now - entry.updatedAt < 30000) return;
  const current = ch.rateLimitPerUser || 0;
  if (current >= rule.max) return;
  const next = Math.min(rule.max, current + rule.step);
  if (!ctx.botCan(message.guild, ['ManageChannels'])) return;
  await ch.setRateLimitPerUser(next, 'Slowmode dynamique (auto-modération)').catch(() => null);
  state[ch.id] = { original: entry ? entry.original : current, updatedAt: now, level: next };
  ctx.db.kvSet(`automod:slowmode:${message.guild.id}`, state);
  channelRate.set(ch.id, []);
  await ctx.sendLog(message.guild, 'automod', embed({ color: COLORS.info, description: `🐢 Slowmode dynamique : <#${ch.id}> passe à **${next}s** (${arr.length} messages/min).` }));
}
async function decaySlowmodes(ctx) {
  for (const guild of ctx.client.guilds.cache.values()) {
    const key = `automod:slowmode:${guild.id}`;
    const state = ctx.db.kvGet(key, {});
    const ids = Object.keys(state);
    if (!ids.length) continue;
    const s = ctx.settings.get(guild.id, 'automod');
    const rule = ruleConfig(s, 'slowmode');
    const now = Date.now();
    let changed = false;
    for (const chId of ids) {
      const entry = state[chId];
      const ch = guild.channels.cache.get(chId);
      if (!ch || !ch.setRateLimitPerUser) { delete state[chId]; changed = true; continue; }
      if (now - entry.updatedAt < 120000) continue;
      const rate = (channelRate.get(chId) || []).filter((t) => now - t <= 60000).length;
      if (rate >= rule.permin / 2 && rule.enabled) continue;
      const current = ch.rateLimitPerUser || 0;
      const next = Math.max(entry.original, current - rule.step);
      await ch.setRateLimitPerUser(next, 'Slowmode dynamique : retour au calme').catch(() => null);
      if (next <= entry.original) { delete state[chId]; await ctx.sendLog(guild, 'automod', embed({ color: COLORS.success, description: `🐢 Slowmode dynamique : <#${chId}> revient à **${next}s**.` })); }
      else state[chId] = { ...entry, updatedAt: now, level: next };
      changed = true;
    }
    if (changed) ctx.db.kvSet(key, state);
  }
}
