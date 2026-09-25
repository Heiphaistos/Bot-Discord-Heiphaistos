# HeiphaisBot — Conventions de développement des modules

Ce document est la référence pour écrire un module. **Lisez aussi** `src/modules/moderation/index.js` (module de référence complet) et `src/modules/admin/index.js`, ainsi que `src/core/actions.js`, `src/core/context.js`, `src/core/utils.js`.

## Principe fondamental : une ACTION = commande slash + API REST + CLI + panel
Chaque fonctionnalité est une **action** déclarée une seule fois dans `module.actions`. Le noyau génère automatiquement :
- la commande slash Discord (`/nom` ou `/groupe nom` ou `/groupe sousgroupe nom`),
- la route REST `POST /api/guilds/:guildId/actions/<module>/<action>` (body `{ params: {...} }`),
- la commande CLI `heiphais run <guild> <module> <action> k=v`,
- le formulaire dans le panel web (à partir de `params`).
Une commande texte `!nom args` est aussi générée automatiquement.

## Structure d'un module : `src/modules/<name>/index.js` (ESM, `export default {...}`)
```js
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, COLORS, renderTemplate, templateVars } from '../../core/utils.js';

export default {
  name: 'leveling',                // = nom du dossier, [a-z0-9_-]
  label: 'Niveaux', description: '…', category: 'community', icon: '📈',
  // category ∈ general | moderation | community | utility | fun | music | economy | integrations | system | gaming | security
  defaultEnabled: true,            // false pour les modules optionnels (musique, sysadmin, gaming…)
  core: false,                     // true = jamais désactivable (réservé à admin)
  priority: 100,                   // ordre d'exécution des handlers d'évènements et de init (plus petit = plus tôt ; défaut 100)
  defaultPermissions: ['ManageGuild'], // optionnel : permissions par défaut des actions qui n'en déclarent pas
  slashGroups: { xp: 'Gestion de l\'XP', 'eco.shop': 'Boutique' }, // descriptions des groupes / sous-groupes
  settings: { /* schéma des paramètres par serveur, voir ci-dessous */ },
  migrations: [ `CREATE TABLE IF NOT EXISTS lv_users (...)` ], // SQL, versionné par index (n'éditez jamais une migration existante, ajoutez-en une)
  actions: { /* voir ci-dessous */ },
  commands: [ { data: new SlashCommandBuilder()..., execute(interaction, ctx) {} } ], // RARE : seulement pour UX spéciale (modal direct). Préférez actions.
  contextMenus: [ { data: new ContextMenuCommandBuilder()..., execute(interaction, ctx) {} } ], // menu clic droit (ex: traduire)
  components: { close: async (interaction, ctx, args) => {} }, // boutons/selects/modals : customId = `<module>:<handler>:<arg1>:<arg2>`
  events: [ { name: 'messageCreate', guildScoped: true, async execute(ctx, message) {} } ], // évènements discord.js ; ignorés si module désactivé sur le serveur (guildScoped)
  jobs: { end: async (ctx, job) => {} },  // handlers du planificateur : job = { id, guild_id, payload, run_at, repeat_ms }
  textCommands: [ { name: 'tag', aliases: [], execute(message, args, ctx) {} } ], // commandes préfixées spéciales (optionnel)
  api(router, ctx) { router.get('/items', async (request) => ({ ok: true, items: [] })); }, // routes REST authentifiées sous /api/guilds/:guildId/<module>/ ; request.guild et request.auth disponibles
  publicApi(router, ctx) { router.post('/in/:id', async (request, reply) => {}); }, // routes PUBLIQUES sous /api/public/<module>/ (webhooks entrants : vérifiez un secret !)
  panel: { views: [ /* vues tabulaires du panel, voir ci-dessous */ ] },
  async init(ctx) {}, // appelé au démarrage (avant login Discord). Pour des tâches périodiques, utilisez ctx.scheduler avec repeat_ms (idempotent : vérifiez avec ctx.scheduler.find avant de créer).
  async onSettingsChange(ctx, guild, newSettings, oldSettings) {}, // optionnel
};
```

