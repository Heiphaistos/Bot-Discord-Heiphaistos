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
