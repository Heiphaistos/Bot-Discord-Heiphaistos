# HeiphaisBot

**HeiphaisBot** est un bot Discord *tout-en-un* auto-hébergé (VPS), conçu pour gérer intégralement un serveur : modération, sécurité, communauté, économie/RPG, musique, utilitaires, DevOps, intégrations… Chaque fonctionnalité est disponible **de trois façons équivalentes** :

| Interface | Exemple |
|---|---|
| Commandes slash Discord | `/ban @user raison` |
| Panel web | `Modération → Actions → Bannir` |
| CLI sur le VPS (ou à distance) | `heiphais ban 1234567890 "raison" --guild 987` |

Le bot est relié à vos applications **ForgeArchive** (archivage des salons, transcripts, sauvegardes) et **ForgeHook** (relais d'évènements signés HMAC + webhooks entrants).

---

## Sommaire
1. [Architecture](#architecture)
2. [Installation sur VPS](#installation-sur-vps)
3. [Configuration](#configuration)
4. [Panel web](#panel-web)
5. [CLI `heiphais`](#cli-heiphais)
6. [API REST](#api-rest)
7. [Intégrations ForgeArchive / ForgeHook](#intégrations-forgearchive--forgehook)
8. [Modules et fonctionnalités](#modules-et-fonctionnalités)
9. [Développer un module](#développer-un-module)
10. [Exploitation](#exploitation)

---

## Architecture

```
src/
├── index.js              # Démarrage (bot + panel web)
├── config.js             # Lecture du .env
├── core/                 # Noyau : client Discord, base SQLite, paramètres, actions, planificateur, bus d'évènements
├── modules/<module>/     # Un dossier par module (actions, settings, évènements, routes API, vues panel)
├── web/                  # Serveur Fastify (OAuth2 Discord, API REST, SPA du panel dans web/public)
├── cli/heiphais.js       # CLI
└── scripts/              # check.js (auto-test), deploy-commands.js
```

* **Node.js ≥ 20** (22 recommandé), **discord.js 14**, **Fastify 5**, **SQLite** (better-sqlite3, fichier unique `data/heiphaisbot.db`, mode WAL).
* Aucune base externe à installer. Toutes les données (config par serveur, cas de modération, économie, tickets, transcripts, sauvegardes…) sont dans `data/`.
* **Système d'actions** : une action = une définition (paramètres typés, permissions) → commande slash + route API + commande CLI + formulaire du panel, générés automatiquement.
* **Planificateur persistant** (rappels, fins de giveaway, bans temporaires, flux RSS, sauvegardes…) : les tâches survivent aux redémarrages.
* **Bus d'évènements interne** : chaque évènement métier (sanction, ticket fermé, raid détecté, niveau atteint…) est relayé vers ForgeHook et vos webhooks sortants.

## Installation sur VPS

### Méthode 1 : script automatique (Debian/Ubuntu, systemd)
```bash
git clone https://github.com/Heiphaistos/Bot-Discord-Heiphaistos.git
cd Bot-Discord-Heiphaistos
sudo bash deploy/install.sh          # installe Node 22, ffmpeg, yt-dlp, dépendances, service systemd, CLI globale
sudo nano /opt/heiphaisbot/.env      # renseignez DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, OWNER_IDS, PANEL_PUBLIC_URL
sudo systemctl start heiphaisbot
sudo journalctl -u heiphaisbot -f
```

### Méthode 2 : Docker
```bash
cp .env.example .env && nano .env    # PANEL_SESSION_SECRET : openssl rand -hex 32
docker compose up -d --build
docker compose logs -f
docker compose exec heiphaisbot heiphais token create admin --local   # jeton CLI
```

### Méthode 3 : manuelle + PM2
```bash
npm ci --omit=dev
cp .env.example .env && nano .env
npm run check                        # auto-test : modules, commandes, API
npx pm2 start ecosystem.config.cjs && npx pm2 save && npx pm2 startup
```

### Création de l'application Discord
1. https://discord.com/developers/applications → *New Application* → nom **HeiphaisBot**.
2. Onglet **Bot** : *Reset Token* → `DISCORD_TOKEN`. Activez les **Privileged Gateway Intents** : *Presence*, *Server Members*, *Message Content*.
3. Onglet **OAuth2** : `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`. Ajoutez la redirection `https://<PANEL_PUBLIC_URL>/auth/callback`.
4. Invitez le bot : `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=8&scope=bot%20applications.commands` (le panel affiche ce lien).
5. Les commandes slash sont déployées automatiquement au démarrage (globalement, propagation ≈ 1 h ; définissez `DEV_GUILD_ID` pour un déploiement instantané sur un serveur de test).

### Reverse proxy HTTPS (recommandé)
`deploy/nginx.conf` + `certbot --nginx`. Mettez `PANEL_PUBLIC_URL=https://bot.mondomaine.fr` et `PANEL_TRUST_PROXY=true`.

## Configuration
Toutes les variables sont documentées dans [`.env.example`](.env.example). Les clés d'API optionnelles (DeepL, OCR.space, Twitch, Proxmox, Trello/Jira, Tracker.gg, Riot, Steam, remove.bg, Google Safe Browsing, Anthropic…) peuvent être définies globalement dans `.env` **ou par serveur** dans les paramètres du module concerné (panel → module → Paramètres, ou `/settings set <module> <clé> <valeur>`).

Chaque module est activable/désactivable par serveur : `/module enable|disable <module>`, panel → Modules, ou `heiphais module enable <module> --guild <id>`.

## Panel web
* Connexion **Discord OAuth2** (les utilisateurs ayant *Gérer le serveur* voient leurs serveurs) ou **connexion locale** avec `PANEL_ADMIN_PASSWORD` (accès propriétaire).
* Par serveur : tableau de bord, modules (activation, paramètres générés automatiquement), **toutes les actions** exécutables via formulaires, vues de données (cas, tickets, économie, flux, hooks, sauvegardes…), membres, envoi de messages/embeds avec aperçu, journal des actions, tâches planifiées, import/export de configuration.
* Propriétaire : statut, logs en direct, tous les serveurs, redéploiement des commandes, redémarrage, présence, **jetons API** pour la CLI.

## CLI `heiphais`
```bash
heiphais token create admin --local --save      # première fois, sur le VPS (accès direct à la base)
heiphais config set-url https://bot.mondomaine.fr   # à distance : URL + jeton
heiphais status
heiphais guilds
heiphais modules --guild 123
heiphais settings set moderation logChannel=456 dmOnAction=true --guild 123
heiphais ban 789 "spam" --duration 7d --guild 123
heiphais run tickets ticket_close id=42 reason="résolu" --guild 123
heiphais <module> <action> k=v …               # forme générique pour TOUT
heiphais logs --follow
heiphais --help
```
La CLI dialogue avec l'API REST du panel (`Authorization: Bearer hb_…`). Elle fonctionne donc aussi depuis votre machine locale.

## API REST
Base : `/api`, authentification par cookie de session (panel) ou `Authorization: Bearer <jeton>`.

| Route | Description |
|---|---|
| `GET /api/status`, `GET /api/me`, `GET /api/modules`, `GET /api/actions` | État, utilisateur, catalogue |
| `GET /api/guilds` · `GET /api/guilds/:id/` · `/channels` · `/roles` · `/members?q=` | Serveurs |
| `GET/PUT /api/guilds/:id/modules/:module` · `GET/PUT/DELETE …/settings` | Modules et paramètres |
| `POST /api/guilds/:id/actions/:module/:action` `{ params }` | **Exécuter n'importe quelle action** |
| `GET /api/guilds/:id/<module>/…` | Données de chaque module (cas, tickets, items…) |
| `GET /api/guilds/:id/audit` · `/jobs` · `/export` · `POST /import` | Journal, tâches, configuration |
| `GET/POST/DELETE /api/tokens` · `GET /api/system/logs` · `POST /api/system/restart` | Propriétaire |
| `POST /api/public/integrations/in/:id` · `POST /api/public/sysadmin/uptime-kuma/:guildId` · `GET /api/public/tools/s/:code` | Routes publiques (webhooks entrants, raccourcisseur) |

Réponses : `{ ok: true, message, data, embed }` ou `{ ok: false, error, code }`.

## Intégrations ForgeArchive / ForgeHook

Configurez `FORGEARCHIVE_URL`/`FORGEARCHIVE_API_KEY` et `FORGEHOOK_URL`/`FORGEHOOK_API_KEY`/`FORGEHOOK_SECRET` dans `.env` (ou par serveur dans le module *Intégrations*). Les chemins d'API sont configurables (`archivePath`, `listPath`, `statusPath`, `forgeHookPath`).

### ForgeArchive (archivage)
* `/integration archive channel` exporte un salon en JSON + HTML autonome (style Discord), le stocke dans `data/archives/` et l'envoie à ForgeArchive : `POST {FORGEARCHIVE_URL}/api/archives` avec `Authorization: Bearer <clé>`, en **multipart** (`metadata` JSON + fichiers `files`) ou en **JSON** (`files[].data` en base64).
* Métadonnées : `kind` (channel | ticket | backup), `guildId`, `guildName`, `channelId`, `channelName`, `count`, `from`, `to`, `exportedAt`, `exportedBy` (+ `ticketId`, `closedBy`, `reason` ou `backupId`, `backupName`).
* Automatique : transcripts de tickets fermés et sauvegardes de serveur (`autoArchiveTickets`, `autoArchiveBackups`). `integration archive list` lit `GET {listPath}`.

### ForgeHook (évènements & webhooks)
* **Sortant** : chaque évènement du bus interne (sanction, arrivée, ticket, raid, niveau, giveaway, action…) est envoyé en `POST {FORGEHOOK_URL}/api/events` : `{ id, event, guildId, timestamp, payload }`, en-têtes `Authorization: Bearer`, `X-Heiphais-Event`, `X-Heiphais-Signature: sha256=<HMAC-SHA256 du corps avec FORGEHOOK_SECRET>`, `X-Heiphais-Delivery`. 3 tentatives (0 s, 2 s, 8 s), historique dans le panel (*Intégrations → Livraisons*), `/hooks redeliver`. Filtrez les évènements avec `forgeHookEvents`.
* **Entrant** : `/hooks create nom salon format` crée une URL `POST /api/public/integrations/in/<id>` (formats : generic, forgehook, github, gitlab, stripe, paypal, trello, jira, uptimekuma) avec vérification de signature/secret. ForgeHook peut ainsi publier dans Discord via le bot.
* Webhooks sortants personnalisés (`/hooks outgoing add url évènements`) avec le même format signé.

## Modules et fonctionnalités

La référence exhaustive (chaque commande, action, paramètre, permission) est générée dans [`docs/COMMANDES.md`](docs/COMMANDES.md) (`npm run docs`). Vue d'ensemble :

| Catégorie | Modules | Fonctionnalités principales |
|---|---|---|
| **Modération** | `moderation`, `sanctions`, `modtools`, `logs` | ban/tempban/softban/kick/timeout/warn avec paliers et expiration (decay), cas numérotés + historique, purge par critères, lock/lockdown (planifiable), slowmode, jail, shadowban, tribunal communautaire, strikes, signalements (`/report`, menus contextuels), modmail, appels de ban (formulaire web public), watchlist, dehoist & filtre de pseudos, synchronisation des bans entre serveurs, mass-actions, classement des modérateurs, logs complets (36 évènements, diff des messages, auteur via audit log) |
| **Sécurité** | `automod`, `antiraid`, `serverguard` | anti-spam/doublons/mentions/invites/liens/mots/caps/emojis/zalgo, nettoyage des liens d'affiliation, blocage d'extensions, anti-phishing (liste + Google Safe Browsing), filtre NSFW par IA, slowmode dynamique, règles AutoMod natives, anti-raid (vagues, lockdown auto, panic), quarantaine des comptes récents, captcha (bouton, emoji, page web + détection VPN/proxy), liste noire globale, anti-nuke (compteurs par exécuteur, punition, restauration), liste blanche des bots, protection des webhooks, détection d'alts, audit de permissions, snapshots |
| **Communauté** | `welcome`, `invites`, `stats`, `birthday`, `tickets`, `suggestions`, `starboard`, `quotes`, `reactionroles`, `giveaways`, `polls`, `leveling`, `tempvoice`, `onboarding`, `partners`, `social`, `applications`, `events` | bienvenue/départ (texte, embed, carte PNG), autoroles, sticky roles, paliers, suivi des invitations + récompenses, compteurs de membres, horloges mondiales, statistiques d'activité avec graphes, anniversaires, tickets multi-catégories (formulaires, round-robin, escalade, relances, transcripts HTML, stats), suggestions (votes, threads, statuts), starboard, citations, rôles par boutons/menus/réactions, giveaways, sondages (image live, natifs), niveaux (XP texte+vocal, multiplicateurs, week-end double XP, rôles, carte de rang PNG, 27 succès), salons vocaux temporaires, règles avec acceptation, messages différés (drip), FAQ auto, présentations, partenariats & rappel de bump, profils/réputation/mariages/badges, formulaires de candidature avec revue, évènements planifiés (rappels, récurrence, ICS, calendrier) |
| **Économie & jeux** | `economy`, `economyplus`, `casino`, `rpg`, `minigames`, `channelgames`, `fun`, `tabletop` | portefeuille/banque/intérêts, daily/weekly/monthly, métiers, boutique (rôles, rôles temporaires, objets, avantages), inventaire, échanges sécurisés, taxes & trésorerie, primes, bourse virtuelle, braquages, loterie, braquage de groupe, enchères, craft, ferme, pêche, chasse, mine, prêts, entreprises, quêtes, prestige, coupons, blackjack, roulette, slots, paris, combats RPG (boss, duels, évènements de serveur), familiers, wordle, puissance 4, 2048, démineur, course de frappe, memory, pendu, quiz, salons compteur/chaîne de mots/question du jour, 8ball, mèmes (memegen), manipulation d'images, dés avancés & outils JDR |
| **Utilitaires** | `utility`, `tools`, `reminders`, `customcommands`, `announcements`, `notifications`, `automation`, `textutils`, `devtools`, `ai` | userinfo/serverinfo/avatar, traduction (DeepL/LibreTranslate/Google, menu contextuel, réactions drapeau), météo 7 jours + alertes, OCR, convertisseurs (devises, crypto, unités, fuseaux, bases), calculatrice, AFK, snipe, mots de passe, chiffrement AES, hash, raccourcisseur d'URL, QR codes, rappels (personnels, salon, rôle, récurrents), tags & autoresponders, annonces planifiées/récurrentes/modèles, alertes par mot-clé, digests, **moteur d'automatisations** (déclencheurs, conditions, 20 actions, cron complet, exécution de n'importe quelle action du bot), transformations de texte, pastes, outils développeur (GitHub, npm, regex, JSON, cron, CIDR…), IA Claude (`/ai ask`, résumés, explications, modération assistée, salon de discussion) |
| **Musique & médias** | `music`, `media`, `voice` | lecteur yt-dlp/ffmpeg (YouTube, SoundCloud, playlists, recherche), file, boucle, shuffle, seek, rôle DJ, vote skip, 24/7, radios web (Lo-Fi, FIP, SomaFM…), filtres audio live (bassboost, nightcore, 8D…), enregistreur de réunions (MP3), blind test, paroles, soundboard, TTS, playlists, outils vocaux (move all, mute all, rôle vocal, heures calmes, activités Discord) |
| **Gaming** | `gaming` | Minecraft (RCON, statut, whitelist, moniteur), FiveM (statut, joueurs), trackers (Apex, CS, LoL, Valorant, Steam), LFG, mods (Modrinth, Nexus, CurseForge), promos (CheapShark, Epic gratuits, Steam) |
| **Intégrations** | `integrations`, `feeds`, `tickers`, `webhooks` | ForgeArchive, ForgeHook, webhooks entrants (GitHub, GitLab, Stripe, PayPal, Trello, Jira, Uptime Kuma), Trello/Jira depuis Discord, `/fetch` JSON/XML, surveillance de valeurs, RSS/Atom, YouTube, Twitch, Epic, alertes de prix, tickers (crypto, bourse, météo, compte à rebours…), gestion des webhooks Discord |
| **Serveur** | `roles`, `channels`, `threads`, `emojis`, `backup` | rôles (création, audit, rôles couleur, self-roles, temporaires, snapshots), salons (modèles, archivage, sticky, purges planifiées, slowmode horaire), fils (auto-thread, keep-alive, forums), emojis/stickers (vol, stats, packs), sauvegardes/restaurations complètes du serveur |
| **Système & DevOps** | `admin`, `sysadmin`, `network`, `ops`, `dbadmin`, `analytics` | modules/paramètres/préfixe, ressources hôte (CPU/RAM/disque/températures/GPU) + alertes, Docker, Proxmox VE, scripts distants (allowlist), Wake-on-LAN, sauvegardes de la base, Uptime Kuma, nettoyage, exec restreint, ping/traceroute/nmap/DNS/whois/SSL/HTTP + moniteurs, pm2/systemd/ufw/fail2ban/certbot/nginx, mises à jour, self-update, administration SQL en lecture, analytics (heatmap, croissance, rétention, rapports) |

## Développer un module
Voir [`CONVENTIONS.md`](CONVENTIONS.md). Un module = un dossier `src/modules/<nom>/index.js` déclarant `settings`, `actions`, `events`, `jobs`, `components`, `api`, `panel`. Une action est automatiquement exposée en slash, API, CLI et panel. `npm run check` valide l'ensemble sans connexion Discord.

## Exploitation
* **Auto-test** : `npm run check` (charge tous les modules, valide les commandes, démarre l'API en mode test).
* **Logs** : `journalctl -u heiphaisbot -f`, `docker compose logs -f`, panel → Système → Logs, `heiphais logs -f`.
* **Mise à jour** : `git pull && npm ci --omit=dev && sudo systemctl restart heiphaisbot` (ou `/ops bot selfupdate`, `heiphais ops bot_selfupdate`).
* **Sauvegardes** : la base SQLite est dans `data/` ; le module *sysadmin* la sauvegarde quotidiennement (`/sys dbbackup`) et peut l'envoyer à ForgeArchive.
* **Redémarrage** : panel → Système → Redémarrer, `heiphais restart` ou `/ops bot restart` (le gestionnaire de processus relance le bot).
* **Sécurité** : réservez les modules `sysadmin`, `ops`, `dbadmin`, `network` (désactivés par défaut) au propriétaire ; placez le panel derrière HTTPS ; les clés d'API sont masquées dans le panel et le journal.

## Licence
MIT.