## Schéma des `settings` (paramètres par serveur)
```js
settings: {
  logChannel: { type: 'channel', label: 'Salon des logs', description: '…', channelTypes: ['GuildText'] },
  enabled: { type: 'boolean', label: '…', default: true },
  xpRate: { type: 'number', label: '…', default: 1, min: 0, max: 10 },
  cooldown: { type: 'integer', label: '…', default: 60 },
  roles: { type: 'list', label: 'Rôles', itemType: 'role', default: [] },   // list = tableau de chaînes ; itemType ∈ role | channel | user | string
  mode: { type: 'choice', label: '…', choices: [{ name: 'Simple', value: 'simple' }, { name: 'Embed', value: 'embed' }], default: 'simple' },
  template: { type: 'text', label: '…', default: 'Bienvenue {user.mention} !' }, // text = multi-ligne
  rewards: { type: 'json', label: '…', default: {} },
  muteRole: { type: 'role', label: '…' }, apiKey: { type: 'string', label: '…', secret: true },
}
```
Types : `string | text | integer | number | boolean | channel | role | user | list | choice | json | color | duration`. `label` obligatoire. `group: 'Nom'` optionnel pour regrouper dans le panel.
Lecture : `const s = ctx.settings.get(guild.id, 'monmodule')` (valeurs par défaut fusionnées). Écriture : `ctx.settings.set(guild.id, 'monmodule', { key: value })`.

## Schéma d'une action
```js
actions: {
  rank: {
    description: 'Afficher le rang d\'un membre',   // obligatoire
    slash: { name: 'rank' },                         // défaut : { name: <clé de l'action> } ; { group: 'xp', name: 'add' } → /xp add ; { group:'eco', subgroup:'shop', name:'buy' } → /eco shop buy ; false = pas de commande slash ; dm: true = utilisable en MP
    permissions: [],                                 // OBLIGATOIRE : [] = public ; ['ManageGuild'] = permissions Discord (noms PermissionsBitField.Flags) ; 'owner' = propriétaire du bot uniquement
    botPermissions: ['ManageRoles'],                 // optionnel : permissions requises pour le bot
    params: {
      user: { type: 'user', description: 'Membre', required: false },
      amount: { type: 'integer', description: 'Montant', required: true, min: 1, max: 1000000 },
      reason: { type: 'string', description: '…', maxLength: 500 },
      mode: { type: 'choice', description: '…', choices: [{ name: 'Ajouter', value: 'add' }, { name: 'Retirer', value: 'remove' }], default: 'add' },
      duration: { type: 'duration', description: 'Durée (10m, 2h, 1d)' },   // reçu en millisecondes (nombre)
      channel: { type: 'channel', description: '…', channelTypes: ['GuildText', 'GuildVoice'] },
      role: { type: 'role', description: '…' }, text: { type: 'text', description: 'Long texte' },
      color: { type: 'color', description: '#hex' /* reçu en nombre */ }, data: { type: 'json', description: '…' }, ids: { type: 'list', description: 'Séparés par des virgules' },
      query: { type: 'string', description: '…', autocomplete: true },
    },
    // Types : string text integer number boolean user member channel role mentionable duration attachment json list choice date color
    // NOTE : user/member/channel/role sont reçus comme ID (string). Résolvez avec ctx.resolve.member(guild, id) / ctx.resolve.user(id) / ctx.resolve.channel(guild, id) / ctx.resolve.role(guild, id)
    // Clés des params : minuscules [a-z0-9_], max 32 caractères.
    ephemeral: true,      // réponse visible uniquement par l'auteur
    defer: false,         // NE PAS différer (obligatoire si l'action affiche une modal via interaction.showModal). Défaut : différé.
    cooldown: 5,          // secondes, par utilisateur (optionnel)
    guildOnly: false,     // défaut true ; false = utilisable via API sans serveur et en MP si slash.dm
    audit: false,         // défaut true = journalise dans audit_log (mettez false pour les commandes de lecture/fun fréquentes)
    hidden: true,         // masqué du /help
    async run(ctx, { guild, actor, params, interaction, channel, source }) {
      // guild : Guild discord.js (null si guildOnly:false et pas de serveur)
      // actor : { id, tag, source: 'discord'|'web'|'cli'|'system', member?: GuildMember (Discord uniquement), user?, isOwner }
      // interaction : ChatInputCommandInteraction si source Discord slash, sinon null → NE COMPTEZ JAMAIS dessus pour la logique métier ; utilisez-le uniquement pour des UX optionnelles (modal, collecteur) avec `if (interaction)`.
      // channel : salon d'origine (slash/texte) ou celui fourni via l'API (peut être null)
      // Erreurs utilisateur : throw new ActionError('Message clair')
      return { message: 'Fait !' };                         // → embed vert ✅ / JSON { ok, message }
      // return { info: true, message: '…' }                // embed bleu sans ✅
      // return { embed: embed({ title, description, fields, color, thumbnail, image, footer, timestamp }), data: {...} }  // data = retour JSON structuré pour API/CLI (TOUJOURS fournir data pour les actions de lecture/listing)
      // return { embeds: [...], components: [row], files: [{ attachment: buffer, name: 'x.png' }], content: '…', plain: true /* message texte brut */, ephemeral: true }
      // return { handled: true }  // vous avez répondu vous-même à l'interaction (modal, etc.)
    },
    autocomplete: (ctx, { interaction, guild, value, param }) => [{ name, value }], // optionnel (ou par param : params.x.autocomplete = fn)
  },
}
```
Une action peut en appeler une autre : `await ctx.actions.run({ module, action, guildId, actor, params, skipPermissions: true, audit: false })`.

