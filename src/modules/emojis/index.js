import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StickerFormatType } from 'discord.js';
import crypto from 'node:crypto';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, discordTimestamp, truncate, pick, COLORS } from '../../core/utils.js';
import { downloadImage } from './net.js';
import { renderEmojiGrid, renderUnicodeBig, twemojiUrls } from './render.js';

const CUSTOM_RE = /<(a?):(\w{2,32}):(\d{17,21})>/g;
const EMOJI_SLOTS = [50, 100, 150, 250];
const STICKER_SLOTS = [5, 15, 30, 60];
const TYPE_CHOICES = [{ name: 'Tous', value: 'all' }, { name: 'Statiques', value: 'static' }, { name: 'Animés', value: 'animated' }];
const PAGE = 30;
const PENDING_TTL = 5 * 60000;

export default {
  name: 'emojis',
  label: 'Emojis',
  description: 'Emojis et stickers : ajout, vol, packs, verrouillage par rôle, statistiques d\'utilisation, nettoyage, agrandissement.',
  category: 'general',
  icon: '😀',
  defaultEnabled: true,
  slashGroups: { emojis: 'Gestion des emojis et stickers', 'emojis.stickers': 'Gestion des stickers', 'emojis.pack': 'Packs d\'emojis (export / import)' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
    trackUsage: { type: 'boolean', label: 'Suivre l\'utilisation dans les messages', default: true },
    trackReactions: { type: 'boolean', label: 'Suivre l\'utilisation en réaction', default: true },
    maxPerMessage: { type: 'integer', label: 'Occurrences max comptées par emoji et par message', default: 3, min: 1, max: 50 },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS em_usage (guild_id TEXT NOT NULL, emoji_id TEXT NOT NULL, emoji_name TEXT, animated INTEGER DEFAULT 0, message_count INTEGER DEFAULT 0, reaction_count INTEGER DEFAULT 0, first_used_at INTEGER, last_used_at INTEGER, PRIMARY KEY (guild_id, emoji_id));
     CREATE INDEX IF NOT EXISTS idx_em_usage_last ON em_usage(guild_id, last_used_at);`,
  ],
  actions: {
    list: {
      description: 'Lister les emojis du serveur', slash: { group: 'emojis', name: 'list' }, permissions: [], audit: false, cooldown: 5,
      params: { type: { type: 'choice', choices: TYPE_CHOICES, default: 'all', description: 'Type' }, page: { type: 'integer', min: 1, default: 1, description: 'Page' }, grid: { type: 'boolean', description: 'Image en grille' } },
      async run(ctx, { guild, params }) {
        const list = filterType([...(await guild.emojis.fetch().catch(() => guild.emojis.cache)).values()], params.type).sort((a, b) => a.name.localeCompare(b.name));
        const tier = guild.premiumTier || 0;
        const counts = `${guild.emojis.cache.filter((e) => !e.animated).size}/${EMOJI_SLOTS[tier]} statiques • ${guild.emojis.cache.filter((e) => e.animated).size}/${EMOJI_SLOTS[tier]} animés`;
        const pages = Math.max(1, Math.ceil(list.length / (params.grid ? 100 : PAGE)));
        const page = Math.min(params.page, pages);
        const slice = list.slice((page - 1) * (params.grid ? 100 : PAGE), page * (params.grid ? 100 : PAGE));
        const data = { total: list.length, page, pages, emojis: slice.map(emojiData) };
        if (params.grid) {
          const png = await renderEmojiGrid(slice.map((e) => ({ name: e.name, url: e.imageURL({ extension: 'png', size: 64 }) })), { title: `${guild.name} — ${list.length} emoji(s)` });
          return { embed: embed({ title: `Emojis (${list.length}) — page ${page}/${pages}`, image: 'attachment://emojis.png', footer: counts }), files: [{ attachment: png, name: 'emojis.png' }], data };
        }
        const text = slice.map((e) => `${e} \`:${e.name}:\``).join(' ');
        return { embed: embed({ title: `Emojis (${list.length}) — page ${page}/${pages}`, description: truncate(text || 'Aucun emoji.', 4096), footer: counts }), data };
      },
    },
    add: {
      description: 'Ajouter un emoji (URL ou fichier)', slash: { group: 'emojis', name: 'add' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { name: { type: 'string', required: true, minLength: 2, maxLength: 32, description: 'Nom' }, url: { type: 'string', maxLength: 500, description: 'URL de l\'image' }, attachment: { type: 'attachment', description: 'Fichier image' }, roles: { type: 'list', description: 'Réservé à ces rôles (IDs)' } },
      async run(ctx, { guild, actor, params }) {
        const src = params.attachment || params.url;
        if (!src) throw new ActionError('Fournissez une URL ou un fichier');
        const name = cleanName(params.name);
        const img = await downloadImage(src, { maxBytes: 256 * 1024 });
        checkSlots(guild, img.ext === 'gif');
        const roles = (params.roles || []).map((r) => ctx.utils.extractId(r)).filter((id) => id && guild.roles.cache.has(id));
        const emoji = await guild.emojis.create({ attachment: img.dataUri, name, roles: roles.length ? roles : undefined, reason: auditReason(actor, 'Ajout d\'emoji') }).catch((err) => { throw new ActionError(`Création impossible : ${err.message}`); });
        await logEm(ctx, guild, `➕ Emoji ${emoji} \`:${emoji.name}:\` ajouté par ${actor.tag || actor.id}.`);
        return { message: `Emoji ${emoji} \`:${emoji.name}:\` ajouté.`, data: emojiData(emoji) };
      },
    },
    steal: {
      description: 'Copier des emojis d\'un autre serveur', slash: { group: 'emojis', name: 'steal' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { emojis: { type: 'string', required: true, maxLength: 1000, description: 'Emoji(s) <:nom:id> ou ID' }, name: { type: 'string', maxLength: 32, description: 'Nouveau nom (si un seul)' } },
      async run(ctx, { guild, actor, params }) {
        const found = [...params.emojis.matchAll(CUSTOM_RE)].map((m) => ({ animated: !!m[1], name: m[2], id: m[3] }));
        if (!found.length) { const id = params.emojis.match(/^\d{17,21}$/)?.[0]; if (id) found.push({ id, name: `emoji_${id.slice(-5)}`, animated: null }); }
        const unique = [...new Map(found.map((e) => [e.id, e])).values()].slice(0, 10);
        if (!unique.length) throw new ActionError('Aucun emoji personnalisé trouvé (format <:nom:id> ou ID)');
        const added = []; const failed = [];
        for (const e of unique) {
          try {
            if (guild.emojis.cache.has(e.id)) throw new ActionError('déjà sur ce serveur');
            let img;
            if (e.animated === null) img = await downloadImage(`https://cdn.discordapp.com/emojis/${e.id}.gif`).catch(() => downloadImage(`https://cdn.discordapp.com/emojis/${e.id}.png`));
            else img = await downloadImage(`https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}`);
            checkSlots(guild, img.ext === 'gif');
            const name = cleanName(unique.length === 1 && params.name ? params.name : e.name);
            const emoji = await guild.emojis.create({ attachment: img.dataUri, name, reason: auditReason(actor, 'Emoji copié') });
            added.push(emoji);
          } catch (err) { failed.push(`\`${e.name}\` : ${err.message}`); }
        }
        if (added.length) await logEm(ctx, guild, `📥 ${added.length} emoji(s) copié(s) par ${actor.tag || actor.id} : ${added.join(' ')}`);
        if (!added.length) throw new ActionError(`Aucun emoji ajouté.\n${failed.join('\n')}`);
        return { message: `${added.length} emoji(s) ajouté(s) : ${added.join(' ')}${failed.length ? `\n❌ ${failed.join('\n')}` : ''}`, data: { added: added.map(emojiData), failed } };
      },
    },
    rename: {
      description: 'Renommer un emoji', slash: { group: 'emojis', name: 'rename' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { emoji: { type: 'string', required: true, maxLength: 100, description: 'Emoji', autocomplete: true }, name: { type: 'string', required: true, minLength: 2, maxLength: 32, description: 'Nouveau nom' } },
      async run(ctx, { guild, actor, params }) {
        const emoji = await requireEmoji(guild, params.emoji);
        const old = emoji.name;
        await emoji.edit({ name: cleanName(params.name), reason: auditReason(actor, 'Renommage') });
        ctx.db.prepare('UPDATE em_usage SET emoji_name = ? WHERE guild_id = ? AND emoji_id = ?').run(emoji.name, guild.id, emoji.id);
        return { message: `Emoji ${emoji} renommé : \`${old}\` → \`${emoji.name}\`.`, data: emojiData(emoji) };
      },
      autocomplete: emojiAutocomplete,
    },
    delete: {
      description: 'Supprimer un emoji', slash: { group: 'emojis', name: 'delete' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { emoji: { type: 'string', required: true, maxLength: 100, description: 'Emoji', autocomplete: true }, reason: { type: 'string', maxLength: 300, description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const emoji = await requireEmoji(guild, params.emoji);
        const info = emojiData(emoji);
        await emoji.delete(auditReason(actor, params.reason));
        ctx.db.prepare('DELETE FROM em_usage WHERE guild_id = ? AND emoji_id = ?').run(guild.id, info.id);
        await logEm(ctx, guild, `🗑️ Emoji \`:${info.name}:\` supprimé par ${actor.tag || actor.id}.`);
        return { message: `Emoji \`:${info.name}:\` supprimé.`, data: info };
      },
      autocomplete: emojiAutocomplete,
    },
    info: {
      description: 'Informations sur un emoji', slash: { group: 'emojis', name: 'info' }, permissions: [], audit: false,
      params: { emoji: { type: 'string', required: true, maxLength: 100, description: 'Emoji', autocomplete: true } },
      async run(ctx, { guild, params }) {
        const emoji = await resolveEmoji(guild, params.emoji);
        if (!emoji) {
          const m = [...params.emoji.matchAll(CUSTOM_RE)][0];
          if (!m) throw new ActionError('Emoji introuvable');
          const url = `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? 'gif' : 'png'}?size=256`;
          return { embed: embed({ title: `:${m[2]}:`, thumbnail: url, fields: [{ name: 'ID', value: `\`${m[3]}\``, inline: true }, { name: 'Animé', value: m[1] ? 'Oui' : 'Non', inline: true }, { name: 'Serveur', value: 'Externe', inline: true }, { name: 'Lien', value: `[Image](${url})`, inline: true }] }), data: { id: m[3], name: m[2], animated: !!m[1], external: true, url } };
        }
        const author = await emoji.fetchAuthor().catch(() => null);
        const usage = ctx.db.prepare('SELECT * FROM em_usage WHERE guild_id = ? AND emoji_id = ?').get(guild.id, emoji.id);
        return { embed: embed({ title: `:${emoji.name}:`, thumbnail: emoji.imageURL({ size: 256 }), fields: [
          { name: 'ID', value: `\`${emoji.id}\``, inline: true }, { name: 'Animé', value: emoji.animated ? 'Oui' : 'Non', inline: true }, { name: 'Créé', value: discordTimestamp(emoji.createdTimestamp, 'D'), inline: true },
          { name: 'Ajouté par', value: author ? author.tag : '—', inline: true }, { name: 'Géré', value: emoji.managed ? 'Oui (intégration)' : 'Non', inline: true },
          { name: 'Utilisations', value: usage ? `${usage.message_count} message(s) • ${usage.reaction_count} réaction(s)\nDernière : ${usage.last_used_at ? discordTimestamp(usage.last_used_at) : '—'}` : 'Jamais vue', inline: true },
          { name: 'Rôles autorisés', value: emoji.roles.cache.size ? emoji.roles.cache.map((r) => `${r}`).join(', ') : 'Tout le monde' },
          { name: 'Syntaxe', value: `\`${emoji}\`` },
        ] }), data: { ...emojiData(emoji), author: author ? { id: author.id, tag: author.tag } : null, usage: usage || null } };
      },
      autocomplete: emojiAutocomplete,
    },
    big: {
      description: 'Afficher un emoji en grand', slash: { group: 'emojis', name: 'big' }, permissions: [], audit: false, cooldown: 3,
      params: { emoji: { type: 'string', required: true, maxLength: 100, description: 'Emoji (personnalisé ou Unicode)' } },
      async run(ctx, { guild, params }) {
        const m = [...params.emoji.matchAll(CUSTOM_RE)][0];
        const local = !m ? await resolveEmoji(guild, params.emoji) : null;
        if (m || local) {
          const id = m ? m[3] : local.id; const animated = m ? !!m[1] : local.animated; const name = m ? m[2] : local.name;
          const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=512&quality=lossless`;
          return { embed: embed({ title: `:${name}:`, url, image: url, footer: `ID : ${id}` }), data: { id, name, animated, url } };
        }
        const str = params.emoji.trim();
        if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(str) || [...str].length > 12) throw new ActionError('Emoji non reconnu');
        const urls = twemojiUrls(str);
        const png = await renderUnicodeBig(str, 512).catch(() => null);
        if (png) return { embed: embed({ title: str, image: 'attachment://emoji.png' }), files: [{ attachment: png, name: 'emoji.png' }], data: { unicode: str, url: urls.svg } };
        return { embed: embed({ title: str, image: urls.png }), data: { unicode: str, url: urls.png } };
      },
    },
    stats: {
      description: 'Statistiques d\'utilisation des emojis', slash: { group: 'emojis', name: 'stats' }, permissions: [], audit: false,
      params: { mode: { type: 'choice', choices: [{ name: 'Les plus utilisés', value: 'top' }, { name: 'Les moins utilisés', value: 'least' }, { name: 'Inutilisés', value: 'unused' }], default: 'top', description: 'Classement' }, days: { type: 'integer', min: 1, max: 3650, default: 30, description: 'Inutilisés depuis N jours' }, limit: { type: 'integer', min: 1, max: 50, default: 15, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const rows = usageRows(ctx, guild);
        if (params.mode === 'unused') {
          const cutoff = Date.now() - params.days * 86400000;
          const list = rows.filter((r) => (!r.last_used_at || r.last_used_at < cutoff) && r.created_at < cutoff);
          return { embed: infoEmbed(truncate(list.slice(0, 100).map((r) => `<${r.animated ? 'a' : ''}:${r.name}:${r.emoji_id}>`).join(' ') || `Tous les emojis ont servi ces ${params.days} derniers jours.`, 4096), `Emojis inutilisés depuis ${params.days} j (${list.length})`), data: { mode: 'unused', days: params.days, emojis: list } };
        }
        const sorted = rows.sort((a, b) => (params.mode === 'top' ? b.total - a.total : a.total - b.total)).slice(0, params.limit);
        const lines = sorted.map((r, i) => `\`${String(i + 1).padStart(2)}.\` <${r.animated ? 'a' : ''}:${r.name}:${r.emoji_id}> **${r.total}** (${r.message_count} msg • ${r.reaction_count} réac.)`);
        const total = rows.reduce((a, r) => a + r.total, 0);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune donnée.', `${params.mode === 'top' ? 'Emojis les plus utilisés' : 'Emojis les moins utilisés'} — ${total} utilisation(s)`), data: { mode: params.mode, total, emojis: sorted } };
      },
    },
    lock: {
      description: 'Restreindre un emoji à des rôles', slash: { group: 'emojis', name: 'lock' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { emoji: { type: 'string', required: true, maxLength: 100, description: 'Emoji', autocomplete: true }, role: { type: 'role', required: true, description: 'Rôle autorisé' }, role2: { type: 'role', description: 'Autre rôle' }, role3: { type: 'role', description: 'Autre rôle' } },
      async run(ctx, { guild, actor, params }) {
        const emoji = await requireEmoji(guild, params.emoji);
        const roles = [...new Set([params.role, params.role2, params.role3, ...emoji.roles.cache.keys()].filter((id) => id && guild.roles.cache.has(id)))];
        await emoji.edit({ roles, reason: auditReason(actor, 'Restriction par rôle') });
        return { message: `Emoji ${emoji} réservé à : ${roles.map((id) => `<@&${id}>`).join(', ')}.`, data: { ...emojiData(emoji), roles } };
      },
      autocomplete: emojiAutocomplete,
    },
    unlock: {
      description: 'Retirer la restriction de rôles d\'un emoji', slash: { group: 'emojis', name: 'unlock' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { emoji: { type: 'string', required: true, maxLength: 100, description: 'Emoji', autocomplete: true }, role: { type: 'role', description: 'Retirer seulement ce rôle' } },
      async run(ctx, { guild, actor, params }) {
        const emoji = await requireEmoji(guild, params.emoji);
        const roles = params.role ? [...emoji.roles.cache.keys()].filter((id) => id !== params.role) : [];
        await emoji.edit({ roles, reason: auditReason(actor, 'Levée de restriction') });
        return { message: roles.length ? `Emoji ${emoji} : rôles restants ${roles.map((id) => `<@&${id}>`).join(', ')}.` : `Emoji ${emoji} utilisable par tout le monde.`, data: { ...emojiData(emoji), roles } };
      },
      autocomplete: emojiAutocomplete,
    },
    cleanup: {
      description: 'Supprimer les emojis inutilisés depuis N jours', slash: { group: 'emojis', name: 'cleanup' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'], ephemeral: true,
      params: { days: { type: 'integer', required: true, min: 7, max: 3650, description: 'Jours sans utilisation' }, delete: { type: 'boolean', description: 'Supprimer (sinon simulation)' }, confirm: { type: 'boolean', description: 'Confirmer (API/CLI)' } },
      async run(ctx, { guild, actor, params, interaction }) {
        const cutoff = Date.now() - params.days * 86400000;
        const list = usageRows(ctx, guild).filter((r) => !r.managed && (!r.last_used_at || r.last_used_at < cutoff) && r.created_at < cutoff);
        if (!list.length) return { info: true, message: `Aucun emoji inutilisé depuis ${params.days} jour(s).`, data: { emojis: [] } };
        const preview = truncate(list.map((r) => `<${r.animated ? 'a' : ''}:${r.name}:${r.emoji_id}>`).join(' '), 3900);
        const trackedSince = ctx.db.prepare('SELECT MIN(first_used_at) t FROM em_usage WHERE guild_id = ?').get(guild.id).t;
        const note = trackedSince && trackedSince > cutoff ? `\n\n⚠️ Le suivi n'a commencé que ${discordTimestamp(trackedSince)} : les données peuvent être incomplètes.` : '';
        if (!params.delete) return { embed: infoEmbed(preview + note, `Emojis inutilisés depuis ${params.days} j (${list.length}) — simulation`), data: { dry: true, emojis: list } };
        if (!params.confirm) {
          if (!interaction) throw new ActionError(`${list.length} emoji(s) seraient supprimés. Relancez avec confirm=true pour confirmer.`);
          const token = crypto.randomBytes(6).toString('hex');
          ctx.cache.set(`emojis:pending:${token}`, { guildId: guild.id, userId: actor.id, ids: list.map((r) => r.emoji_id), expires: Date.now() + PENDING_TTL });
          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`emojis:cleanup:${token}:yes`).setLabel(`Supprimer ${list.length} emoji(s)`).setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`emojis:cleanup:${token}:no`).setLabel('Annuler').setStyle(ButtonStyle.Secondary));
          return { embed: embed({ color: COLORS.warning, title: `⚠️ Confirmer la suppression de ${list.length} emoji(s)`, description: preview + note, footer: 'Valable 5 minutes' }), components: [row], data: { pending: true, emojis: list } };
        }
        const deleted = await deleteEmojis(ctx, guild, actor, list.map((r) => r.emoji_id));
        return { message: `${deleted.length} emoji(s) inutilisé(s) supprimé(s).`, data: { deleted } };
      },
    },
    random: {
      description: 'Un emoji du serveur au hasard', slash: { group: 'emojis', name: 'random' }, permissions: [], audit: false,
      params: { type: { type: 'choice', choices: TYPE_CHOICES, default: 'all', description: 'Type' } },
      async run(ctx, { guild, params }) {
        const list = filterType([...guild.emojis.cache.values()].filter((e) => e.available !== false), params.type);
        if (!list.length) throw new ActionError('Aucun emoji disponible');
        const e = pick(list);
        return { embed: embed({ title: `:${e.name}:`, image: e.imageURL({ size: 256 }), description: `${e}` }), data: emojiData(e) };
      },
    },
    // ---- Packs ----
    pack_export: {
      description: 'Exporter les emojis (JSON + liste d\'URL)', slash: { group: 'emojis', subgroup: 'pack', name: 'export' }, permissions: ['ManageGuildExpressions'], ephemeral: true,
      params: { type: { type: 'choice', choices: TYPE_CHOICES, default: 'all', description: 'Type' } },
      async run(ctx, { guild, params }) {
        const list = filterType([...guild.emojis.cache.values()], params.type).sort((a, b) => a.name.localeCompare(b.name));
        if (!list.length) throw new ActionError('Aucun emoji à exporter');
        const pack = { format: 'heiphaisbot-emoji-pack', version: 1, guild: { id: guild.id, name: guild.name }, exportedAt: new Date().toISOString(), emojis: list.map((e) => ({ name: e.name, id: e.id, animated: e.animated, url: e.imageURL({ extension: e.animated ? 'gif' : 'png', size: 128 }) })) };
        const txt = pack.emojis.map((e) => `${e.name} ${e.url}`).join('\n');
        const slug = guild.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || guild.id;
        return { message: `Pack de ${list.length} emoji(s) exporté.`, files: [{ attachment: Buffer.from(JSON.stringify(pack, null, 2)), name: `emojis-${slug}.json` }, { attachment: Buffer.from(txt), name: `emojis-${slug}.txt` }], data: pack };
      },
    },
    pack_import: {
      description: 'Importer un pack d\'emojis (JSON)', slash: { group: 'emojis', subgroup: 'pack', name: 'import' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { file: { type: 'attachment', description: 'Fichier JSON' }, json: { type: 'json', description: 'Ou JSON directement' }, prefix: { type: 'string', maxLength: 10, description: 'Préfixe des noms' }, limit: { type: 'integer', min: 1, max: 100, default: 50, description: 'Nombre max' } },
      async run(ctx, { guild, actor, params }) {
        let data = params.json;
        if (!data && params.file) {
          const f = await downloadImage(params.file, { maxBytes: 2 * 1024 * 1024, allowed: ['json'] });
          try { data = JSON.parse(f.buffer.toString('utf8')); } catch { throw new ActionError('Fichier JSON invalide'); }
        }
        if (!data) throw new ActionError('Fournissez un fichier JSON ou le JSON directement');
        const items = (Array.isArray(data) ? data : data.emojis || []).filter((e) => e && (e.url || e.id)).slice(0, params.limit);
        if (!items.length) throw new ActionError('Aucun emoji dans le pack (attendu : [{ "name", "url" }] ou { "emojis": [...] })');
        const existing = new Set(guild.emojis.cache.map((e) => e.name.toLowerCase()));
        const added = []; const failed = []; const skipped = [];
        for (const it of items) {
          const name = cleanName(`${params.prefix || ''}${it.name || `emoji_${String(it.id).slice(-5)}`}`, true);
          if (existing.has(name.toLowerCase())) { skipped.push(name); continue; }
          try {
            const url = it.url || `https://cdn.discordapp.com/emojis/${it.id}.${it.animated ? 'gif' : 'png'}`;
            const img = await downloadImage(url);
            checkSlots(guild, img.ext === 'gif');
            const emoji = await guild.emojis.create({ attachment: img.dataUri, name, reason: auditReason(actor, 'Import de pack') });
            added.push(emojiData(emoji)); existing.add(name.toLowerCase());
          } catch (err) {
            failed.push(`${name} : ${err.message}`);
            if (/emplacement|slots/i.test(err.message)) break;
          }
        }
        await logEm(ctx, guild, `📦 Import de pack par ${actor.tag || actor.id} : ${added.length} ajouté(s), ${skipped.length} ignoré(s), ${failed.length} échec(s).`);
        return { message: `Import : **${added.length}** ajouté(s), ${skipped.length} déjà présent(s), ${failed.length} échec(s).${failed.length ? `\n${truncate(failed.join('\n'), 1500)}` : ''}`, data: { added, skipped, failed } };
      },
    },
    // ---- Stickers ----
    stickers_list: {
      description: 'Lister les stickers du serveur', slash: { group: 'emojis', subgroup: 'stickers', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const stickers = await guild.stickers.fetch().catch(() => guild.stickers.cache);
        const list = [...stickers.values()].map(stickerData);
        return { embed: infoEmbed(list.map((s) => `• **${s.name}** (${s.format}) — :${s.tags}: ${s.description ? `— ${truncate(s.description, 60)}` : ''} \`${s.id}\``).join('\n') || 'Aucun sticker.', `Stickers (${list.length}/${STICKER_SLOTS[guild.premiumTier || 0]})`), data: list };
      },
    },
    stickers_add: {
      description: 'Ajouter un sticker (PNG/APNG/GIF)', slash: { group: 'emojis', subgroup: 'stickers', name: 'add' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { name: { type: 'string', required: true, minLength: 2, maxLength: 30, description: 'Nom' }, tags: { type: 'string', required: true, maxLength: 200, description: 'Emoji associé (ex : 😀 ou smile)' }, url: { type: 'string', maxLength: 500, description: 'URL de l\'image' }, attachment: { type: 'attachment', description: 'Fichier (320×320, 512 Ko max)' }, description: { type: 'string', maxLength: 100, description: 'Description' } },
      async run(ctx, { guild, actor, params }) {
        const src = params.attachment || params.url;
        if (!src) throw new ActionError('Fournissez une URL ou un fichier');
        checkStickerSlots(guild);
        const img = await downloadImage(src, { maxBytes: 512 * 1024, allowed: ['png', 'gif'] });
        if (params.description && params.description.length < 2) throw new ActionError('La description doit faire au moins 2 caractères');
        const sticker = await guild.stickers.create({ file: { attachment: img.buffer, name: `sticker.${img.ext}` }, name: params.name, tags: params.tags.replace(/:/g, '').trim(), description: params.description || '', reason: auditReason(actor, 'Ajout de sticker') })
          .catch((err) => { throw new ActionError(`Création impossible : ${err.message}`); });
        await logEm(ctx, guild, `➕ Sticker **${sticker.name}** ajouté par ${actor.tag || actor.id}.`);
        return { message: `Sticker **${sticker.name}** ajouté.`, data: stickerData(sticker) };
      },
    },
    stickers_delete: {
      description: 'Supprimer un sticker', slash: { group: 'emojis', subgroup: 'stickers', name: 'delete' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { sticker: { type: 'string', required: true, maxLength: 100, description: 'Nom ou ID', autocomplete: true } },
      async run(ctx, { guild, actor, params }) {
        const stickers = await guild.stickers.fetch().catch(() => guild.stickers.cache);
        const q = params.sticker.toLowerCase();
        const s = stickers.get(params.sticker) || stickers.find((x) => x.name.toLowerCase() === q);
        if (!s) throw new ActionError('Sticker introuvable');
        const info = stickerData(s);
        await s.delete(auditReason(actor, 'Suppression de sticker'));
        return { message: `Sticker **${info.name}** supprimé.`, data: info };
      },
      autocomplete: (ctx, { guild, value }) => guild.stickers.cache.filter((s) => s.name.toLowerCase().includes(String(value).toLowerCase())).first(25).map((s) => ({ name: s.name, value: s.id })),
    },
    stickers_steal: {
      description: 'Copier un sticker (ID ou message)', slash: { group: 'emojis', subgroup: 'stickers', name: 'steal' }, permissions: ['ManageGuildExpressions'], botPermissions: ['ManageGuildExpressions'],
      params: { sticker_id: { type: 'string', maxLength: 25, description: 'ID du sticker' }, message_id: { type: 'string', maxLength: 25, description: 'Ou ID d\'un message contenant le sticker' }, channel: { type: 'channel', description: 'Salon du message' }, name: { type: 'string', minLength: 2, maxLength: 30, description: 'Nouveau nom' } },
      async run(ctx, { guild, actor, params, channel }) {
        let sticker = null;
        if (params.message_id) {
          const ch = params.channel ? ctx.resolve.channel(guild, params.channel) : channel;
          const msg = await ch?.messages?.fetch(params.message_id).catch(() => null);
          if (!msg) throw new ActionError('Message introuvable');
          sticker = msg.stickers.first();
          if (sticker) sticker = await ctx.client.fetchSticker(sticker.id).catch(() => sticker);
        } else if (params.sticker_id) sticker = await ctx.client.fetchSticker(params.sticker_id).catch(() => null);
        else throw new ActionError('Indiquez sticker_id ou message_id');
        if (!sticker) throw new ActionError('Sticker introuvable');
        if (sticker.format === StickerFormatType.Lottie) throw new ActionError('Les stickers Lottie (officiels Discord) ne peuvent pas être copiés');
        checkStickerSlots(guild);
        const ext = sticker.format === StickerFormatType.GIF ? 'gif' : 'png';
        const img = await downloadImage(`https://media.discordapp.net/stickers/${sticker.id}.${ext}`, { maxBytes: 512 * 1024, allowed: ['png', 'gif'] });
        const tags = (sticker.tags || '').split(',')[0]?.trim() || '⭐';
        const created = await guild.stickers.create({ file: { attachment: img.buffer, name: `sticker.${img.ext}` }, name: params.name || sticker.name, tags, description: sticker.description && sticker.description.length >= 2 ? sticker.description.slice(0, 100) : '', reason: auditReason(actor, 'Sticker copié') })
          .catch((err) => { throw new ActionError(`Création impossible : ${err.message}`); });
        return { message: `Sticker **${created.name}** ajouté au serveur.`, data: stickerData(created) };
      },
    },
  },
  components: {
    async cleanup(interaction, ctx, [token, decision]) {
      const key = `emojis:pending:${token}`;
      const pending = ctx.cache.get(key);
      if (!pending || pending.expires < Date.now()) { ctx.cache.delete(key); return interaction.update({ content: 'Demande expirée.', embeds: [], components: [] }); }
      if (interaction.user.id !== pending.userId) return interaction.reply({ content: 'Seul l\'auteur de la demande peut confirmer.', flags: MessageFlags.Ephemeral });
      ctx.cache.delete(key);
      if (decision !== 'yes') return interaction.update({ content: 'Suppression annulée.', embeds: [], components: [] });
      await interaction.update({ content: '⏳ Suppression en cours…', embeds: [], components: [] });
      const deleted = await deleteEmojis(ctx, interaction.guild, { id: interaction.user.id, tag: interaction.user.tag }, pending.ids);
      return interaction.editReply({ content: `✅ ${deleted.length} emoji(s) supprimé(s).` });
    },
  },
  events: [
    { name: 'messageCreate', async execute(ctx, message) {
      if (!message.guild || message.author?.bot || !message.content?.includes('<')) return;
      const s = ctx.settings.get(message.guild.id, 'emojis');
      if (!s.trackUsage) return;
      const counts = new Map();
      for (const m of message.content.matchAll(CUSTOM_RE)) {
        if (!message.guild.emojis.cache.has(m[3])) continue;
        const c = counts.get(m[3]) || { n: 0, name: m[2], animated: !!m[1] };
        c.n = Math.min(c.n + 1, s.maxPerMessage || 3);
        counts.set(m[3], c);
      }
      if (counts.size) recordUsage(ctx, message.guild.id, counts, 'message');
    } },
    { name: 'messageReactionAdd', guildScoped: false, async execute(ctx, reaction, user) {
      const emojiId = reaction?.emoji?.id;
      if (!emojiId || user?.bot) return;
      const guildId = reaction.message?.guildId || reaction.message?.guild?.id;
      const guild = guildId && ctx.client.guilds.cache.get(guildId);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'emojis') || !guild.emojis.cache.has(emojiId)) return;
      if (!ctx.settings.get(guild.id, 'emojis').trackReactions) return;
      recordUsage(ctx, guild.id, new Map([[emojiId, { n: 1, name: reaction.emoji.name, animated: !!reaction.emoji.animated }]]), 'reaction');
    } },
    { name: 'emojiDelete', async execute(ctx, emoji) { if (emoji?.guild) ctx.db.prepare('DELETE FROM em_usage WHERE guild_id = ? AND emoji_id = ?').run(emoji.guild.id, emoji.id); } },
  ],
  api(router, ctx) {
    router.get('/usage', async (request) => ({ ok: true, usage: usageRows(ctx, request.guild).sort((a, b) => b.total - a.total) }));
    router.get('/stickers', async (request) => ({ ok: true, stickers: [...(await request.guild.stickers.fetch().catch(() => request.guild.stickers.cache)).values()].map(stickerData) }));
  },
  panel: {
    views: [
      { id: 'usage', title: 'Utilisation des emojis', endpoint: 'usage', key: 'usage', columns: [{ key: 'url', label: 'Image', type: 'link' }, { key: 'name', label: 'Nom' }, { key: 'total', label: 'Total', type: 'number' }, { key: 'message_count', label: 'Messages', type: 'number' }, { key: 'reaction_count', label: 'Réactions', type: 'number' }, { key: 'last_used_at', label: 'Dernière utilisation', type: 'date' }, { key: 'animated', label: 'Animé', type: 'boolean' }], rowActions: [{ label: 'Renommer', action: 'rename', params: { emoji: '{{emoji_id}}' }, prompt: ['name'] }, { label: 'Supprimer', action: 'delete', params: { emoji: '{{emoji_id}}' }, confirm: true, danger: true }], quickActions: ['add', 'steal', 'cleanup'] },
      { id: 'stickers', title: 'Stickers', endpoint: 'stickers', key: 'stickers', columns: [{ key: 'url', label: 'Image', type: 'link' }, { key: 'name', label: 'Nom' }, { key: 'tags', label: 'Tag' }, { key: 'format', label: 'Format' }, { key: 'description', label: 'Description' }], rowActions: [{ label: 'Supprimer', action: 'stickers_delete', params: { sticker: '{{id}}' }, confirm: true, danger: true }], createAction: 'stickers_add' },
    ],
  },
};

// ---------- helpers ----------
function auditReason(actor, reason) { return `${actor?.tag || actor?.id || 'système'}: ${reason || 'Aucune raison'}`.slice(0, 512); }
async function logEm(ctx, guild, text) { await ctx.sendLog(guild, 'emojis', embed({ color: COLORS.info, description: text, timestamp: true })).catch(() => null); }
function filterType(list, type) { return type === 'static' ? list.filter((e) => !e.animated) : type === 'animated' ? list.filter((e) => e.animated) : list; }
function cleanName(name, lenient = false) {
  let n = String(name || '').replace(/:/g, '').replace(/[^\w]/g, '_').replace(/_+/g, '_').slice(0, 32);
  if (n.length < 2) { if (lenient) n = `${n}__`.slice(0, 2); else throw new ActionError('Nom invalide (2 à 32 caractères : lettres, chiffres, _)'); }
  return n;
}
function checkSlots(guild, animated) {
  const max = EMOJI_SLOTS[guild.premiumTier || 0];
  const used = guild.emojis.cache.filter((e) => !!e.animated === animated).size;
  if (used >= max) throw new ActionError(`Plus d'emplacement ${animated ? 'animé' : 'statique'} disponible (${used}/${max})`);
}
function checkStickerSlots(guild) {
  const max = STICKER_SLOTS[guild.premiumTier || 0];
  if (guild.stickers.cache.size >= max) throw new ActionError(`Plus d'emplacement de sticker disponible (${guild.stickers.cache.size}/${max})`);
}
async function resolveEmoji(guild, input) {
  const s = String(input || '').trim();
  const m = s.match(/<a?:\w+:(\d+)>/);
  const id = m ? m[1] : s.match(/^\d{17,21}$/)?.[0];
  if (id) return guild.emojis.cache.get(id) || await guild.emojis.fetch(id).catch(() => null);
  const name = s.replace(/:/g, '').toLowerCase();
  return guild.emojis.cache.find((e) => e.name.toLowerCase() === name) || null;
}
async function requireEmoji(guild, input) {
  const e = await resolveEmoji(guild, input);
  if (!e) throw new ActionError('Emoji introuvable sur ce serveur');
  if (e.managed) throw new ActionError('Cet emoji est géré par une intégration');
  return e;
}
function emojiAutocomplete(ctx, { guild, value }) {
  const q = String(value || '').replace(/:/g, '').toLowerCase();
  return guild.emojis.cache.filter((e) => e.name.toLowerCase().includes(q)).first(25).map((e) => ({ name: `:${e.name}:${e.animated ? ' (animé)' : ''}`, value: e.id }));
}
function emojiData(e) { return { id: e.id, name: e.name, animated: !!e.animated, url: e.imageURL({ size: 128 }), roles: e.roles ? [...e.roles.cache.keys()] : [], createdAt: e.createdTimestamp, managed: !!e.managed }; }
function stickerData(s) { return { id: s.id, name: s.name, tags: s.tags, description: s.description || null, format: StickerFormatType[s.format] || String(s.format), url: s.url }; }
function recordUsage(ctx, guildId, counts, kind) {
  const col = kind === 'reaction' ? 'reaction_count' : 'message_count';
  const stmt = ctx.db.prepare(`INSERT INTO em_usage (guild_id, emoji_id, emoji_name, animated, ${col}, first_used_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, emoji_id) DO UPDATE SET ${col} = ${col} + excluded.${col}, emoji_name = excluded.emoji_name, last_used_at = excluded.last_used_at`);
  const now = Date.now();
  ctx.db.transaction(() => { for (const [id, c] of counts) stmt.run(guildId, id, c.name, c.animated ? 1 : 0, c.n, now, now); })();
}
/** Tous les emojis du serveur fusionnés avec leurs statistiques d'utilisation. */
function usageRows(ctx, guild) {
  const stats = new Map(ctx.db.prepare('SELECT * FROM em_usage WHERE guild_id = ?').all(guild.id).map((r) => [r.emoji_id, r]));
  return guild.emojis.cache.map((e) => {
    const r = stats.get(e.id) || {};
    const mc = r.message_count || 0; const rc = r.reaction_count || 0;
    return { emoji_id: e.id, name: e.name, animated: !!e.animated, managed: !!e.managed, url: e.imageURL({ size: 64 }), message_count: mc, reaction_count: rc, total: mc + rc, first_used_at: r.first_used_at || null, last_used_at: r.last_used_at || null, created_at: e.createdTimestamp };
  });
}
async function deleteEmojis(ctx, guild, actor, ids) {
  const deleted = [];
  for (const id of ids) {
    const e = guild.emojis.cache.get(id);
    if (!e || e.managed) continue;
    await e.delete(auditReason(actor, 'Nettoyage des emojis inutilisés')).then(() => { deleted.push({ id, name: e.name }); ctx.db.prepare('DELETE FROM em_usage WHERE guild_id = ? AND emoji_id = ?').run(guild.id, id); }).catch(() => null);
  }
  if (deleted.length) await logEm(ctx, guild, `🧹 ${deleted.length} emoji(s) inutilisé(s) supprimé(s) par ${actor.tag || actor.id} : ${truncate(deleted.map((d) => `:${d.name}:`).join(' '), 3500)}`);
  return deleted;
}
