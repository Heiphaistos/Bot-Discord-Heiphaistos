import { PermissionsBitField, ChannelType, ContextMenuCommandBuilder, ApplicationCommandType, InteractionContextType, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, errorEmbed, discordTimestamp, truncate, COLORS, formatDuration, parseDuration, codeBlock } from '../../core/utils.js';
import { fetchJson, downloadBuffer, assertPublicUrl } from './lib/net.js';
import { evaluate, formatNumber } from './lib/calc.js';
import { convertUnits, convertBase, convertCurrency, lookupUnit, UNIT_CATEGORIES, FIAT, CRYPTO_IDS } from './lib/convert.js';
import { resolveTimezone, timezoneSuggestions, parseDateTime, formatInZone, tzOffsetMs, formatOffset } from './lib/time.js';
import { translate, normalizeLang, langLabel, languageChoices, FLAG_TO_LANG } from './lib/translate.js';
import { weatherInfo, geocodeUrl, forecastUrl, placeLabel, computeAlerts, windDirection, dayLabel } from './lib/weather.js';
import { parseColor, rgbToHex, rgbToHsl, rgbToCmyk } from './lib/color.js';
import { ocrImage, OCR_LANGS } from './lib/ocr.js';
import {
  KEY_PERMS, PERM_FR, permLabel, BADGES, CHANNEL_TYPES, VERIFICATION, CONTENT_FILTER, FEATURES_FR, joinLimited, actorHas, colorSwatch,
  pushSnipe, getSnipes, afkCache, afkNoticeThrottle, flagDone, flagAllowed, onceWithin,
} from './helpers.js';

const MOD = 'utility';
const WEATHER_INTERVAL = 3 * 3600000;
const MAX_WATCHES = 10;
const TEXT_CHANNELS = ['GuildText', 'GuildAnnouncement', 'PublicThread', 'PrivateThread', 'GuildVoice'];

// ---------- small helpers ----------
const settingsOf = (ctx, guild) => (guild ? ctx.settings.get(guild.id, MOD) : ctx.settings.defaults(MOD));
const tzOf = (s) => resolveTimezone(s?.timezone) || 'Europe/Paris';
const translateOpts = (s) => ({ deeplKey: s?.deeplKey || process.env.DEEPL_API_KEY || null, libreUrl: s?.libreTranslateUrl || process.env.LIBRETRANSLATE_URL || null, libreKey: s?.libreTranslateKey || process.env.LIBRETRANSLATE_API_KEY || null });
const ocrOpts = (s) => ({ apiKey: s?.ocrSpaceKey || process.env.OCR_SPACE_API_KEY || null, allowDemo: s?.ocrAllowDemo !== false });
const langAutocomplete = (ctx, { value }) => languageChoices(value);
const tzAutocomplete = (ctx, { value }) => timezoneSuggestions(value);
const ts = (ms, style = 'f') => (ms ? discordTimestamp(ms, style) : '—');
const yesNo = (b) => (b ? 'Oui' : 'Non');

function currencyAutocomplete(ctx, { value }) {
  const v = String(value || '').toUpperCase();
  const all = [...[...FIAT].map((c) => ({ name: `💶 ${c}`, value: c })), ...Object.entries(CRYPTO_IDS).map(([k, id]) => ({ name: `🪙 ${k} (${id})`, value: k }))];
  return all.filter((c) => !v || c.value.startsWith(v) || c.name.toUpperCase().includes(v)).slice(0, 25);
}
function unitAutocomplete(ctx, { value }) {
  const v = String(value || '').toLowerCase();
  const out = [];
  for (const def of Object.values(UNIT_CATEGORIES)) for (const [key, [, label]] of Object.entries(def.units)) if (!v || key.toLowerCase().startsWith(v) || label.toLowerCase().includes(v)) out.push({ name: `${key} — ${label} (${def.label})`, value: key });
  return out.slice(0, 25);
}

async function resolveTextChannel(ctx, guild, id, fallback) {
  const ch = id ? (guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null)) : fallback;
  return ch || null;
}

function afkKey(g, u) { return `${g}:${u}`; }
function loadAfk(ctx) {
  afkCache.clear();
  for (const r of ctx.db.prepare('SELECT * FROM ut_afk').all()) afkCache.set(afkKey(r.guild_id, r.user_id), { ...r, pings: safeParse(r.pings, []) });
}
function safeParse(v, d) { try { return v ? JSON.parse(v) : d; } catch { return d; } }

async function removeAfk(ctx, guild, userId) {
  const row = afkCache.get(afkKey(guild.id, userId)) || ctx.db.prepare('SELECT * FROM ut_afk WHERE guild_id = ? AND user_id = ?').get(guild.id, userId);
  if (!row) return null;
  ctx.db.prepare('DELETE FROM ut_afk WHERE guild_id = ? AND user_id = ?').run(guild.id, userId);
  afkCache.delete(afkKey(guild.id, userId));
  if (row.nick_changed) {
    const member = await ctx.resolve.member(guild, userId);
    if (member?.manageable && member.nickname?.startsWith('[AFK]')) await member.setNickname(row.old_nick || null, 'Fin du statut AFK').catch(() => null);
  }
  return { ...row, pings: Array.isArray(row.pings) ? row.pings : safeParse(row.pings, []) };
}

function snipeEmbed(entry, index, total, kind) {
  const e = embed({
    color: kind === 'deleted' ? COLORS.error : COLORS.warning,
    author: { name: entry.authorTag, iconURL: entry.avatar || undefined },
    description: kind === 'deleted' ? (truncate(entry.content, 4000) || '*(aucun texte)*') : undefined,
    fields: kind === 'edited' ? [{ name: 'Avant', value: truncate(entry.before, 1024) || '*(vide)*' }, { name: 'Après', value: truncate(entry.after, 1024) || '*(vide)*' }, ...(entry.url ? [{ name: 'Message', value: `[Aller au message](${entry.url})` }] : [])] : (entry.attachments?.length ? [{ name: 'Pièces jointes', value: joinLimited(entry.attachments.map((a) => `[${a.name}](${a.url})`), '\n') }] : []),
    footer: `${index}/${total} • ${kind === 'deleted' ? 'supprimé' : 'modifié'}`,
    timestamp: entry.at,
  });
  const img = kind === 'deleted' && entry.attachments?.find((a) => /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.name || a.url));
  if (img) e.setImage(img.url);
  return e;
}

async function weatherFor(ctx, city, days) {
  const geo = await fetchJson(geocodeUrl(city, 1), {}, { service: 'Open-Meteo (géocodage)' });
  const place = geo?.results?.[0];
  if (!place) throw new ActionError(`Ville introuvable : « ${city} »`);
  const data = await fetchJson(forecastUrl(place.latitude, place.longitude, days), {}, { service: 'Open-Meteo' });
  if (!data?.daily?.time) throw new ActionError('Prévisions indisponibles pour ce lieu');
  return { place, data };
}

function weatherThresholds(s) { return { wind: Number(s.weatherWindThreshold) || 70, rain: Number(s.weatherRainThreshold) || 30 }; }

function alertEmbed(place, dailyTime, perDay) {
  const lines = perDay.filter((d) => d.alerts.length).map((d) => `**${dayLabel(dailyTime[d.i], d.i)}** : ${d.alerts.map((a) => `${a.emoji} ${a.label}`).join(', ')}`);
  return embed({ color: COLORS.error, title: `⚠️ Alerte météo — ${place}`, description: lines.join('\n'), footer: 'Open-Meteo.com • surveillance automatique', timestamp: true });
}

async function runOcrOnUrl(ctx, guild, url, lang) {
  const s = settingsOf(ctx, guild);
  const res = await ocrImage(url, lang, ocrOpts(s));
  return res;
}
function ocrResultPayload(res, url, lang) {
  const text = res.text || '';
  const e = embed({ title: '🔎 Texte extrait (OCR)', description: text ? codeBlock(truncate(text, 3900)) : '*Aucun texte détecté.*', thumbnail: url, footer: `${res.engine} • langue : ${OCR_LANGS[lang]?.[2] || lang}` });
  const files = text.length > 3900 ? [{ attachment: Buffer.from(text, 'utf8'), name: 'ocr.txt' }] : undefined;
  return { embed: e, files, data: { text, engine: res.engine, language: lang, url } };
}
function imageFromMessage(message) {
  const att = message.attachments?.find((a) => (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?)(\?|$)/i.test(a.name || a.url));
  if (att) return att.url;
  for (const e of message.embeds || []) { const u = e.image?.url || e.thumbnail?.url; if (u) return u; }
  const m = String(message.content || '').match(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?/i);
  return m ? m[0] : null;
}

function translationEmbed(r, original, extra = {}) {
  return embed({
    color: COLORS.info, author: extra.author, title: extra.title,
    description: truncate(r.text, 4000),
    fields: extra.hideOriginal ? [] : [{ name: `Original (${langLabel(r.source)})`, value: truncate(original, 1024) }],
    footer: `${langLabel(r.source)} → ${langLabel(r.target)} • ${r.engine}${extra.footer ? ` • ${extra.footer}` : ''}`,
  });
}