## Contexte `ctx` (disponible partout)
- `ctx.client` (discord.js Client), `ctx.db` (better-sqlite3 : `ctx.db.prepare(sql).get/all/run`), `ctx.config` (voir `src/config.js`), `ctx.log('module')` (pino), `ctx.settings`, `ctx.scheduler`, `ctx.bus`, `ctx.modules`, `ctx.utils`, `ctx.resolve`, `ctx.cache` (Map mémoire).
- `ctx.sendLog(guild, 'module', embedOrPayload, settingKey='logChannel')` : envoie dans le salon de log du module (repli sur `logs.defaultChannel`).
- `ctx.scheduler.schedule({ guildId, module, type, runAt: Date.now()+ms, repeatMs?, payload })` → id ; `cancel(id)` ; `cancelWhere(module, type, guildId, (payload) => bool)` ; `find(module, type, guildId, predicate)`. Les jobs survivent aux redémarrages (SQLite). Handlers dans `module.jobs`.
- `ctx.bus.publish('event', payload)` / `ctx.bus.on('event', fn)` : évènements internes. Évènements standards : `modAction, memberJoin, memberLeave, ticketOpen, ticketClose, giveawayEnd, levelUp, suggestionNew, raidDetected, automodTrigger, backupCreated, archiveCreated, verificationPassed, pollEnd, reminder, action, custom`. Le module `integrations` relaie ces évènements vers ForgeHook/webhooks sortants ; publiez donc les évènements métier importants.
- `ctx.utils` : `parseDuration, formatDuration, embed, successEmbed, errorEmbed, infoEmbed, renderTemplate, templateVars, chunk, truncate, codeBlock, isOwner, randomInt, pick, shuffle, sleep, discordTimestamp, escapeMarkdown, progressBar, safeJsonParse, extractId, COLORS`.
- `ctx.botCan(guild, ['ManageRoles'])`, `ctx.getPrefix(guildId)`, `ctx.audit.list(guildId, opts)`.
- `await ctx.modCase(guild, { type, userId, userTag, moderator: actor, reason, durationMs, extra, log })` : crée un cas dans `mod_cases` (module moderation) depuis n'importe quel module.
- Les routes publiques acceptent `application/json` et `application/x-www-form-urlencoded` (formulaires HTML).
- Templates : `renderTemplate('Bienvenue {user.mention} sur {server.name}', templateVars({ user, member, guild, channel, extra }))`.

## Base de données
- Préfixez vos tables par le nom du module (`lv_users`, `eco_accounts`, `tk_tickets`). Colonnes `guild_id TEXT`, `user_id TEXT`, timestamps en ms (`INTEGER`). Toujours `CREATE TABLE IF NOT EXISTS`.
- Données globales (multi-serveurs) possibles (ex : liste noire globale).
- Fichiers : écrivez dans `ctx.config.dataDir` (sous-dossier par module, `fs.mkdirSync(..., { recursive: true })`).

## Composants (boutons, selects, modals)
customId = `'<module>:<handler>:<args...>'` (max 100 caractères). Handler dans `components`. Exemple : `new ButtonBuilder().setCustomId('tickets:close:42')`. Dans le handler : `interaction.deferUpdate()` / `interaction.reply({ flags: MessageFlags.Ephemeral })` / `interaction.showModal(modal)`. Les modals utilisent le même format de customId et le même dispatcher.

## Panel web (`panel.views`) — vues tabulaires génériques
```js
panel: { views: [ {
  id: 'cases', title: 'Cas', endpoint: 'cases', key: 'cases',   // GET /api/guilds/:g/<module>/<endpoint> doit renvoyer { ok, <key>: [...] } (défini dans `api`)
  columns: [{ key: 'case_number', label: '#' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'active', label: 'Actif', type: 'boolean' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'role_id', type: 'role' }, { key: 'amount', type: 'number' }, { key: 'url', type: 'link' }],
  rowActions: [ { label: 'Supprimer', action: 'case_delete', params: { case_number: '{{case_number}}' }, confirm: true, danger: true }, { label: 'Modifier', action: 'case_reason', params: { case_number: '{{case_number}}' }, prompt: ['reason'] } ], // prompt = params demandés à l'utilisateur
  quickActions: ['ban', 'kick'],   // actions du module affichées comme boutons-formulaires au-dessus de la table
  createAction: 'item_add',        // optionnel : bouton "Créer" ouvrant le formulaire de cette action
} ] }
```
Les vues sont facultatives mais **recommandées pour toute donnée listable** (tickets, items, feeds, hooks…). Le panel affiche aussi automatiquement le formulaire des paramètres (`settings`) et toutes les actions du module.