function parseEmojiMentions(text) {
  const out = [];
  const re = /<(a?):(\w{2,32}):(\d{15,22})>/g; let m;
  while ((m = re.exec(String(text))) && out.length < 10) out.push({ animated: !!m[1], name: m[2], id: m[3] });
  if (!out.length) { const ids = String(text).match(/\d{15,22}/g) || []; for (const id of ids.slice(0, 10)) out.push({ animated: false, name: null, id }); }
  return out;
}
async function createEmoji(ctx, guild, actor, buffer, name) {
  try {
    return await guild.emojis.create({ attachment: buffer, name, reason: `Ajouté par ${actor.tag || actor.id}` });
  } catch (err) {
    const code = err?.code;
    if (code === 30008) throw new ActionError('Nombre maximum d\'émojis atteint sur ce serveur');
    if (code === 50035 || /256/.test(err?.message || '')) throw new ActionError(`Image refusée par Discord (max 256 Ko, PNG/JPG/GIF/WebP) : ${truncate(err.message, 150)}`);
    if (code === 50013) throw new ActionError('Le bot n\'a pas la permission de gérer les émojis');
    throw new ActionError(`Création impossible : ${truncate(err?.message || String(err), 200)}`);
  }
}

export default {
  name: MOD,
  label: 'Utilitaires',
  description: 'Infos membres/serveur, traduction, météo, convertisseurs, calculatrice, OCR, AFK, snipe, émojis et outils divers.',
  category: 'utility',
  icon: '🔧',
  defaultEnabled: true,
  slashGroups: {
    util: 'Outils utilitaires divers', 'util.emoji': 'Émojis du serveur', 'util.weatheralerts': 'Alertes météo automatiques',
    convert: 'Convertisseurs (devises, unités, fuseaux, bases)',
  },
  settings: {
    defaultLanguage: { type: 'string', label: 'Langue par défaut', description: 'Code ISO (fr, en, es…) utilisé par le menu « Traduire »', default: 'fr', group: 'Traduction' },
    deeplKey: { type: 'string', label: 'Clé API DeepL', description: 'Optionnelle (repli : variable DEEPL_API_KEY). Les clés gratuites finissent par :fx', secret: true, group: 'Traduction' },
    libreTranslateUrl: { type: 'string', label: 'URL LibreTranslate', description: 'Instance LibreTranslate (ex : https://libretranslate.example.org)', group: 'Traduction' },
    libreTranslateKey: { type: 'string', label: 'Clé LibreTranslate', description: 'Optionnelle', secret: true, group: 'Traduction' },
    flagTranslation: { type: 'boolean', label: 'Traduction par réaction drapeau', description: 'Réagir avec 🇫🇷 🇬🇧 🇪🇸… traduit le message', default: true, group: 'Traduction' },
    flagTranslationMode: { type: 'choice', label: 'Réponse des traductions par drapeau', choices: [{ name: 'Dans le salon (supprimée après 60 s)', value: 'channel' }, { name: 'En message privé', value: 'dm' }], default: 'channel', group: 'Traduction' },
    timezone: { type: 'string', label: 'Fuseau horaire par défaut', description: 'Nom IANA (Europe/Paris, America/Montreal…)', default: 'Europe/Paris', group: 'Général' },
    ocrSpaceKey: { type: 'string', label: 'Clé API OCR.space', description: 'Gratuite sur ocr.space (repli : variable OCR_SPACE_API_KEY)', secret: true, group: 'OCR' },
    ocrAllowDemo: { type: 'boolean', label: 'Utiliser la clé de démonstration OCR.space', description: 'En dernier recours (limitée)', default: true, group: 'OCR' },
    afkEnabled: { type: 'boolean', label: 'Activer le statut AFK', default: true, group: 'AFK' },
    afkNickname: { type: 'boolean', label: 'Préfixer le pseudo par [AFK]', default: false, group: 'AFK' },
    snipeEnabled: { type: 'boolean', label: 'Activer /snipe et editsnipe', default: true, group: 'Snipe' },
    snipeMaxAgeMinutes: { type: 'integer', label: 'Durée de conservation des snipes (min)', description: '0 = jusqu\'au redémarrage', default: 60, min: 0, max: 1440, group: 'Snipe' },
    weatherWindThreshold: { type: 'integer', label: 'Seuil d\'alerte vent (km/h)', default: 70, min: 20, max: 200, group: 'Météo' },
    weatherRainThreshold: { type: 'number', label: 'Seuil d\'alerte pluie (mm/jour)', default: 30, min: 5, max: 500, group: 'Météo' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ut_afk (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT, old_nick TEXT, nick_changed INTEGER NOT NULL DEFAULT 0, mentions INTEGER NOT NULL DEFAULT 0, pings TEXT NOT NULL DEFAULT '[]', since INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS ut_weather_watch (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, city TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, timezone TEXT, created_by TEXT, last_alert_key TEXT, last_alert_at INTEGER, last_check_at INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_ut_weather_guild ON ut_weather_watch(guild_id);`,
  ],

  async init(ctx) {
    loadAfk(ctx);
    if (!ctx.scheduler.find(MOD, 'weather_check', null).length) ctx.scheduler.schedule({ module: MOD, type: 'weather_check', runAt: Date.now() + 5 * 60000, repeatMs: WEATHER_INTERVAL, payload: {} });
  },

  jobs: {
    async weather_check(ctx) {
      const log = ctx.log(MOD);
      const rows = ctx.db.prepare('SELECT * FROM ut_weather_watch').all();
      const cache = new Map();
      for (const w of rows) {
        const guild = ctx.client.guilds.cache.get(w.guild_id);
        if (!guild || !ctx.settings.isEnabled(guild.id, MOD)) continue;
        const key = `${w.latitude.toFixed(2)},${w.longitude.toFixed(2)}`;
        let data = cache.get(key);
        if (data === undefined) {
          try { data = await fetchJson(forecastUrl(w.latitude, w.longitude, 2), {}, { service: 'Open-Meteo' }); } catch (err) { log.warn({ err: err.message, city: w.city }, 'Prévisions indisponibles'); data = null; }
          cache.set(key, data);
        }
        if (!data?.daily?.time) continue;
        const th = weatherThresholds(ctx.settings.get(guild.id, MOD));
        const perDay = [0, 1].map((i) => ({ i, alerts: computeAlerts(data.daily, i, th) }));
        const parts = perDay.filter((d) => d.alerts.length).map((d) => `${data.daily.time[d.i]}:${d.alerts.map((a) => a.type).sort().join(',')}`);
        ctx.db.prepare('UPDATE ut_weather_watch SET last_check_at = ? WHERE id = ?').run(Date.now(), w.id);
        if (!parts.length) continue;
        const previous = new Set(String(w.last_alert_key || '').split('|'));
        if (!parts.some((p) => !previous.has(p))) continue;
        const channel = guild.channels.cache.get(w.channel_id);
        if (!channel?.isTextBased()) continue;
        const sent = await channel.send({ embeds: [alertEmbed(w.city, data.daily.time, perDay)] }).catch((err) => { log.warn({ err: err.message }, 'Envoi alerte météo impossible'); return null; });
        if (sent) ctx.db.prepare('UPDATE ut_weather_watch SET last_alert_key = ?, last_alert_at = ? WHERE id = ?').run(parts.join('|'), Date.now(), w.id);
      }
    },
  },

  events: [
    {
      name: 'messageCreate', guildScoped: true,
      async execute(ctx, message) {
        if (!message.guild || message.author?.bot || message.webhookId || message.system) return;
        const s = ctx.settings.get(message.guild.id, MOD);
        if (!s.afkEnabled || !afkCache.size) return;
        const own = afkCache.get(afkKey(message.guild.id, message.author.id));
        if (own) {
          const prefix = ctx.getPrefix(message.guild.id);
          const isAfkCommand = message.content.toLowerCase().startsWith(`${prefix}afk`);
          if (!isAfkCommand && Date.now() - own.since > 5000) {
            const row = await removeAfk(ctx, message.guild, message.author.id);
            if (row) {
              const pings = row.pings.slice(-5).map((p) => `• ${p.by} ${discordTimestamp(p.at)} — [message](${p.url})`);
              const text = `👋 Bon retour <@${message.author.id}> ! Statut AFK retiré (absent ${formatDuration(Date.now() - row.since)}).${row.mentions ? `\nVous avez été mentionné **${row.mentions}** fois :\n${pings.join('\n')}` : ''}`;
              const reply = await message.reply({ content: truncate(text, 1900), allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
              if (reply) setTimeout(() => reply.delete().catch(() => null), 20000).unref?.();
            }
          }
        }
        if (!message.mentions?.users?.size) return;
        const lines = [];
        for (const user of message.mentions.users.values()) {
          if (user.id === message.author.id || user.bot) continue;
          const row = afkCache.get(afkKey(message.guild.id, user.id));
          if (!row) continue;
          row.mentions = (row.mentions || 0) + 1;
          row.pings = [...(row.pings || []), { by: message.author.tag, url: message.url, at: Date.now() }].slice(-10);
          ctx.db.prepare('UPDATE ut_afk SET mentions = ?, pings = ? WHERE guild_id = ? AND user_id = ?').run(row.mentions, JSON.stringify(row.pings), message.guild.id, user.id);
          if (onceWithin(afkNoticeThrottle, `${message.channelId}:${user.id}`, 60000)) lines.push(`💤 **${user.displayName || user.username}** est AFK depuis ${discordTimestamp(row.since)}${row.reason ? ` : ${truncate(row.reason, 200)}` : ''}`);
        }
        if (lines.length) {
          const reply = await message.reply({ content: lines.join('\n'), allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
          if (reply) setTimeout(() => reply.delete().catch(() => null), 30000).unref?.();
        }
      },
    },
    {
      name: 'messageDelete', guildScoped: true,
      async execute(ctx, message) {
        if (!message.guild || message.partial || message.author?.bot || message.webhookId) return;
        if (!ctx.settings.get(message.guild.id, MOD).snipeEnabled) return;
        if (!message.content && !message.attachments?.size) return;
        pushSnipe('deleted', message.channelId, {
          id: message.id, content: message.content || '', authorId: message.author.id, authorTag: message.author.tag, avatar: message.author.displayAvatarURL({ size: 64 }),
          attachments: [...(message.attachments?.values() || [])].map((a) => ({ name: a.name, url: a.proxyURL || a.url })), createdAt: message.createdTimestamp, at: Date.now(),
        });
      },
    },
    {
      name: 'messageUpdate', guildScoped: true,
      async execute(ctx, oldMessage, newMessage) {
        if (!newMessage.guild || oldMessage.partial || newMessage.author?.bot || newMessage.webhookId) return;
        if (oldMessage.content === newMessage.content || !oldMessage.content) return;
        if (!ctx.settings.get(newMessage.guild.id, MOD).snipeEnabled) return;
        pushSnipe('edited', newMessage.channelId, {
          id: newMessage.id, before: oldMessage.content, after: newMessage.content || '', authorId: newMessage.author.id, authorTag: newMessage.author.tag, avatar: newMessage.author.displayAvatarURL({ size: 64 }), url: newMessage.url, at: Date.now(),
        });
      },
    },
    {
      // reaction objects carry no direct guild reference: the module toggle is checked manually
      name: 'messageReactionAdd', guildScoped: false,
      async execute(ctx, reaction, user) {
        if (user?.bot) return;
        const lang = FLAG_TO_LANG[reaction.emoji?.name];
        if (!lang) return;
        if (reaction.partial) { reaction = await reaction.fetch().catch(() => null); if (!reaction) return; }
        const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
        const guild = message?.guild;
        if (!guild || !ctx.settings.isEnabled(guild.id, MOD)) return;
        const s = ctx.settings.get(guild.id, MOD);
        if (!s.flagTranslation) return;
        const text = message.content || message.embeds?.[0]?.description || '';
        if (!text.trim()) return;
        const dm = s.flagTranslationMode === 'dm';
        if (!onceWithin(flagDone, `${message.id}:${lang}${dm ? `:${user.id}` : ''}`, 60000)) return;
        if (!flagAllowed(user.id)) return;
        let r;
        try { r = await translate(text, lang, 'auto', translateOpts(s)); } catch (err) { ctx.log(MOD).debug({ err: err.message }, 'Traduction par drapeau échouée'); return; }
        const e = translationEmbed(r, text, { author: { name: message.author?.tag || 'Message', iconURL: message.author?.displayAvatarURL?.({ size: 64 }) }, hideOriginal: !dm, footer: `demandé par ${user.username}` });
        if (dm) {
          const sent = await user.send({ content: `Traduction de ${message.url}`, embeds: [e] }).catch(() => null);
          if (sent) return;
        }
        const reply = await message.reply({ embeds: [e], allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
        if (reply) setTimeout(() => reply.delete().catch(() => null), 60000).unref?.();
      },
    },
  ],

  contextMenus: [
    {
      data: new ContextMenuCommandBuilder().setName('Traduire').setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild),
      async execute(interaction, ctx) {
        if (interaction.guildId && !ctx.settings.isEnabled(interaction.guildId, MOD)) return interaction.reply({ embeds: [errorEmbed('Le module Utilitaires est désactivé sur ce serveur.')], flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const message = interaction.targetMessage;
        const text = message.content || message.embeds?.[0]?.description || '';
        if (!text.trim()) throw new ActionError('Ce message ne contient pas de texte à traduire');
        const s = settingsOf(ctx, interaction.guild);
        let target = normalizeLang(s.defaultLanguage) || 'fr';
        let r = await translate(text, target, 'auto', translateOpts(s));
        if (r.source === target) { target = target === 'en' ? 'fr' : 'en'; r = await translate(text, target, 'auto', translateOpts(s)); }
        return interaction.editReply({ embeds: [translationEmbed(r, text, { author: { name: message.author?.tag || 'Message', iconURL: message.author?.displayAvatarURL?.({ size: 64 }) } })] });
      },
    },
    {
      data: new ContextMenuCommandBuilder().setName('Extraire le texte (OCR)').setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild),
      async execute(interaction, ctx) {
        if (interaction.guildId && !ctx.settings.isEnabled(interaction.guildId, MOD)) return interaction.reply({ embeds: [errorEmbed('Le module Utilitaires est désactivé sur ce serveur.')], flags: MessageFlags.Ephemeral });
        const url = imageFromMessage(interaction.targetMessage);
        if (!url) return interaction.reply({ embeds: [errorEmbed('Aucune image trouvée dans ce message.')], flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const s = settingsOf(ctx, interaction.guild);
        const lang = normalizeLang(s.defaultLanguage);
        const useLang = OCR_LANGS[lang] ? lang : 'fr';
        const res = await runOcrOnUrl(ctx, interaction.guild, url, useLang);
        const p = ocrResultPayload(res, url, useLang);
        return interaction.editReply({ embeds: [p.embed], files: p.files || [] });
      },
    },
  ],

  actions: {
    // ================= Informations =================
    userinfo: {
      description: 'Informations détaillées sur un membre', permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const id = params.user || actor.id;
        const member = await ctx.resolve.member(guild, id);
        const user = await ctx.client.users.fetch(id, { force: true }).catch(() => member?.user || null);
        if (!user) throw new ActionError('Utilisateur introuvable');
        const flags = (user.flags || await user.fetchFlags().catch(() => null))?.toArray?.() || [];
        const badges = flags.map((f) => BADGES[f]).filter(Boolean);
        if (user.bot) badges.unshift('🤖 Bot');
        if (user.banner || user.avatar?.startsWith('a_') || member?.avatar) badges.push('💠 Nitro (probable)');
        if (member?.premiumSinceTimestamp) badges.push('🚀 Booster');
        const fields = [
          { name: 'Identité', value: `${user} \`${user.tag}\`\nID : \`${user.id}\`${user.globalName ? `\nNom affiché : ${user.globalName}` : ''}`, inline: true },
          { name: 'Compte créé', value: `${ts(user.createdTimestamp, 'D')}\n${ts(user.createdTimestamp, 'R')}`, inline: true },
        ];
        let data = { id: user.id, tag: user.tag, globalName: user.globalName, bot: user.bot, createdAt: user.createdTimestamp, badges: flags, avatar: user.displayAvatarURL({ size: 1024 }), banner: user.bannerURL?.({ size: 1024 }) || null };
        if (member) {
          const roles = member.roles.cache.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
          const perms = member.permissions.has(PermissionsBitField.Flags.Administrator) ? ['Administrator'] : KEY_PERMS.filter((p) => member.permissions.has(PermissionsBitField.Flags[p]));
          const joinPos = guild.members.cache.size >= guild.memberCount - 5 ? [...guild.members.cache.values()].filter((m) => m.joinedTimestamp && m.joinedTimestamp < member.joinedTimestamp).length + 1 : null;
          const acks = [];
          if (member.id === guild.ownerId) acks.push('👑 Propriétaire du serveur');
          else if (member.permissions.has(PermissionsBitField.Flags.Administrator)) acks.push('⚙️ Administrateur');
          else if (member.permissions.any([PermissionsBitField.Flags.BanMembers, PermissionsBitField.Flags.KickMembers, PermissionsBitField.Flags.ModerateMembers])) acks.push('🛡️ Modérateur');
          fields.push(
            { name: 'Arrivée sur le serveur', value: `${ts(member.joinedTimestamp, 'D')}\n${ts(member.joinedTimestamp, 'R')}${joinPos ? `\n${joinPos}e membre` : ''}`, inline: true },
            { name: 'Surnom', value: member.nickname || '—', inline: true },
            { name: 'Rôle le plus haut', value: member.roles.highest.id === guild.id ? '—' : `${member.roles.highest}`, inline: true },
            { name: 'Boost', value: member.premiumSinceTimestamp ? `🚀 depuis ${ts(member.premiumSinceTimestamp, 'R')}` : 'Non', inline: true },
          );
          if (member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) fields.push({ name: '🔇 En timeout', value: `Jusqu'à ${ts(member.communicationDisabledUntilTimestamp, 'f')} (${ts(member.communicationDisabledUntilTimestamp, 'R')})`, inline: false });
          fields.push({ name: `Rôles (${roles.size})`, value: joinLimited(roles.map((r) => `${r}`), ' ') });
          fields.push({ name: 'Permissions clés', value: perms.length ? joinLimited(perms.map(permLabel), ', ') : 'Aucune' });
          if (acks.length) fields.push({ name: 'Statut', value: acks.join('\n'), inline: true });
          const afk = afkCache.get(afkKey(guild.id, member.id));
          if (afk) fields.push({ name: '💤 AFK', value: `${afk.reason || 'Sans raison'} (${ts(afk.since, 'R')})`, inline: true });
          data = { ...data, nickname: member.nickname, joinedAt: member.joinedTimestamp, roles: roles.map((r) => r.id), keyPermissions: perms, boostingSince: member.premiumSinceTimestamp, timeoutUntil: member.communicationDisabledUntilTimestamp, afk: afk ? { reason: afk.reason, since: afk.since } : null };
        }
        if (badges.length) fields.push({ name: 'Badges', value: badges.join('\n'), inline: true });
        const e = embed({ color: member?.displayColor || user.accentColor || undefined, author: { name: user.tag, iconURL: user.displayAvatarURL({ size: 64 }) }, thumbnail: (member || user).displayAvatarURL({ size: 256 }), fields, image: user.bannerURL?.({ size: 512 }) || undefined, footer: member ? 'Membre du serveur' : 'Pas membre de ce serveur' });
        return { embed: e, data };
      },
    },
    serverinfo: {
      description: 'Informations sur le serveur', permissions: [], audit: false, slash: { group: 'util', name: 'serverinfo' },
      async run(ctx, { guild }) {
        const g = await guild.fetch().catch(() => guild);
        const owner = await guild.fetchOwner().catch(() => null);
        const ch = guild.channels.cache;
        const count = (...types) => ch.filter((c) => types.includes(c.type)).size;
        const emojis = guild.emojis.cache;
        const features = (guild.features || []).map((f) => FEATURES_FR[f]).filter(Boolean);
        const fields = [
          { name: 'Propriétaire', value: owner ? `${owner} \`${owner.user.tag}\`` : `<@${guild.ownerId}>`, inline: true },
          { name: 'Créé le', value: `${ts(guild.createdTimestamp, 'D')}\n${ts(guild.createdTimestamp, 'R')}`, inline: true },
          { name: 'ID', value: `\`${guild.id}\``, inline: true },
          { name: 'Membres', value: `👥 ${guild.memberCount}${g.approximatePresenceCount ? `\n🟢 ${g.approximatePresenceCount} en ligne` : ''}`, inline: true },
          { name: `Salons (${ch.size})`, value: `💬 ${count(ChannelType.GuildText)} • 🔊 ${count(ChannelType.GuildVoice)} • 📢 ${count(ChannelType.GuildAnnouncement)}\n🗂️ ${count(ChannelType.GuildForum)} • 🎙️ ${count(ChannelType.GuildStageVoice)} • 📁 ${count(ChannelType.GuildCategory)}`, inline: true },
          { name: 'Rôles', value: String(guild.roles.cache.size - 1), inline: true },
          { name: 'Émojis & autocollants', value: `😀 ${emojis.filter((e) => !e.animated).size} • 🎞️ ${emojis.filter((e) => e.animated).size} • 🏷️ ${guild.stickers.cache.size}`, inline: true },
          { name: 'Boosts', value: `Niveau ${guild.premiumTier} • ${guild.premiumSubscriptionCount || 0} boost(s)`, inline: true },
          { name: 'Vérification', value: VERIFICATION[guild.verificationLevel] || String(guild.verificationLevel), inline: true },
          { name: 'Filtre de contenu', value: CONTENT_FILTER[guild.explicitContentFilter] || '—', inline: true },
          { name: 'Langue', value: guild.preferredLocale || '—', inline: true },
          ...(guild.vanityURLCode ? [{ name: 'URL personnalisée', value: `discord.gg/${guild.vanityURLCode}`, inline: true }] : []),
          ...(features.length ? [{ name: 'Fonctionnalités', value: joinLimited(features, ', ') }] : []),
        ];
        return {
          embed: embed({ title: guild.name, description: guild.description || undefined, thumbnail: guild.iconURL({ size: 256 }) || undefined, image: guild.bannerURL({ size: 1024 }) || undefined, fields }),
          data: { id: guild.id, name: guild.name, ownerId: guild.ownerId, createdAt: guild.createdTimestamp, memberCount: guild.memberCount, online: g.approximatePresenceCount ?? null, channels: ch.size, roles: guild.roles.cache.size - 1, emojis: emojis.size, stickers: guild.stickers.cache.size, boosts: guild.premiumSubscriptionCount, tier: guild.premiumTier, verificationLevel: guild.verificationLevel, features: guild.features, icon: guild.iconURL({ size: 1024 }), banner: guild.bannerURL({ size: 1024 }) },
        };
      },
    },
    avatar: {
      description: "Afficher l'avatar (et la bannière) d'un membre", permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const id = params.user || actor.id;
        const user = await ctx.client.users.fetch(id, { force: true }).catch(() => null);
        if (!user) throw new ActionError('Utilisateur introuvable');
        const member = await ctx.resolve.member(guild, id);
        const links = (u) => ['png', 'jpg', 'webp', ...(u.includes('/a_') ? ['gif'] : [])].map((f) => `[${f.toUpperCase()}](${u.replace(/\.(png|jpg|webp|gif)(\?|$)/, `.${f}$2`)})`).join(' • ');
        const globalUrl = user.displayAvatarURL({ size: 4096, extension: 'png' });
        const embeds = [embed({ title: `Avatar de ${user.tag}`, description: links(user.displayAvatarURL({ size: 4096 })), image: user.displayAvatarURL({ size: 4096 }) })];
        const guildAvatar = member?.avatar ? member.avatarURL({ size: 4096 }) : null;
        if (guildAvatar) embeds.push(embed({ title: 'Avatar sur ce serveur', description: links(guildAvatar), image: guildAvatar }));
        const banner = user.bannerURL?.({ size: 4096 }) || null;
        if (banner) embeds.push(embed({ title: 'Bannière', description: links(banner), image: banner }));
        else if (user.hexAccentColor) embeds.push(embed({ color: user.accentColor, description: `Pas de bannière — couleur de profil : \`${user.hexAccentColor}\`` }));
        return { embeds, data: { id: user.id, avatar: globalUrl, guildAvatar, banner, accentColor: user.hexAccentColor || null } };
      },
    },
    roleinfo: {
      description: "Informations sur un rôle", slash: { group: 'util', name: 'roleinfo' }, permissions: [], audit: false,
      params: { role: { type: 'role', required: true, description: 'Rôle' } },
      async run(ctx, { guild, params }) {
        const role = ctx.resolve.role(guild, params.role);
        if (!role) throw new ActionError('Rôle introuvable');
        if (guild.memberCount <= 10000 && guild.members.cache.size < guild.memberCount) await guild.members.fetch().catch(() => null);
        const perms = role.permissions.has(PermissionsBitField.Flags.Administrator) ? ['Administrator'] : role.permissions.toArray();
        return {
          embed: embed({ color: role.color || undefined, title: `Rôle ${role.name}`, thumbnail: role.iconURL?.({ size: 128 }) || undefined, fields: [
            { name: 'ID', value: `\`${role.id}\``, inline: true }, { name: 'Couleur', value: role.color ? role.hexColor.toUpperCase() : 'Aucune', inline: true }, { name: 'Position', value: `${role.position} / ${guild.roles.cache.size - 1}`, inline: true },
            { name: 'Membres', value: String(role.members.size), inline: true }, { name: 'Mentionnable', value: yesNo(role.mentionable), inline: true }, { name: 'Affiché séparément', value: yesNo(role.hoist), inline: true },
            { name: 'Géré par une intégration', value: yesNo(role.managed), inline: true }, { name: 'Créé', value: ts(role.createdTimestamp, 'R'), inline: true }, { name: 'Mention', value: `${role}`, inline: true },
            { name: `Permissions (${perms.length})`, value: perms.length ? joinLimited(perms.map(permLabel), ', ') : 'Aucune' },
          ] }),
          data: { id: role.id, name: role.name, color: role.hexColor, position: role.position, members: role.members.size, mentionable: role.mentionable, hoist: role.hoist, managed: role.managed, createdAt: role.createdTimestamp, permissions: perms },
        };
      },
    },
    channelinfo: {
      description: "Informations sur un salon", slash: { group: 'util', name: 'channelinfo' }, permissions: [], audit: false,
      params: { channel: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const ch = await resolveTextChannel(ctx, guild, params.channel, channel);
        if (!ch || ch.guildId !== guild.id) throw new ActionError('Salon introuvable');
        const fields = [
          { name: 'ID', value: `\`${ch.id}\``, inline: true }, { name: 'Type', value: CHANNEL_TYPES[ch.type] || String(ch.type), inline: true }, { name: 'Créé', value: ts(ch.createdTimestamp, 'R'), inline: true },
          { name: 'Catégorie', value: ch.parent ? ch.parent.name : '—', inline: true }, { name: 'Position', value: String(ch.rawPosition ?? '—'), inline: true }, { name: 'NSFW', value: yesNo(ch.nsfw), inline: true },
        ];
        if (ch.rateLimitPerUser) fields.push({ name: 'Mode lent', value: formatDuration(ch.rateLimitPerUser * 1000), inline: true });
        if ('bitrate' in ch && ch.bitrate) fields.push({ name: 'Débit', value: `${Math.round(ch.bitrate / 1000)} kbps`, inline: true }, { name: 'Limite', value: ch.userLimit ? String(ch.userLimit) : 'Illimitée', inline: true }, { name: 'Connectés', value: String(ch.members?.size ?? 0), inline: true });
        if (ch.threads?.cache) fields.push({ name: 'Fils actifs', value: String(ch.threads.cache.filter((t) => !t.archived).size), inline: true });
        if (ch.permissionOverwrites?.cache) fields.push({ name: 'Permissions spécifiques', value: String(ch.permissionOverwrites.cache.size), inline: true });
        if (ch.topic) fields.push({ name: 'Sujet', value: truncate(ch.topic, 1024) });
        return { embed: embed({ title: `#${ch.name}`, fields }), data: { id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId, nsfw: !!ch.nsfw, topic: ch.topic || null, slowmode: ch.rateLimitPerUser || 0, createdAt: ch.createdTimestamp } };
      },
    },
    inviteinfo: {
      description: "Informations sur une invitation Discord", slash: { group: 'util', name: 'inviteinfo' }, permissions: [], audit: false, guildOnly: false,
      params: { code: { type: 'string', required: true, description: 'Code ou lien (discord.gg/…)', maxLength: 200 } },
      async run(ctx, { params }) {
        const code = (String(params.code).match(/(?:discord(?:app)?\.(?:gg|com\/invite)|discord\.gg)\/([\w-]+)/i)?.[1] || String(params.code).trim()).replace(/[^\w-]/g, '');
        if (!code) throw new ActionError('Code d\'invitation invalide');
        const inv = await ctx.client.fetchInvite(code).catch(() => null);
        if (!inv) throw new ActionError('Invitation invalide ou expirée');
        const fields = [
          { name: 'Serveur', value: inv.guild ? `${inv.guild.name}\n\`${inv.guild.id}\`` : '—', inline: true },
          { name: 'Salon', value: inv.channel ? `#${inv.channel.name}` : '—', inline: true },
          { name: 'Créée par', value: inv.inviter ? `${inv.inviter.tag}` : '—', inline: true },
          { name: 'Membres', value: `${inv.memberCount ?? '?'} (🟢 ${inv.presenceCount ?? '?'})`, inline: true },
          { name: 'Expire', value: inv.expiresTimestamp ? ts(inv.expiresTimestamp, 'R') : 'Jamais', inline: true },
        ];
        if (inv.uses !== null && inv.uses !== undefined) fields.push({ name: 'Utilisations', value: `${inv.uses}${inv.maxUses ? ` / ${inv.maxUses}` : ''}`, inline: true });
        if (inv.guild?.description) fields.push({ name: 'Description', value: truncate(inv.guild.description, 1024) });
        return {
          embed: embed({ title: `Invitation ${inv.code}`, url: `https://discord.gg/${inv.code}`, thumbnail: inv.guild?.iconURL?.({ size: 256 }) || undefined, fields }),
          data: { code: inv.code, guild: inv.guild ? { id: inv.guild.id, name: inv.guild.name } : null, channelId: inv.channelId, inviterId: inv.inviterId, memberCount: inv.memberCount, presenceCount: inv.presenceCount, expiresAt: inv.expiresTimestamp },
        };
      },
    },
    emoji_list: {
      description: 'Lister les émojis du serveur', slash: { group: 'util', subgroup: 'emoji', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const emojis = await guild.emojis.fetch().catch(() => guild.emojis.cache);
        const stat = emojis.filter((e) => !e.animated).map((e) => `${e}`);
        const anim = emojis.filter((e) => e.animated).map((e) => `${e}`);
        const max = guild.premiumTier === 3 ? 250 : guild.premiumTier === 2 ? 150 : guild.premiumTier === 1 ? 100 : 50;
        return {
          embed: embed({ title: `Émojis de ${guild.name} (${emojis.size})`, fields: [
            { name: `Statiques (${stat.length}/${max})`, value: joinLimited(stat, ' ') }, { name: `Animés (${anim.length}/${max})`, value: joinLimited(anim, ' ') },
          ] }),
          data: emojis.map((e) => ({ id: e.id, name: e.name, animated: e.animated, url: e.imageURL() })),
        };
      },
    },
    emoji_add: {
      description: 'Ajouter un émoji depuis une URL ou une image', slash: { group: 'util', subgroup: 'emoji', name: 'add' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { nom: { type: 'string', required: true, description: 'Nom (2-32 caractères, lettres/chiffres/_)', maxLength: 32 }, url: { type: 'string', description: 'URL de l\'image' }, image: { type: 'attachment', description: 'Image (max 256 Ko)' } },
      async run(ctx, { guild, actor, params }) {
        const name = String(params.nom).trim().replace(/[\s-]+/g, '_');
        if (!/^\w{2,32}$/.test(name)) throw new ActionError('Nom invalide : 2 à 32 caractères (lettres, chiffres, _)');
        const src = params.image || params.url;
        if (!src) throw new ActionError('Fournissez une URL ou une image');
        const { buffer } = await downloadBuffer(src, { maxBytes: 2 * 1024 * 1024 });
        const e = await createEmoji(ctx, guild, actor, buffer, name);
        return { message: `Émoji ${e} \`:${e.name}:\` ajouté.`, data: { id: e.id, name: e.name, animated: e.animated } };
      },
    },
    emoji_steal: {
      description: "Copier des émojis d'un autre serveur", slash: { group: 'util', subgroup: 'emoji', name: 'steal' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { emojis: { type: 'string', required: true, description: 'Émoji(s) personnalisé(s) à copier (max 10)', maxLength: 1000 }, nom: { type: 'string', description: 'Nouveau nom (si un seul émoji)', maxLength: 32 } },
      async run(ctx, { guild, actor, params }) {
        const list = parseEmojiMentions(params.emojis);
        if (!list.length) throw new ActionError('Aucun émoji personnalisé trouvé (ex : <:nom:123456789012345678>)');
        const ok = []; const failed = [];
        for (const item of list) {
          const name = (list.length === 1 && params.nom ? params.nom : item.name || `emoji_${item.id.slice(-6)}`).replace(/[\s-]+/g, '_').slice(0, 32);
          try {
            if (!/^\w{2,32}$/.test(name)) throw new ActionError('nom invalide');
            if (guild.emojis.cache.has(item.id)) throw new ActionError('déjà présent sur ce serveur');
            const { buffer } = await downloadBuffer(`https://cdn.discordapp.com/emojis/${item.id}.${item.animated ? 'gif' : 'png'}?size=128&quality=lossless`, { maxBytes: 1024 * 1024 });
            const e = await createEmoji(ctx, guild, actor, buffer, name);
            ok.push(e);
          } catch (err) { failed.push(`\`${item.name || item.id}\` : ${err.message}`); }
        }
        if (!ok.length) throw new ActionError(`Aucun émoji ajouté.\n${failed.join('\n')}`);
        return { message: `${ok.length} émoji(s) ajouté(s) : ${ok.map((e) => `${e}`).join(' ')}${failed.length ? `\nÉchecs :\n${failed.join('\n')}` : ''}`, data: { added: ok.map((e) => ({ id: e.id, name: e.name })), failed } };
      },
    },
    timestamp: {
      description: 'Générer les balises <t:…> Discord pour une date', slash: { group: 'util', name: 'timestamp' }, permissions: [], audit: false, guildOnly: false,
      params: { date: { type: 'string', description: 'Date (2026-12-25 18:00, 25/12 18h, demain 9h, +2h, now…)', default: 'now', maxLength: 100 }, fuseau: { type: 'string', description: 'Fuseau horaire (défaut : celui du serveur)', autocomplete: tzAutocomplete } },
      async run(ctx, { guild, params }) {
        const tz = params.fuseau ? resolveTimezone(params.fuseau) : tzOf(settingsOf(ctx, guild));
        if (!tz) throw new ActionError(`Fuseau horaire inconnu : ${params.fuseau}`);
        const t = parseDateTime(params.date, tz, { parseRelative: parseDuration });
        const unix = Math.floor(t / 1000);
        const styles = [['t', 'Heure courte'], ['T', 'Heure longue'], ['d', 'Date courte'], ['D', 'Date longue'], ['f', 'Date et heure'], ['F', 'Date et heure complètes'], ['R', 'Relatif']];
        return {
          embed: embed({ title: '🕒 Balises temporelles Discord', description: `${formatInZone(t, tz, { withSeconds: true })} (${tz}, ${formatOffset(tzOffsetMs(t, tz))})\nUnix : \`${unix}\``, fields: styles.map(([s, label]) => ({ name: label, value: `\`<t:${unix}:${s}>\`\n<t:${unix}:${s}>`, inline: true })) }),
          data: { unix, ms: t, iso: new Date(t).toISOString(), timezone: tz, formats: Object.fromEntries(styles.map(([s]) => [s, `<t:${unix}:${s}>`])) },
        };
      },
    },
    calc: {
      description: 'Calculatrice (+ - * / % ^ !, sqrt, sin, log…)', slash: { group: 'util', name: 'calc' }, permissions: [], audit: false, guildOnly: false,
      params: { expression: { type: 'string', required: true, description: 'Ex : (2+3)^2 * sqrt(16) / 3', maxLength: 300 }, angle: { type: 'choice', description: 'Unité des angles', choices: [{ name: 'Radians', value: 'rad' }, { name: 'Degrés', value: 'deg' }], default: 'rad' } },
      async run(ctx, { params }) {
        const result = evaluate(params.expression, { angle: params.angle });
        const out = formatNumber(result);
        return { embed: embed({ color: COLORS.info, title: '🧮 Calculatrice', description: `${codeBlock(params.expression)}= **${out}**`, footer: params.angle === 'deg' ? 'Angles en degrés' : 'Angles en radians' }), data: { expression: params.expression, result, formatted: out } };
      },
    },
    color: {
      description: 'Aperçu et conversions d\'une couleur', slash: { group: 'util', name: 'color' }, permissions: [], audit: false, guildOnly: false,
      params: { couleur: { type: 'string', required: true, description: '#5865F2, rgb(88,101,242), hsl(…), nom ou random', maxLength: 60 } },
      async run(ctx, { params }) {
        const rgb = parseColor(params.couleur);
        const hex = rgbToHex(rgb); const hsl = rgbToHsl(rgb); const cmyk = rgbToCmyk(rgb);
        const int = (rgb.r << 16) + (rgb.g << 8) + rgb.b;
        return {
          embed: embed({ color: int || 1, title: `🎨 ${hex}`, image: 'attachment://couleur.png', fields: [
            { name: 'HEX', value: `\`${hex}\``, inline: true }, { name: 'RGB', value: `\`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})\``, inline: true }, { name: 'HSL', value: `\`hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)\``, inline: true },
            { name: 'CMJN', value: `\`${cmyk.c}% ${cmyk.m}% ${cmyk.y}% ${cmyk.k}%\``, inline: true }, { name: 'Entier', value: `\`${int}\``, inline: true },
          ] }),
          files: [{ attachment: colorSwatch(rgb), name: 'couleur.png' }],
          data: { hex, rgb, hsl, cmyk, int },
        };
      },
    },
    permissions: {
      description: "Permissions d'un membre (globales ou dans un salon)", slash: { group: 'util', name: 'permissions' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' }, channel: { type: 'channel', description: 'Salon (optionnel)' } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user || actor.id);
        if (!member) throw new ActionError('Membre introuvable');
        const ch = params.channel ? await resolveTextChannel(ctx, guild, params.channel, null) : null;
        if (params.channel && !ch) throw new ActionError('Salon introuvable');
        const perms = ch ? ch.permissionsFor(member) : member.permissions;
        const all = Object.keys(PermissionsBitField.Flags).filter((p) => PERM_FR[p]);
        const allowed = all.filter((p) => perms.has(PermissionsBitField.Flags[p]));
        const denied = all.filter((p) => !perms.has(PermissionsBitField.Flags[p]));
        const admin = perms.has(PermissionsBitField.Flags.Administrator);
        return {
          embed: embed({ title: `Permissions de ${member.user.tag}${ch ? ` dans #${ch.name}` : ''}`, description: admin ? '⚙️ **Administrateur** : toutes les permissions sont accordées.' : undefined, fields: [
            { name: `✅ Accordées (${allowed.length})`, value: joinLimited(allowed.map(permLabel), '\n') }, ...(admin ? [] : [{ name: `❌ Refusées (${denied.length})`, value: joinLimited(denied.map(permLabel), '\n') }]),
          ].map((f) => ({ ...f, inline: true })) }),
          data: { userId: member.id, channelId: ch?.id || null, administrator: admin, allowed, denied },
        };
      },
    },
    membercount: {
      description: 'Nombre de membres du serveur', slash: { group: 'util', name: 'membercount' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        if (guild.memberCount <= 20000 && guild.members.cache.size < guild.memberCount) await guild.members.fetch().catch(() => null);
        const g = await guild.fetch().catch(() => guild);
        const members = guild.members.cache;
        const bots = members.filter((m) => m.user.bot).size;
        const complete = members.size >= guild.memberCount;
        const now = Date.now();
        const joined = (ms) => members.filter((m) => m.joinedTimestamp && now - m.joinedTimestamp < ms).size;
        const data = { total: guild.memberCount, humans: complete ? members.size - bots : null, bots: complete ? bots : null, online: g.approximatePresenceCount ?? null, joined24h: joined(86400000), joined7d: joined(7 * 86400000) };
        return {
          embed: embed({ title: `👥 ${guild.name}`, fields: [
            { name: 'Total', value: String(data.total), inline: true }, { name: 'Humains', value: data.humans === null ? '?' : String(data.humans), inline: true }, { name: 'Bots', value: data.bots === null ? '?' : String(data.bots), inline: true },
            { name: 'En ligne', value: data.online === null ? '?' : String(data.online), inline: true }, { name: 'Arrivées 24 h', value: String(data.joined24h), inline: true }, { name: 'Arrivées 7 j', value: String(data.joined7d), inline: true },
          ] }),
          data,
        };
      },
    },
    firstmessage: {
      description: "Premier message d'un salon", slash: { group: 'util', name: 'firstmessage' }, permissions: [], audit: false,
      params: { channel: { type: 'channel', description: 'Salon (défaut : courant)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const ch = await resolveTextChannel(ctx, guild, params.channel, channel);
        if (!ch?.isTextBased?.() || !ch.messages) throw new ActionError('Salon textuel requis');
        const msgs = await ch.messages.fetch({ after: '1', limit: 1 }).catch(() => null);
        const first = msgs?.first();
        if (!first) throw new ActionError('Aucun message trouvé (ou accès refusé)');
        return {
          embed: embed({ title: `Premier message de #${ch.name}`, url: first.url, author: { name: first.author.tag, iconURL: first.author.displayAvatarURL({ size: 64 }) }, description: `${truncate(first.content || '*(pas de texte)*', 3800)}\n\n[Aller au message](${first.url})`, footer: 'Envoyé', timestamp: first.createdTimestamp }),
          data: { id: first.id, url: first.url, authorId: first.author.id, content: first.content, createdAt: first.createdTimestamp },
        };
      },
    },
    define: {
      description: "Définition d'un mot anglais (dictionnaire)", slash: { group: 'util', name: 'define' }, permissions: [], audit: false, guildOnly: false, cooldown: 3,
      params: { mot: { type: 'string', required: true, description: 'Mot anglais', maxLength: 60 } },
      async run(ctx, { params }) {
        const word = String(params.mot).trim().toLowerCase();
        if (!/^[\p{L}' -]{1,60}$/u.test(word)) throw new ActionError('Mot invalide');
        let data;
        try { data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {}, { service: 'Free Dictionary API' }); } catch (err) {
          if (err.httpStatus === 404) throw new ActionError(`Aucune définition trouvée pour « ${word} » (dictionnaire anglais uniquement)`);
          throw err;
        }
        const entry = Array.isArray(data) ? data[0] : null;
        if (!entry) throw new ActionError(`Aucune définition trouvée pour « ${word} »`);
        const phonetic = entry.phonetic || entry.phonetics?.find((p) => p.text)?.text || '';
        const audio = entry.phonetics?.find((p) => p.audio)?.audio;
        const meanings = data.flatMap((d) => d.meanings || []).slice(0, 6);
        const fields = meanings.map((m) => ({
          name: `*${m.partOfSpeech}*`,
          value: truncate(m.definitions.slice(0, 3).map((d, i) => `**${i + 1}.** ${d.definition}${d.example ? `\n> *${d.example}*` : ''}`).join('\n') + (m.synonyms?.length ? `\nSynonymes : ${m.synonyms.slice(0, 6).join(', ')}` : ''), 1024),
        }));
        return {
          embed: embed({ title: `📖 ${entry.word}`, url: entry.sourceUrls?.[0], description: [phonetic && `\`${phonetic}\``, audio && `[🔊 Prononciation](${audio})`].filter(Boolean).join(' • ') || undefined, fields, footer: 'dictionaryapi.dev' }),
          data: { word: entry.word, phonetic, audio: audio || null, meanings: meanings.map((m) => ({ partOfSpeech: m.partOfSpeech, definitions: m.definitions.slice(0, 5).map((d) => d.definition), synonyms: m.synonyms || [] })) },
        };
      },
    },
    ocr: {
      description: "Extraire le texte d'une image (OCR)", slash: { group: 'util', name: 'ocr' }, permissions: [], audit: false, cooldown: 10,
      params: {
        image_url: { type: 'string', description: "URL de l'image" }, attachment: { type: 'attachment', description: 'Image' },
        langue: { type: 'choice', description: 'Langue du texte', choices: Object.entries(OCR_LANGS).map(([v, [, , name]]) => ({ name, value: v })), default: 'fr' },
      },
      async run(ctx, { guild, params }) {
        const url = params.attachment || params.image_url;
        if (!url) throw new ActionError('Fournissez une image (pièce jointe) ou une URL');
        const res = await runOcrOnUrl(ctx, guild, url, params.langue);
        return ocrResultPayload(res, url, params.langue);
      },
    },

    // ================= Traduction / météo =================
    translate: {
      description: 'Traduire un texte', permissions: [], audit: false, guildOnly: false, cooldown: 3,
      params: {
        langue_cible: { type: 'string', required: true, description: 'Langue cible (fr, en, es, de, ja…)', autocomplete: langAutocomplete },
        texte: { type: 'text', required: true, description: 'Texte à traduire', maxLength: 2000 },
        source: { type: 'string', description: 'Langue source (défaut : détection automatique)', autocomplete: langAutocomplete },
      },
      async run(ctx, { guild, params }) {
        const r = await translate(params.texte, params.langue_cible, params.source || 'auto', translateOpts(settingsOf(ctx, guild)));
        return { embed: translationEmbed(r, params.texte, { title: '🌐 Traduction' }), data: { text: r.text, source: r.source, target: r.target, engine: r.engine } };
      },
    },
    weather: {
      description: 'Météo actuelle et prévisions', permissions: [], audit: false, guildOnly: false, cooldown: 3,
      params: { ville: { type: 'string', required: true, description: 'Ville', maxLength: 100 }, jours: { type: 'integer', description: 'Jours de prévision (1-14)', min: 1, max: 14, default: 7 } },
      async run(ctx, { guild, params }) {
        const { place, data } = await weatherFor(ctx, params.ville, params.jours);
        const d = data.daily; const cur = data.current_weather || {};
        const [cEmoji, cLabel] = weatherInfo(cur.weathercode);
        const th = weatherThresholds(settingsOf(ctx, guild));
        const perDay = d.time.map((t, i) => ({ i, alerts: computeAlerts(d, i, th) }));
        const fields = d.time.map((t, i) => {
          const [e, label] = weatherInfo(d.weathercode[i]);
          const prob = d.precipitation_probability_max?.[i];
          return { name: `${e} ${dayLabel(t, i)}`, value: `${label}\n🌡️ ${Math.round(d.temperature_2m_min[i])}° / **${Math.round(d.temperature_2m_max[i])}°**\n💧 ${(d.precipitation_sum[i] ?? 0).toFixed(1)} mm${typeof prob === 'number' ? ` (${prob} %)` : ''}\n💨 ${Math.round(d.windspeed_10m_max[i] ?? 0)} km/h${perDay[i].alerts.length ? `\n${perDay[i].alerts.map((a) => a.emoji).join('')}` : ''}`, inline: true };
        });
        const alertLines = perDay.filter((x) => x.alerts.length).map((x) => `**${dayLabel(d.time[x.i], x.i)}** : ${x.alerts.map((a) => `${a.emoji} ${a.label}`).join(', ')}`);
        if (alertLines.length) fields.push({ name: '⚠️ Alertes', value: joinLimited(alertLines, '\n') });
        const e = embed({
          color: alertLines.length ? COLORS.warning : COLORS.info,
          title: `${cEmoji} Météo — ${placeLabel(place)}`,
          description: `**${Math.round(cur.temperature ?? 0)} °C** • ${cLabel}\n💨 Vent ${Math.round(cur.windspeed ?? 0)} km/h ${windDirection(cur.winddirection)}${typeof place.elevation === 'number' ? ` • ⛰️ ${Math.round(place.elevation)} m` : ''}`,
          fields, footer: `Open-Meteo.com • ${data.timezone || ''}`, timestamp: true,
        });
        return { embed: e, data: { place: { name: place.name, country: place.country, admin1: place.admin1, latitude: place.latitude, longitude: place.longitude }, current: cur, daily: d, alerts: perDay.filter((x) => x.alerts.length).map((x) => ({ date: d.time[x.i], alerts: x.alerts })) } };
      },
    },
    weather_watch_add: {
      description: 'Surveiller la météo d\'une ville (alertes auto)', slash: { group: 'util', subgroup: 'weatheralerts', name: 'add' }, permissions: ['ManageGuild'],
      params: { ville: { type: 'string', required: true, description: 'Ville à surveiller', maxLength: 100 }, salon: { type: 'channel', required: true, description: 'Salon des alertes', channelTypes: ['GuildText', 'GuildAnnouncement'] } },
      async run(ctx, { guild, actor, params }) {
        const ch = guild.channels.cache.get(params.salon);
        if (!ch?.isTextBased()) throw new ActionError('Salon textuel invalide');
        const n = ctx.db.prepare('SELECT COUNT(*) n FROM ut_weather_watch WHERE guild_id = ?').get(guild.id).n;
        if (n >= MAX_WATCHES) throw new ActionError(`Maximum ${MAX_WATCHES} villes surveillées par serveur`);
        const { place, data } = await weatherFor(ctx, params.ville, 2);
        const label = placeLabel(place);
        if (ctx.db.prepare('SELECT 1 FROM ut_weather_watch WHERE guild_id = ? AND channel_id = ? AND ABS(latitude - ?) < 0.01 AND ABS(longitude - ?) < 0.01').get(guild.id, ch.id, place.latitude, place.longitude)) throw new ActionError(`${label} est déjà surveillée dans ce salon`);
        const info = ctx.db.prepare('INSERT INTO ut_weather_watch (guild_id, channel_id, city, latitude, longitude, timezone, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, ch.id, label, place.latitude, place.longitude, data.timezone || place.timezone || null, actor.id, Date.now());
        const th = weatherThresholds(ctx.settings.get(guild.id, MOD));
        const now = [0, 1].map((i) => computeAlerts(data.daily, i, th)).flat();
        return { message: `Surveillance météo #${info.lastInsertRowid} : **${label}** → <#${ch.id}> (vérification toutes les 3 h).${now.length ? `\nAlertes actuelles : ${now.map((a) => `${a.emoji} ${a.label}`).join(', ')}` : '\nAucune alerte pour le moment.'}`, data: { id: Number(info.lastInsertRowid), city: label, channelId: ch.id, currentAlerts: now } };
      },
    },
    weather_watch_list: {
      description: 'Lister les villes surveillées', slash: { group: 'util', subgroup: 'weatheralerts', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ut_weather_watch WHERE guild_id = ? ORDER BY id').all(guild.id);
        const lines = rows.map((r) => `**#${r.id}** ${r.city} → <#${r.channel_id}>${r.last_alert_at ? ` • dernière alerte ${ts(r.last_alert_at, 'R')}` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune ville surveillée. Ajoutez-en avec `/util weatheralerts add`.', '🌦️ Alertes météo'), data: rows };
      },
    },
    weather_watch_remove: {
      description: 'Arrêter la surveillance d\'une ville', slash: { group: 'util', subgroup: 'weatheralerts', name: 'remove' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de la surveillance' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM ut_weather_watch WHERE id = ? AND guild_id = ?').get(params.id, guild.id);
        if (!row) throw new ActionError('Surveillance introuvable');
        ctx.db.prepare('DELETE FROM ut_weather_watch WHERE id = ?').run(row.id);
        return { message: `Surveillance de **${row.city}** supprimée.`, data: { id: row.id } };
      },
    },

    // ================= Convertisseurs =================
    convert_currency: {
      description: 'Convertir des devises et cryptomonnaies', slash: { group: 'convert', name: 'currency' }, permissions: [], audit: false, guildOnly: false, cooldown: 3,
      params: { montant: { type: 'number', required: true, min: 0, description: 'Montant' }, de: { type: 'string', required: true, description: 'Devise source (EUR, USD, BTC…)', autocomplete: currencyAutocomplete }, vers: { type: 'string', required: true, description: 'Devise cible', autocomplete: currencyAutocomplete } },
      async run(ctx, { params }) {
        const r = await convertCurrency(params.montant, params.de, params.vers, (url, opts) => fetchJson(url, {}, opts));
        const fmt = (n) => (Math.abs(n) >= 1 ? n.toLocaleString('fr-FR', { maximumFractionDigits: 4 }) : formatNumber(n, 6));
        return { embed: embed({ color: COLORS.info, title: '💱 Conversion de devises', description: `**${fmt(r.amount)} ${r.from}** = **${fmt(r.result)} ${r.to}**\n1 ${r.from} = ${fmt(r.rate)} ${r.to}`, footer: `Source : ${r.source}`, timestamp: true }), data: r };
      },
    },
    convert_units: {
      description: "Convertir des unités (longueur, masse, température…)", slash: { group: 'convert', name: 'units' }, permissions: [], audit: false, guildOnly: false,
      params: { valeur: { type: 'number', required: true, description: 'Valeur' }, de: { type: 'string', required: true, description: 'Unité source (km, lb, °C, Go…)', autocomplete: unitAutocomplete }, vers: { type: 'string', required: true, description: 'Unité cible', autocomplete: unitAutocomplete } },
      async run(ctx, { params }) {
        const r = convertUnits(params.valeur, params.de, params.vers);
        const labelOf = (k) => lookupUnit(k)?.label || k;
        return { embed: embed({ color: COLORS.info, title: `📏 ${r.categoryLabel}`, description: `**${formatNumber(r.value)} ${r.from}** (${labelOf(r.from)}) = **${formatNumber(r.result)} ${r.to}** (${labelOf(r.to)})` }), data: r };
      },
    },
    convert_timezone: {
      description: "Convertir une heure d'un fuseau à un autre", slash: { group: 'convert', name: 'timezone' }, permissions: [], audit: false, guildOnly: false,
      params: {
        heure: { type: 'string', required: true, description: 'Heure/date (14:30, demain 9h, 2026-12-25 18:00, now)', maxLength: 60 },
        vers: { type: 'string', required: true, description: 'Fuseau cible (Tokyo, America/New_York, UTC+2…)', autocomplete: tzAutocomplete },
        de: { type: 'string', description: 'Fuseau source (défaut : celui du serveur)', autocomplete: tzAutocomplete },
      },
      async run(ctx, { guild, params }) {
        const from = params.de ? resolveTimezone(params.de) : tzOf(settingsOf(ctx, guild));
        const to = resolveTimezone(params.vers);
        if (!from) throw new ActionError(`Fuseau inconnu : ${params.de}`);
        if (!to) throw new ActionError(`Fuseau inconnu : ${params.vers}`);
        const t = parseDateTime(params.heure, from, { parseRelative: parseDuration });
        const offFrom = tzOffsetMs(t, from); const offTo = tzOffsetMs(t, to);
        const diffH = (offTo - offFrom) / 3600000;
        return {
          embed: embed({ color: COLORS.info, title: '🌍 Conversion de fuseau horaire', fields: [
            { name: `${from} (${formatOffset(offFrom)})`, value: formatInZone(t, from) }, { name: `${to} (${formatOffset(offTo)})`, value: `**${formatInZone(t, to)}**` },
            { name: 'Décalage', value: `${diffH >= 0 ? '+' : ''}${formatNumber(diffH)} h`, inline: true }, { name: 'Pour tous', value: `<t:${Math.floor(t / 1000)}:F>`, inline: true },
          ] }),
          data: { timestamp: t, from, to, fromLocal: formatInZone(t, from), toLocal: formatInZone(t, to), offsetHours: diffH },
        };
      },
    },
    convert_base: {
      description: 'Convertir un nombre entre bases (2, 8, 10, 16…)', slash: { group: 'convert', name: 'base' }, permissions: [], audit: false, guildOnly: false,
      params: { nombre: { type: 'string', required: true, description: 'Nombre (ex : ff, 0b1010, 255)', maxLength: 300 }, de: { type: 'integer', required: true, min: 2, max: 36, description: 'Base source (2-36)' }, vers: { type: 'integer', required: true, min: 2, max: 36, description: 'Base cible (2-36)' } },
      async run(ctx, { params }) {
        const r = convertBase(params.nombre, params.de, params.vers);
        return {
          embed: embed({ color: COLORS.info, title: '🔢 Conversion de base', description: `\`${truncate(r.input, 400)}\` (base ${r.from}) = \`${truncate(r.result, 1500)}\` (base ${r.to})`, fields: [
            { name: 'Binaire', value: `\`${truncate(r.all[2], 1000)}\`` }, { name: 'Octal', value: `\`${truncate(r.all[8], 1000)}\``, inline: true }, { name: 'Décimal', value: `\`${truncate(r.all[10], 1000)}\``, inline: true }, { name: 'Hexadécimal', value: `\`${truncate(r.all[16], 1000)}\``, inline: true },
          ] }),
          data: r,
        };
      },
    },

    // ================= AFK / snipe =================
    afk: {
      description: 'Se déclarer absent (AFK)', permissions: [], audit: false, slash: { group: 'util', name: 'afk' },
      params: { raison: { type: 'string', description: 'Raison de votre absence', maxLength: 200 } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, MOD);
        if (!s.afkEnabled) throw new ActionError('Le statut AFK est désactivé sur ce serveur');
        const member = await ctx.resolve.member(guild, actor.id);
        if (!member) throw new ActionError('Seul un membre du serveur peut se mettre AFK');
        const reason = params.raison ? params.raison.replace(/@(everyone|here)/g, '@​$1') : null;
        const existing = afkCache.get(afkKey(guild.id, member.id));
        let nickChanged = existing?.nick_changed || 0; let oldNick = existing?.old_nick ?? member.nickname ?? null;
        if (!existing && s.afkNickname && member.manageable && ctx.botCan(guild, ['ManageNicknames']) && !member.displayName.startsWith('[AFK]')) {
          const ok = await member.setNickname(`[AFK] ${member.displayName}`.slice(0, 32), 'Statut AFK').then(() => true).catch(() => false);
          if (ok) { nickChanged = 1; oldNick = member.nickname === null ? null : oldNick; }
        }
        const since = Date.now();
        ctx.db.prepare('INSERT INTO ut_afk (guild_id, user_id, reason, old_nick, nick_changed, mentions, pings, since) VALUES (?, ?, ?, ?, ?, 0, \'[]\', ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, since = excluded.since')
          .run(guild.id, member.id, reason, oldNick, nickChanged, since);
        const row = ctx.db.prepare('SELECT * FROM ut_afk WHERE guild_id = ? AND user_id = ?').get(guild.id, member.id);
        afkCache.set(afkKey(guild.id, member.id), { ...row, pings: safeParse(row.pings, []) });
        return { message: `💤 ${member} est maintenant AFK${reason ? ` : ${reason}` : ''}.\nLe statut sera retiré à votre prochain message.`, data: { userId: member.id, reason, since } };
      },
    },
    afk_remove: {
      description: "Retirer le statut AFK d'un membre", slash: false, permissions: ['ManageNicknames'],
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params }) {
        const row = await removeAfk(ctx, guild, params.user);
        if (!row) throw new ActionError("Ce membre n'est pas AFK");
        return { message: `Statut AFK retiré pour <@${params.user}>.`, data: { userId: params.user } };
      },
    },
    snipe: {
      description: 'Voir le dernier message supprimé du salon', permissions: [], audit: false, slash: { group: 'util', name: 'snipe' },
      params: { position: { type: 'integer', description: 'Position (1 = plus récent, max 10)', min: 1, max: 10, default: 1 }, channel: { type: 'channel', description: 'Salon (défaut : courant)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, actor, params, channel }) {
        return snipeRun(ctx, guild, actor, params, channel, 'deleted');
      },
    },
    editsnipe: {
      description: 'Voir le dernier message modifié du salon', slash: { group: 'util', name: 'editsnipe' }, permissions: [], audit: false,
      params: { position: { type: 'integer', description: 'Position (1 = plus récent, max 10)', min: 1, max: 10, default: 1 }, channel: { type: 'channel', description: 'Salon (défaut : courant)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, actor, params, channel }) {
        return snipeRun(ctx, guild, actor, params, channel, 'edited');
      },
    },
  },

  api(router, ctx) {
    router.get('/afk', async (request) => ({ ok: true, afk: ctx.db.prepare('SELECT guild_id, user_id, reason, mentions, since FROM ut_afk WHERE guild_id = ? ORDER BY since DESC').all(request.guild.id) }));
    router.get('/weather', async (request) => ({ ok: true, watches: ctx.db.prepare('SELECT * FROM ut_weather_watch WHERE guild_id = ? ORDER BY id').all(request.guild.id) }));
    router.get('/snipes/:channelId', async (request) => {
      const s = ctx.settings.get(request.guild.id, MOD);
      const maxAge = (s.snipeMaxAgeMinutes || 0) * 60000;
      return { ok: true, deleted: getSnipes('deleted', request.params.channelId, maxAge), edited: getSnipes('edited', request.params.channelId, maxAge) };
    });
  },

  panel: {
    views: [
      { id: 'afk', title: 'Membres AFK', endpoint: 'afk', key: 'afk', columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'reason', label: 'Raison' }, { key: 'mentions', label: 'Mentions', type: 'number' }, { key: 'since', label: 'Depuis', type: 'date' }], rowActions: [{ label: 'Retirer', action: 'afk_remove', params: { user: '{{user_id}}' }, confirm: true }] },
      { id: 'weather', title: 'Alertes météo', endpoint: 'weather', key: 'watches', columns: [{ key: 'id', label: '#' }, { key: 'city', label: 'Ville' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'last_check_at', label: 'Dernière vérification', type: 'date' }, { key: 'last_alert_at', label: 'Dernière alerte', type: 'date' }, { key: 'created_at', label: 'Créée', type: 'date' }], rowActions: [{ label: 'Supprimer', action: 'weather_watch_remove', params: { id: '{{id}}' }, confirm: true, danger: true }], createAction: 'weather_watch_add' },
    ],
  },
};

async function snipeRun(ctx, guild, actor, params, channel, kind) {
  const s = ctx.settings.get(guild.id, MOD);
  if (!s.snipeEnabled) throw new ActionError('La fonction snipe est désactivée sur ce serveur');
  const ch = await resolveTextChannel(ctx, guild, params.channel, channel);
  if (!ch) throw new ActionError('Salon introuvable');
  if (actor.source === 'discord') {
    const member = actor.member?.permissions ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
    if (!member || !ch.permissionsFor(member)?.has(PermissionsBitField.Flags.ViewChannel)) throw new ActionError('Vous ne pouvez pas voir ce salon');
  }
  const list = getSnipes(kind, ch.id, (s.snipeMaxAgeMinutes || 0) * 60000);
  if (!list.length) throw new ActionError(kind === 'deleted' ? 'Aucun message supprimé récemment dans ce salon' : 'Aucun message modifié récemment dans ce salon');
  const idx = Math.min(params.position || 1, list.length);
  const entry = list[idx - 1];
  return { embed: snipeEmbed(entry, idx, list.length, kind), data: entry };
}

export { actorHas };