## Budget de commandes slash (limite Discord : 100 commandes top-level)
Règle : **un module = un groupe top-level portant son nom** (`slash: { group: '<module>', name }`, sous-groupes via `subgroup`), sauf les quelques commandes « historiques » ci-dessous qui restent au premier niveau pour l'ergonomie :
`help`, `module`, `settings`, `bot` (admin) · `ban`, `unban`, `kick`, `timeout`, `purge`, `warn`, `case`, `role`, `mod` (moderation) · `verify` (antiraid) · `report` (modtools) · `suggest` (suggestions) · `balance`, `daily`, `work`, `eco` (economy) · `rank`, `leaderboard`, `xp` (leveling) · `play`, `skip`, `stop`, `queue`, `music` (music) · `userinfo`, `avatar`, `translate`, `weather`, `util` (utility) · `fun`, `game` (fun) · `ticket`, `ticketadmin` (tickets) · `tag` (customcommands) · `sys`, `proxmox` (sysadmin) · `hooks`, `integration` (integrations) · `mc`, `gaming` (gaming) · `roll` (tabletop) · `apply` (applications) · `db` (dbadmin) · `text` (textutils) · `dev` (devtools) · `vc` (voice) · `guard` (serverguard) · `sanction` (sanctions) · `feed` (feeds) · `announce`, `remind`, `poll`, `giveaway`, `quote`, `xp`…
Tout nouveau module n'a droit qu'à **un seul** groupe. `npm run check` échoue au-delà de 100 commandes top-level ; un groupe accepte 25 entrées (sous-commandes + sous-groupes) et 8000 caractères de texte.

## Règles
1. **Tout en français** (messages utilisateur, labels). Code et identifiants en anglais.
2. **Jamais de dépendance à `interaction` pour la logique** : une action doit fonctionner via l'API/CLI (interaction null). Les flux interactifs (modals, collecteurs) sont un plus optionnel derrière `if (interaction)`; sinon prenez les infos via `params`.
3. **Aucune nouvelle dépendance npm** sans nécessité absolue. Disponibles : discord.js, @discordjs/voice (+ opusscript, libsodium, @snazzah/davey, ffmpeg-static), better-sqlite3, fastify, @napi-rs/canvas, qrcode, jsqr, fast-xml-parser, pino. Node ≥ 20 : `fetch`, `node:crypto`, `node:dns`, `node:net`, `node:tls`, `node:child_process`, `node:os` disponibles. Outils système optionnels via `child_process` (yt-dlp, docker, ping, traceroute, nmap, whois, sensors) : détectez leur absence et renvoyez une ActionError explicite.
4. **APIs externes / clés** : configurables via `settings` (`{ type:'string', secret:true }`) ET/OU variables d'environnement (`ctx.config` ou `process.env.X`). Si la clé est absente → `ActionError('Configurez … dans les paramètres du module ou la variable X')`. Privilégiez les APIs gratuites sans clé quand elles existent (Open-Meteo, frankfurter.app, coingecko, memegen.link, rdap.org, Modrinth, CheapShark, Epic freebies, dog.ceo, thecatapi, api.quotable.io…). Timeout de 10 s sur tous les fetch (`AbortSignal.timeout(10000)`).
5. **Sécurité** : vérifiez les hiérarchies de rôles, limitez les commandes système au propriétaire (`permissions: 'owner'`), validez les entrées, secrets HMAC pour les webhooks entrants, jamais d'exécution shell arbitraire (allowlist).
6. **Robustesse** : `try/catch` autour des appels Discord non critiques (`.catch(() => null)`), jamais de crash sur données manquantes, respect des limites (embeds 4096/1024, 25 champs, bulkDelete 14 jours, renommage de salon 2/10 min).
7. **Performances** : préparez les requêtes SQL, cache mémoire léger si besoin, pas de polling agressif (planificateur ≥ 60 s pour les flux).
8. **Chaque action retourne `data`** (objet JSON sérialisable) quand elle produit des informations, pour que l'API et la CLI soient utiles.
9. Exécutez `npm run check` (charge tous les modules, valide les schémas, teste l'API). Tout doit passer. Utilisez `node src/scripts/check.js --only=monmodule` pour isoler.
10. Testez la logique pure hors Discord quand c'est possible (petit script Node temporaire dans `/tmp`, jamais commité).
