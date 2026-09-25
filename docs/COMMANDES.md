# HeiphaisBot — Référence des modules et commandes

> Généré automatiquement par `node src/scripts/docs.js`. 62 modules, 94 commandes slash de premier niveau, 1366 actions.

Chaque action est disponible en commande slash, via l'API (`POST /api/guilds/:id/actions/<module>/<action>`), via la CLI (`heiphais <module> <action> k=v`) et dans le panel.

## Sommaire

- **Système & DevOps** : [Administration](#admin), [Sauvegardes du serveur](#backup), [Administration DB](#dbadmin), [Réseau](#network), [Exploitation VPS](#ops), [Administration système](#sysadmin)
- **Utilitaires** : [Intelligence artificielle](#ai), [Annonces](#announcements), [Automatisations](#automation), [Commandes personnalisées](#customcommands), [Outils développeur](#devtools), [Notifications](#notifications), [Rappels](#reminders), [Outils texte](#textutils), [Tickers](#tickers), [Boîte à outils](#tools), [Utilitaires](#utility)
- **Communauté** : [Analytique](#analytics), [Candidatures](#applications), [Anniversaires](#birthday), [Évènements](#events), [Giveaways](#giveaways), [Invitations](#invites), [Niveaux](#leveling), [Accueil & FAQ](#onboarding), [Partenariats](#partners), [Sondages](#polls), [Citations](#quotes), [Rôles-réactions](#reactionroles), [Social](#social), [Starboard](#starboard), [Statistiques](#stats), [Suggestions](#suggestions), [Salons vocaux temporaires](#tempvoice), [Tickets](#tickets), [Vocal](#voice), [Bienvenue](#welcome)
- **Sécurité** : [Anti-raid](#antiraid), [Auto-modération](#automod), [Anti-nuke (ServerGuard)](#serverguard)
- **Économie & jeux** : [Casino](#casino), [Économie](#economy), [Économie+](#economyplus), [RPG](#rpg)
- **Fun** : [Jeux de salon](#channelgames), [Fun](#fun), [Mini-jeux](#minigames), [Jeu de rôle](#tabletop)
- **Général** : [Salons](#channels), [Emojis](#emojis), [Rôles](#roles), [Fils](#threads), [Webhooks](#webhooks)
- **Intégrations** : [Flux & alertes](#feeds), [Intégrations](#integrations)
- **Gaming** : [Gaming](#gaming)
- **Modération** : [Journalisation](#logs), [Modération](#moderation), [Outils de modération](#modtools), [Sanctions avancées](#sanctions)
- **Musique & médias** : [Média](#media), [Musique](#music)


# Système & DevOps

## ⚙️ Administration <a id="admin"></a>

`admin` — Commandes essentielles : aide, modules, paramètres, messages, préfixe. *(module essentiel)*

**Paramètres (2)** : `staffRoles` (list) — Rôles staff · `locale` (choice, défaut `fr`) — Langue

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/help` | `help` | Affiche l'aide et la liste des commandes | `commande` (string) | Tous |
| `/bot ping` | `ping` | Latence du bot | — | Tous |
| `/bot info` | `botinfo` | Informations sur le bot | — | Tous |
| `/bot invite` | `invite` | Lien d'invitation du bot | — | Tous |
| `/module list` | `module_list` | Liste des modules et leur état | — | ManageGuild |
| `/module enable` | `module_enable` | Activer un module | `module`* (string) | ManageGuild |
| `/module disable` | `module_disable` | Désactiver un module | `module`* (string) | ManageGuild |
| `/settings get` | `settings_get` | Afficher les paramètres d'un module | `module`* (string) | ManageGuild |
| `/settings set` | `settings_set` | Modifier un paramètre d'un module | `module`* (string), `cle`* (string), `valeur`* (string) | ManageGuild |
| `/settings reset` | `settings_reset` | Réinitialiser les paramètres d'un module | `module`* (string) | ManageGuild |
| `/bot prefix get` | `prefix_get` | Afficher le préfixe des commandes texte | — | Tous |
| `/bot prefix set` | `prefix_set` | Changer le préfixe des commandes texte | `prefix`* (string) | ManageGuild |
| `/bot say` | `say` | Faire parler le bot dans un salon | `message`* (text), `channel` (channel) | ManageMessages |
| `/bot embed` | `embed` | Envoyer un embed personnalisé | `title` (string), `description` (text), `channel` (channel), `color` (color), `image` (string), `thumbnail` (string), `footer` (string), `author` (string), `content` (string), `fields` (json), `timestamp` (boolean), `message_id` (string) | ManageMessages |
| `/bot dm` | `dm` | Envoyer un message privé à un membre via le bot | `user`* (user), `message`* (text) | ManageGuild |
| `/bot editmsg` | `edit_message` | Modifier un message envoyé par le bot | `channel`* (channel), `message_id`* (string), `content`* (text) | ManageMessages |
| `/bot delmsg` | `delete_message` | Supprimer un message par ID | `channel`* (channel), `message_id`* (string) | ManageMessages |
| `/bot export` | `export_settings` | Exporter la configuration du serveur (JSON) | — | ManageGuild |
| `/bot import` | `import_settings` | Importer une configuration (JSON) | `fichier` (attachment), `json` (json) | ManageGuild |
| `/bot audit` | `audit` | Dernières actions effectuées via le bot | `limit` (integer) | ManageGuild |
| `/bot nick` | `setnick_bot` | Changer le pseudo du bot sur ce serveur | `pseudo` (string) | ManageGuild |
| — | `eval` | Exécuter du code JavaScript (propriétaire uniquement) | `code`* (text) | Propriétaire du bot |


## 💾 Sauvegardes du serveur <a id="backup"></a>

`backup` — Sauvegarde et restauration des rôles, salons, permissions, émojis, bannis et de la configuration du bot. 

**Paramètres (5)** : `keep` (integer, défaut `7`) — Sauvegardes automatiques conservées · `maxBackups` (integer, défaut `25`) — Nombre max de sauvegardes manuelles · `includeBans` (boolean, défaut `true`) — Inclure la liste des bannis · `storage` (choice, défaut `file`) — Stockage · `logChannel` (channel) — Salon des rapports de sauvegarde/restauration

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/backup create` | `backup_create` | Créer une sauvegarde du serveur | `nom` (string), `bannis` (boolean) | Administrator |
| `/backup list` | `backup_list` | Lister les sauvegardes du serveur | — | Administrator |
| `/backup info` | `backup_info` | Détails d'une sauvegarde | `id`* (string) | Administrator |
| `/backup delete` | `backup_delete` | Supprimer une sauvegarde | `id`* (string) | Administrator |
| `/backup download` | `backup_download` | Télécharger une sauvegarde (fichier JSON) | `id`* (string) | Administrator |
| `/backup restore` | `backup_restore` | Restaurer une sauvegarde (confirm:true requis) | `id`* (string), `mode` (choice), `clear` (boolean), `confirm` (boolean) | Administrator |
| `/backup history` | `backup_history` | Historique des restaurations | — | Administrator |
| `/backup schedule` | `backup_schedule` | Planifier des sauvegardes automatiques (ex: 1d, 12h, off) | `intervalle` (string) | Administrator |
| `/backup export` | `backup_export` | Exporter l'état actuel du serveur en fichier (sans le stocker) | `bannis` (boolean) | Administrator |
| `/backup import` | `backup_import` | Importer une sauvegarde depuis un fichier JSON | `fichier` (attachment), `json` (json), `nom` (string) | Administrator |

**Vues du panel** : Sauvegardes, Restaurations


## 🗄️ Administration DB <a id="dbadmin"></a>

`dbadmin` — Administration de la base SQLite du bot : tables, schéma, requêtes en lecture seule, écriture journalisée, export/import, maintenance. *(désactivé par défaut)*

**Paramètres (3)** : `maxRows` (integer, défaut `200`) — Lignes max par requête · `backupKeep` (integer, défaut `10`) — Sauvegardes locales conservées · `cleanupDays` (integer, défaut `30`) — Délai de nettoyage des serveurs quittés (jours)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/db tables` | `tables` | Tables : lignes et taille estimée | — | Propriétaire du bot |
| `/db schema` | `schema` | Schéma d'une table | `table`* (string) | Propriétaire du bot |
| `/db query` | `query` | Requête SELECT en lecture seule (200 lignes max) | `sql`* (text), `format` (choice) | Propriétaire du bot |
| `/db exec` | `exec` | Exécuter du SQL d'écriture (transaction, journalisé) | `sql`* (text), `confirm` (boolean) | Propriétaire du bot |
| `/db export` | `export` | Exporter une table (CSV ou JSON) | `table`* (string), `format` (choice) | Propriétaire du bot |
| `/db import` | `import` | Importer des lignes JSON dans une table | `table`* (string), `fichier` (attachment), `json` (json), `mode` (choice), `truncate` (boolean), `confirm` (boolean) | Propriétaire du bot |
| `/db vacuum` | `vacuum` | VACUUM + checkpoint WAL (compacte la base) | — | Propriétaire du bot |
| `/db integrity` | `integrity` | Vérifier l'intégrité (integrity_check, clés étrangères) | `quick` (boolean) | Propriétaire du bot |
| `/db size` | `size` | Taille du fichier, WAL et pages libres | — | Propriétaire du bot |
| `/db stats` | `stats` | Statistiques : lignes par table, plus grosses tables | — | Propriétaire du bot |
| `/db backup` | `backup` | Sauvegarder la base (via sysadmin si disponible) | — | Propriétaire du bot |
| `/db prune` | `prune` | Supprimer les lignes plus vieilles que N jours | `table`* (string), `days`* (integer), `column` (string), `confirm` (boolean) | Propriétaire du bot |
| `/db settings` | `settings` | Lecture brute de guild_settings | `guild` (string), `module` (string) | Propriétaire du bot |
| `/db kv` | `kv` | Table kv : list, get, set, delete | `action` (choice), `key` (string), `value` (text) | Propriétaire du bot |
| `/db jobs` | `jobs` | Jobs planifiés : list / delete | `action` (choice), `id` (integer), `module` (string) | Propriétaire du bot |
| `/db sessions` | `sessions` | Purger les sessions du panel (expirées ou toutes) | `all` (boolean), `confirm` (boolean) | Propriétaire du bot |
| `/db migrations` | `migrations` | Migrations appliquées par module | — | Propriétaire du bot |
| `/db guilds` | `guilds` | Table guilds (présence, départ) | `left_only` (boolean) | Propriétaire du bot |
| `/db cleanup` | `cleanup` | Supprimer les données des serveurs quittés | `days` (integer), `confirm` (boolean) | Propriétaire du bot |
| `/db log` | `log` | Journal des opérations d'écriture dbadmin | `limit` (integer) | Propriétaire du bot |

**Vues du panel** : Tables, Journal


## 🌐 Réseau <a id="network"></a>

`network` — Diagnostics réseau (ping, DNS, whois, SSL, HTTP, ports) et surveillance de services et de certificats. *(désactivé par défaut)*

**Paramètres (3)** : `defaultChannel` (channel) — Salon par défaut des alertes · `monitorMentionRole` (role) — Rôle mentionné quand un service tombe · `monitorFailThreshold` (integer, défaut `2`) — Échecs consécutifs avant alerte

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/net ping` | `net_ping` | Ping d'un hôte (ICMP, repli TCP) | `hote`* (string) | ManageGuild |
| `/net tcp` | `net_tcp` | Latence de connexion TCP vers un port | `hote`* (string), `port`* (integer) | ManageGuild |
| `/net traceroute` | `net_traceroute` | Traceroute vers un hôte | `hote`* (string) | Propriétaire du bot |
| `/net nmap` | `net_nmap` | Scan nmap d'un hôte (propriétaire) | `hote`* (string), `ports` (string), `versions` (boolean) | Propriétaire du bot |
| `/net dns` | `net_dns` | Requête DNS (A, AAAA, MX, TXT, NS, CNAME, SOA, SRV, CAA, PTR) | `domaine`* (string), `type` (choice), `serveur` (string) | ManageGuild |
| `/net whois` | `net_whois` | Whois / RDAP d'un domaine | `domaine`* (string) | ManageGuild |
| `/net ssl` | `net_ssl` | Certificat SSL/TLS d'un hôte | `hote`* (string), `port` (integer) | ManageGuild |
| `/net http` | `net_http` | Tester une URL : statut, temps, redirections, en-têtes | `url`* (string), `methode` (choice) | ManageGuild |
| `/net headers` | `net_headers` | En-têtes HTTP et audit des en-têtes de sécurité | `url`* (string) | ManageGuild |
| `/net ip` | `net_ip` | Géolocalisation et informations d'une adresse IP | `adresse`* (string) | ManageGuild |
| `/net ports` | `net_ports` | Scanner les ports TCP courants d'un hôte (max 50) | `hote`* (string), `ports` (list) | ManageGuild |
| `/net monitor add` | `monitor_add` | Surveiller une URL ou un hôte:port | `nom`* (string), `cible`* (string), `intervalle` (duration), `salon` (channel) | ManageGuild |
| `/net monitor list` | `monitor_list` | Lister les moniteurs | — | ManageGuild |
| `/net monitor status` | `monitor_status` | État détaillé d'un moniteur | `nom`* (string), `verifier` (boolean) | ManageGuild |
| `/net monitor remove` | `monitor_remove` | Supprimer un moniteur | `nom`* (string) | ManageGuild |
| `/net sslwatch add` | `sslwatch_add` | Surveiller l'expiration d'un certificat (alertes à 30/14/7/1 j) | `hote`* (string), `salon` (channel) | ManageGuild |
| `/net sslwatch list` | `sslwatch_list` | Certificats surveillés | — | ManageGuild |
| `/net sslwatch remove` | `sslwatch_remove` | Arrêter la surveillance d'un certificat | `hote`* (string) | ManageGuild |
| `/net sslwatch check` | `sslwatch_check` | Vérifier maintenant tous les certificats surveillés | — | ManageGuild |

**Vues du panel** : Moniteurs, Certificats SSL


## 🛠️ Exploitation VPS <a id="ops"></a>

`ops` — Exploitation du serveur : pm2, systemd, pare-feu, fail2ban, mises à jour, logs, certificats, mise à jour du bot, alertes et rapports. *(désactivé par défaut)*

**Paramètres (15)** : `allowedUnits` (list) — Unités systemd autorisées · `allowedPaths` (list) — Chemins autorisés (du) · `allowedLogFiles` (list) — Fichiers de logs autorisés · `useSudo` (boolean, défaut `false`) — Utiliser sudo · `cmdTimeout` (integer, défaut `30`) — Délai des commandes (s) · `updateTimeoutMin` (integer, défaut `14`) — Délai de `updates apply` (min) · `restartAfterUpdate` (boolean, défaut `false`) — Redémarrer après selfupdate · `alertsEnabled` (boolean, défaut `false`) — Alertes actives · `alertChannel` (channel) — Salon des alertes · `diskMounts` (list) — Points de montage surveillés · `diskThreshold` (integer, défaut `90`) — Seuil disque (%) · `sshFailThreshold` (integer, défaut `30`) — Échecs SSH max par heure · `certHosts` (list) — Hôtes TLS surveillés · `certDays` (integer, défaut `7`) — Alerte certificat (jours) · `alertCooldownMin` (integer, défaut `60`) — Anti-spam des alertes (min)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/ops pm2` | `pm2` | Processus pm2 : liste, détails, logs, start/stop/restart | `action` (choice), `name` (string), `lines` (integer), `confirm` (boolean) | Propriétaire du bot |
| `/ops systemd` | `systemd` | Unités systemd : list, status, logs, start/stop/restart, enable/disable | `action` (choice), `unit` (string), `lines` (integer), `confirm` (boolean) | Propriétaire du bot |
| `/ops ufw` | `ufw` | Pare-feu ufw : status, allow, deny, delete | `action` (choice), `rule` (string), `numero` (integer), `confirm` (boolean) | Propriétaire du bot |
| `/ops fail2ban` | `fail2ban` | fail2ban : status [jail], banned, unban ip | `action` (choice), `jail` (string), `ip` (string) | Propriétaire du bot |
| `/ops ssh` | `ssh_sessions` | Sessions SSH ouvertes et dernières connexions | — | Propriétaire du bot |
| `/ops logins` | `logins_failed` | Échecs de connexion SSH (comptage par IP) | `hours` (integer) | Propriétaire du bot |
| `/ops updates` | `updates` | Mises à jour système : check / apply | `action` (choice), `refresh` (boolean), `confirm` (boolean) | Propriétaire du bot |
| `/ops reboot` | `reboot` | Redémarrer l'hôte (différé, annulable) | `confirm` (boolean), `delay` (integer), `cancel` (boolean) | Propriétaire du bot |
| `/ops cron` | `cron` | Tâches cron (crontab utilisateur + /etc/cron.d) | — | Propriétaire du bot |
| `/ops du` | `du` | Occupation disque d'un dossier autorisé | `path`* (string), `depth` (integer) | Propriétaire du bot |
| `/ops tail` | `tail` | Dernières lignes d'un fichier de logs autorisé | `file`* (string), `lines` (integer) | Propriétaire du bot |
| `/ops grep` | `grep` | Rechercher dans un fichier de logs autorisé | `file`* (string), `pattern`* (string), `regex` (boolean), `max` (integer) | Propriétaire du bot |
| `/ops ports` | `ports` | Ports en écoute (ss -tulpn) | — | Propriétaire du bot |
| `/ops connections` | `connections` | Résumé des connexions et top IP distantes | — | Propriétaire du bot |
| `/ops publicip` | `publicip` | Adresse IP publique du serveur | — | Propriétaire du bot |
| `/ops speedtest` | `speedtest` | Test de débit (speedtest ou Cloudflare) | — | Propriétaire du bot |
| `/ops certbot` | `certbot` | Certificats Let's Encrypt : list / renew | `action` (choice), `dry_run` (boolean), `confirm` (boolean) | Propriétaire du bot |
| `/ops nginx` | `nginx` | nginx : test de configuration / reload | `action` (choice) | Propriétaire du bot |
| `/ops alerts` | `alerts` | Alertes système : set salon, off, status, test | `action` (choice), `channel` (channel) | Propriétaire du bot |
| `/ops report now` | `report_now` | Rapport système complet (embed + fichier) | — | Propriétaire du bot |
| `/ops report schedule` | `report_schedule` | Programmer le rapport (quotidien/hebdo) | `channel`* (channel), `time`* (string), `frequency` (choice) | Propriétaire du bot |
| `/ops report unschedule` | `report_unschedule` | Supprimer le rapport programmé | — | Propriétaire du bot |
| `/ops whoami` | `whoami` | Utilisateur système du bot, groupes, sudo | — | Propriétaire du bot |
| `/ops uptime` | `uptime` | Uptime de l'hôte, du processus et de Discord | — | Propriétaire du bot |
| `/ops runs` | `runs` | Journal des commandes exécutées par ops | `limit` (integer), `failed` (boolean) | Propriétaire du bot |
| `/ops bot version` | `bot_version` | Version, commit git et dernière modification | — | Propriétaire du bot |
| `/ops bot selfupdate` | `bot_selfupdate` | git pull + npm ci, changelog, redémarrage optionnel | `restart` (boolean), `npm` (boolean) | Propriétaire du bot |
| `/ops bot restart` | `bot_restart` | Redémarrer le bot (relancé par le gestionnaire) | `confirm` (boolean) | Propriétaire du bot |
| `/ops bot logs` | `bot_logs` | Logs récents du bot (mémoire) | `level` (choice), `module` (string), `n` (integer) | Propriétaire du bot |
| `/ops bot health` | `bot_health` | Santé du bot : DB, Discord, mémoire, jobs, erreurs | — | Propriétaire du bot |
| `/ops bot gc` | `bot_gc` | Forcer le ramasse-miettes (--expose-gc) | — | Propriétaire du bot |
| `/ops bot config` | `bot_config` | Configuration du bot (secrets masqués) | — | Propriétaire du bot |
| `/ops bot shard` | `bot_shard` | Informations de sharding | — | Propriétaire du bot |
| `/ops bot eventloop` | `bot_eventloop` | Latence de la boucle d'évènements | — | Propriétaire du bot |
| `/ops bot env` | `bot_env` | Variables d'environnement (secrets masqués) | `filter` (string) | Propriétaire du bot |

**Vues du panel** : Journal des commandes, Alertes


## 🖥️ Administration système <a id="sysadmin"></a>

`sysadmin` — Ressources de l'hôte, alertes, Docker, Proxmox VE, scripts, Wake-on-LAN, sauvegardes de la base, Uptime Kuma et nettoyage. *(désactivé par défaut)*

**Paramètres (24)** : `alertChannel` (channel) — Salon des alertes système · `alertCpu` (number, défaut `90`) — Seuil CPU (%) · `alertRam` (number, défaut `90`) — Seuil RAM (%) · `alertDisk` (number, défaut `90`) — Seuil disque (%) · `alertTemp` (number, défaut `85`) — Seuil température (°C) · `alertMentionRole` (role) — Rôle mentionné lors des alertes · `dockerSocket` (string, défaut `/var/run/docker.sock`) — Socket Docker · `proxmoxUrl` (string) — URL Proxmox VE · `proxmoxTokenId` (string) — ID du jeton API Proxmox · `proxmoxTokenSecret` (string) — Secret du jeton API Proxmox · `proxmoxInsecure` (boolean, défaut `false`) — Accepter un certificat auto-signé · `scriptTimeout` (integer, défaut `60`) — Délai max des scripts (secondes) · `allowedCommands` (list) — Commandes autorisées pour /sys exec · `dbBackupEnabled` (boolean, défaut `false`) — Sauvegarde quotidienne de la base · `dbBackupHour` (integer, défaut `4`) — Heure de la sauvegarde (0-23, heure du serveur) · `dbBackupKeep` (integer, défaut `7`) — Nombre de sauvegardes conservées · `dbBackupJson` (boolean, défaut `true`) — Inclure un export JSON · `uptimeKumaSecret` (string) — Secret du webhook Uptime Kuma · `uptimeChannel` (channel) — Salon des alertes Uptime Kuma · `uptimeMentionRole` (role) — Rôle mentionné quand un service tombe · `cleanupPaths` (list) — Chemins nettoyables · `cleanupMaxAgeDays` (integer, défaut `7`) — Âge minimal des fichiers supprimés (jours) · `transcriptsMaxAgeDays` (integer, défaut `30`) — Conservation des transcripts (jours) · `recordingsMaxAgeDays` (integer, défaut `7`) — Conservation des enregistrements (jours)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/sys status` | `sys_status` | État de l'hôte : CPU, RAM, disques, températures, réseau, processus | `image` (boolean) | Propriétaire du bot |
| `/sys processes` | `sys_processes` | Processus les plus gourmands | `tri` (choice), `nombre` (integer) | Propriétaire du bot |
| `/sys disk` | `sys_disk` | Occupation des disques | — | Propriétaire du bot |
| `/sys temps` | `sys_temps` | Températures CPU / GPU / capteurs | — | Propriétaire du bot |
| `/sys uptime` | `sys_uptime` | Uptime de l'hôte et du bot | — | Propriétaire du bot |
| `/sys alerts` | `sys_alerts` | Seuils et état des alertes système | `verifier` (boolean) | Propriétaire du bot |
| `/sys exec` | `sys_exec` | Exécuter une commande autorisée (liste blanche, sans opérateurs shell) | `commande`* (string) | Propriétaire du bot |
| `/sys script list` | `script_list` | Lister les scripts exécutables | — | Propriétaire du bot |
| `/sys script run` | `script_run` | Exécuter un script du dossier scripts | `nom`* (string), `args` (string), `delai` (integer) | Propriétaire du bot |
| `/sys script add` | `script_add` | Ajouter ou remplacer un script | `nom`* (string), `contenu` (text), `fichier` (attachment), `remplacer` (boolean) | Propriétaire du bot |
| `/sys script remove` | `script_remove` | Supprimer un script | `nom`* (string) | Propriétaire du bot |
| `/sys script history` | `script_history` | Dernières exécutions de scripts et commandes | `nombre` (integer) | Propriétaire du bot |
| `/sys wol wake` | `wol` | Réveiller une machine (Wake-on-LAN) par MAC ou nom enregistré | `cible`* (string), `broadcast` (string), `port` (integer) | Propriétaire du bot |
| `/sys wol add` | `wol_add` | Enregistrer une machine Wake-on-LAN | `nom`* (string), `mac`* (string), `broadcast` (string), `port` (integer) | Propriétaire du bot |
| `/sys wol list` | `wol_list` | Lister les machines Wake-on-LAN | — | Propriétaire du bot |
| `/sys wol remove` | `wol_remove` | Supprimer une machine Wake-on-LAN | `nom`* (string) | Propriétaire du bot |
| `/sys dbbackup now` | `dbbackup_now` | Sauvegarder la base du bot maintenant | `json` (boolean) | Propriétaire du bot |
| `/sys dbbackup list` | `dbbackup_list` | Lister les sauvegardes de la base | — | Propriétaire du bot |
| `/sys dbbackup delete` | `dbbackup_delete` | Supprimer une sauvegarde de la base | `fichier`* (string) | Propriétaire du bot |
| `/sys dbbackup restore-info` | `dbbackup_restore_info` | Procédure de restauration d'une sauvegarde de la base | `fichier` (string) | Propriétaire du bot |
| `/sys uptimekuma setup` | `uptimekuma_setup` | Afficher l'URL du webhook à configurer dans Uptime Kuma | `regenerer` (boolean) | Propriétaire du bot |
| `/sys uptimekuma test` | `uptimekuma_test` | Envoyer une alerte Uptime Kuma de test | — | Propriétaire du bot |
| `/sys cleanup run` | `cleanup_run` | Nettoyer les chemins autorisés et les caches du bot | `cible` (string) | Propriétaire du bot |
| `/sys cleanup preview` | `cleanup_preview` | Aperçu de l'espace récupérable | `cible` (string) | Propriétaire du bot |
| `/sys docker ps` | `docker_ps` | Lister les conteneurs Docker | `tous` (boolean) | Propriétaire du bot |
| `/sys docker start` | `docker_start` | Docker : démarrage un conteneur | `conteneur`* (string) | Propriétaire du bot |
| `/sys docker stop` | `docker_stop` | Docker : arrêt un conteneur | `conteneur`* (string) | Propriétaire du bot |
| `/sys docker restart` | `docker_restart` | Docker : redémarrage un conteneur | `conteneur`* (string) | Propriétaire du bot |
| `/sys docker logs` | `docker_logs` | Derniers logs d'un conteneur | `conteneur`* (string), `lignes` (integer) | Propriétaire du bot |
| `/sys docker stats` | `docker_stats` | Consommation CPU/RAM/réseau des conteneurs | `conteneur` (string) | Propriétaire du bot |
| `/sys docker images` | `docker_images` | Lister les images Docker | — | Propriétaire du bot |
| `/sys docker inspect` | `docker_inspect` | Détails d'un conteneur (variables d'env masquées) | `conteneur`* (string) | Propriétaire du bot |
| `/sys docker prune` | `docker_prune` | Supprimer les ressources Docker inutilisées | `cible`* (choice), `confirm` (boolean) | Propriétaire du bot |
| `/sys docker info` | `docker_info` | Informations sur le démon Docker | — | Propriétaire du bot |
| `/proxmox nodes` | `pve_nodes` | Nœuds Proxmox et leurs ressources | — | Propriétaire du bot |
| `/proxmox list` | `pve_list` | VMs et conteneurs LXC de tous les nœuds | `etat` (choice), `type` (choice) | Propriétaire du bot |
| `/proxmox status` | `pve_status` | État détaillé d'une VM ou d'un conteneur LXC | `vmid`* (integer) | Propriétaire du bot |
| `/proxmox start` | `pve_start` | Proxmox : démarrer une VM ou un conteneur LXC | `vmid`* (integer) | Propriétaire du bot |
| `/proxmox stop` | `pve_stop` | Proxmox : arrêter brutalement une VM ou un conteneur LXC | `vmid`* (integer) | Propriétaire du bot |
| `/proxmox shutdown` | `pve_shutdown` | Proxmox : éteindre proprement une VM ou un conteneur LXC | `vmid`* (integer) | Propriétaire du bot |
| `/proxmox reboot` | `pve_reboot` | Proxmox : redémarrer une VM ou un conteneur LXC | `vmid`* (integer) | Propriétaire du bot |
| `/proxmox suspend` | `pve_suspend` | Proxmox : suspendre une VM ou un conteneur LXC | `vmid`* (integer) | Propriétaire du bot |
| `/proxmox resume` | `pve_resume` | Proxmox : reprendre une VM ou un conteneur LXC | `vmid`* (integer) | Propriétaire du bot |
| `/proxmox snapshot list` | `pve_snapshot_list` | Lister les snapshots d'une VM / LXC | `vmid`* (integer) | Propriétaire du bot |
| `/proxmox snapshot create` | `pve_snapshot_create` | Créer un snapshot d'une VM / LXC | `vmid`* (integer), `nom`* (string), `description` (string), `ram` (boolean) | Propriétaire du bot |
| `/proxmox tasks` | `pve_tasks` | Dernières tâches Proxmox | `nombre` (integer) | Propriétaire du bot |

**Vues du panel** : Conteneurs Docker, VMs Proxmox, Wake-on-LAN, Scripts, Historique des exécutions, Sauvegardes de la base


# Utilitaires

## 🤖 Intelligence artificielle <a id="ai"></a>

`ai` — Assistant Claude (Anthropic) : questions, résumés de salon, traduction, explication, aide à la modération, salon de discussion. 

**Paramètres (9)** : `apiKey` (string) — Clé API Anthropic (serveur) · `model` (string) — Modèle · `maxTokens` (integer, défaut `1500`) — Jetons max par réponse · `effort` (choice, défaut `low`) — Niveau d'effort · `dailyLimit` (integer, défaut `200`) — Requêtes max par jour (serveur) · `userCooldown` (integer, défaut `10`) — Délai entre deux demandes d'un membre (s) · `persona` (text) — Personnalité (prompt système du serveur) · `chatChannels` (list) — Salons de discussion avec l'IA · `replyToMentions` (boolean, défaut `true`) — Répondre quand le bot est mentionné

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/ai ask` | `ask` | Poser une question à l'IA (image optionnelle) | `question`* (text), `image` (string), `fichier` (attachment) | Tous |
| `/ai summarize` | `summarize` | Résumer les derniers messages d'un salon | `salon` (channel), `nombre` (integer) | Tous |
| `/ai translate` | `translate` | Traduire un texte avec l'IA | `texte`* (text), `langue`* (string) | Tous |
| `/ai explain` | `explain` | Expliquer un message avec l'IA | `message_id`* (string), `salon` (channel) | Tous |
| `/ai moderate` | `moderate` | Analyser la toxicité d'un message et suggérer une sanction | `message_id`* (string), `salon` (channel) | ModerateMembers |
| `/ai image_describe` | `image_describe` | Décrire une image avec l'IA | `url`* (string), `question` (string) | Tous |
| `/ai persona set` | `persona_set` | Définir la personnalité de l'IA sur ce serveur | `texte`* (text) | ManageGuild |
| `/ai persona clear` | `persona_clear` | Réinitialiser la personnalité de l'IA | — | ManageGuild |
| `/ai persona show` | `persona_show` | Afficher la personnalité actuelle de l'IA | — | ManageGuild |
| `/ai chat channel` | `chat_channel` | Activer / désactiver un salon de discussion avec l'IA | `salon`* (channel), `actif` (boolean) | ManageGuild |
| `/ai chat reset` | `chat_reset` | Effacer la mémoire de conversation de l'IA dans un salon | `salon` (channel) | ManageMessages |
| `/ai usage` | `usage` | Consommation de l'IA sur ce serveur | `jours` (integer) | ManageGuild |
| `/ai config` | `config` | Afficher / modifier la configuration de l'IA | `modele` (string), `limite_jour` (integer), `cooldown` (integer), `max_tokens` (integer), `effort` (choice), `mentions` (boolean) | ManageGuild |

**Menus contextuels** : « Expliquer avec l'IA »

**Vues du panel** : Consommation


## 📢 Annonces <a id="announcements"></a>

`announcements` — Annonces immédiates, programmées ou récurrentes, modèles réutilisables et publication automatique dans les salons d'annonces. 

**Paramètres (6)** : `autoPublish` (boolean, défaut `false`) — Publication automatique · `autoPublishChannels` (list) — Salons à publier automatiquement · `autoPublishBots` (boolean, défaut `true`) — Publier aussi les messages des autres bots · `defaultColor` (color, défaut `#5865F2`) — Couleur par défaut des embeds · `maxScheduled` (integer, défaut `50`) — Annonces programmées max · `logChannel` (channel) — Salon des logs

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/announce send` | `send` | Envoyer une annonce maintenant | `channel`* (channel), `message`* (text), `embed` (json), `ping` (string), `crosspost` (boolean) | ManageMessages |
| `/announce schedule` | `schedule` | Programmer une annonce à une date précise | `channel`* (channel), `date`* (date), `message`* (text), `embed` (json), `ping` (string), `crosspost` (boolean) | ManageMessages |
| `/announce repeat` | `repeat` | Programmer une annonce récurrente (intervalle min. 10 min) | `channel`* (channel), `interval`* (duration), `message`* (text), `embed` (json), `ping` (string), `start` (date), `crosspost` (boolean) | ManageMessages |
| `/announce list` | `list` | Lister les annonces programmées | `all` (boolean) | ManageMessages |
| `/announce cancel` | `cancel` | Annuler une annonce programmée ou récurrente | `id`* (integer) | ManageMessages |
| `/announce preview` | `preview` | Prévisualiser une annonce (sans l'envoyer) | `message` (text), `embed` (json), `ping` (string), `template` (string), `id` (integer) | ManageMessages |
| `/announce template save` | `template_save` | Enregistrer (ou remplacer) un modèle d'annonce | `name`* (string), `message`* (text), `embed` (json) | ManageMessages |
| `/announce template use` | `template_use` | Envoyer (ou programmer) une annonce depuis un modèle | `name`* (string), `channel`* (channel), `ping` (string), `date` (date), `crosspost` (boolean) | ManageMessages |
| `/announce template list` | `template_list` | Lister les modèles d'annonce | — | ManageMessages |
| `/announce template delete` | `template_delete` | Supprimer un modèle d'annonce | `name`* (string) | ManageMessages |
| `/announce template raw` | `template_raw` | Afficher le contenu brut d'un modèle | `name`* (string) | ManageMessages |

**Vues du panel** : Annonces programmées, Modèles


## 🤖 Automatisations <a id="automation"></a>

`automation` — Moteur de règles « si … alors … » (déclencheurs, conditions, actions) et planificateur cron universel. 

**Paramètres (5)** : `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire · `logChannel` (channel) — Salon des logs d'automatisation · `notifyErrors` (boolean, défaut `true`) — Signaler les erreurs dans le salon de logs · `maxRules` (integer, défaut `100`) — Nombre maximum de règles · `logRetentionDays` (integer, défaut `30`) — Rétention des journaux (jours)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/automation create` | `create` | Créer une règle (JSON : déclencheur, conditions, actions) | `name`* (string), `trigger`* (json), `actions`* (json), `conditions` (json), `cooldown` (duration), `enabled` (boolean) | ManageGuild |
| `/automation wizard` | `wizard` | Assistant de création (formulaire pré-rempli) | `template` (choice) | ManageGuild |
| `/automation edit` | `edit` | Modifier une règle (nom, JSON, cooldown) | `id`* (integer), `name` (string), `trigger` (json), `conditions` (json), `actions` (json), `cooldown` (duration) | ManageGuild |
| `/automation list` | `list` | Lister les règles | `trigger` (choice) | ManageGuild |
| `/automation info` | `info` | Détails d'une règle | `id`* (integer) | ManageGuild |
| `/automation enable` | `enable` | Activer une règle | `id`* (integer) | ManageGuild |
| `/automation disable` | `disable` | Désactiver une règle | `id`* (integer) | ManageGuild |
| `/automation delete` | `delete` | Supprimer une règle | `id`* (integer) | ManageGuild |
| `/automation run` | `run` | Exécuter une règle manuellement | `id`* (integer), `force` (boolean) | ManageGuild |
| `/automation test` | `test` | Tester une règle à blanc (aucun effet) | `id`* (integer), `force` (boolean) | ManageGuild |
| `/automation logs` | `logs` | Journal des exécutions | `id` (integer), `errors` (boolean), `limit` (integer) | ManageGuild |
| `/automation export` | `export` | Exporter les règles (JSON) | `id` (integer) | ManageGuild |
| `/automation import` | `import` | Importer des règles (JSON ou fichier) | `json` (json), `fichier` (attachment), `replace` (boolean) | ManageGuild |
| `/automation templates` | `templates` | Bibliothèque de règles prêtes à l'emploi | — | ManageGuild |
| `/automation template use` | `template_use` | Créer une règle depuis un modèle | `nom`* (choice), `channel` (channel), `role` (role), `text` (text), `schedule` (string), `name` (string) | ManageGuild |
| `/automation vars list` | `vars_list` | Lister les variables persistantes | `search` (string) | ManageGuild |
| `/automation vars get` | `vars_get` | Lire une variable | `name`* (string) | ManageGuild |
| `/automation vars set` | `vars_set` | Définir une variable | `name`* (string), `value`* (text) | ManageGuild |
| `/automation vars delete` | `vars_delete` | Supprimer une variable | `name`* (string) | ManageGuild |
| `/automation cron next` | `cron_next` | Afficher les 5 prochaines occurrences d'une planification | `expression`* (string), `count` (integer), `timezone` (string) | Tous |
| `/automation schedule` | `schedule` | Raccourci : exécuter une action du bot selon un cron | `module`* (string), `action`* (string), `cron`* (string), `params_json` (json), `name` (string), `channel` (channel) | ManageGuild |

**Vues du panel** : Règles, Journal, Variables


## 🏷️ Commandes personnalisées <a id="customcommands"></a>

`customcommands` — Tags (commandes personnalisées avec variables, réponses aléatoires, embeds) et réponses automatiques par déclencheur. 

**Paramètres (8)** : `prefixTrigger` (boolean, défaut `true`) — Déclencher les tags via le préfixe · `deleteInvocation` (boolean, défaut `false`) — Supprimer le message déclencheur · `maxTags` (integer, défaut `300`) — Nombre maximum de tags · `autorespondersEnabled` (boolean, défaut `true`) — Réponses automatiques actives · `maxAutoresponders` (integer, défaut `100`) — Nombre maximum de réponses automatiques · `defaultCooldown` (integer, défaut `10`) — Cooldown par défaut (secondes) · `ignoredChannels` (list) — Salons ignorés par les réponses automatiques · `ignoredRoles` (list) — Rôles ignorés par les réponses automatiques

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/tag create` | `tag_create` | Créer un tag | `name`* (string), `response`* (text), `embed` (json), `roles` (list) | ManageMessages |
| `/tag edit` | `tag_edit` | Modifier un tag | `name`* (string), `response` (text), `embed` (json), `roles` (list), `clear_roles` (boolean) | ManageMessages |
| `/tag delete` | `tag_delete` | Supprimer un tag | `name`* (string) | ManageMessages |
| `/tag info` | `tag_info` | Informations sur un tag | `name`* (string) | Tous |
| `/tag list` | `tag_list` | Lister les tags du serveur | `page` (integer) | Tous |
| `/tag search` | `tag_search` | Rechercher un tag par nom ou contenu | `query`* (string) | Tous |
| `/tag raw` | `tag_raw` | Afficher le contenu brut d'un tag | `name`* (string) | Tous |
| `/tag alias` | `tag_alias` | Ajouter ou retirer un alias à un tag | `name`* (string), `alias`* (string), `remove` (boolean) | ManageMessages |
| `/tag use` | `tag_use` | Utiliser un tag | `name`* (string), `args` (string) | Tous |
| `/tag autoresponder add` | `ar_add` | Ajouter une réponse automatique | `trigger`* (string), `response` (text), `match` (choice), `channels` (list), `reaction` (string), `cooldown` (integer), `reply` (boolean) | ManageMessages |
| `/tag autoresponder remove` | `ar_remove` | Supprimer une réponse automatique | `id`* (integer) | ManageMessages |
| `/tag autoresponder list` | `ar_list` | Lister les réponses automatiques | — | ManageMessages |
| `/tag autoresponder toggle` | `ar_toggle` | Activer / désactiver une réponse automatique | `id`* (integer) | ManageMessages |

**Vues du panel** : Tags, Réponses automatiques


## 🧑‍💻 Outils développeur <a id="devtools"></a>

`devtools` — GitHub, npm/PyPI/Docker/crates, regex, JSON/YAML, cron, CIDR, couleurs, JWT, UUID/ULID, SQL, statuts de services, recherche StackOverflow/MDN, exécution JS isolée. 

**Paramètres (4)** : `githubToken` (string) — Jeton GitHub (optionnel) · `allowJsEval` (boolean, défaut `false`) — Autoriser /dev run à tous les membres · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire · `hashMaxMb` (integer, défaut `25`) — Taille max. pour /dev encode hash (Mo)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/dev github repo` | `github_repo` | Infos d'un dépôt GitHub | `depot`* (string) | Tous |
| `/dev github issues` | `github_issues` | Dernières issues d'un dépôt | `depot`* (string), `etat` (choice) | Tous |
| `/dev github prs` | `github_prs` | Dernières pull requests d'un dépôt | `depot`* (string), `etat` (choice) | Tous |
| `/dev github commits` | `github_commits` | Derniers commits d'un dépôt | `depot`* (string), `branche` (string) | Tous |
| `/dev github user` | `github_user` | Profil d'un utilisateur ou d'une organisation GitHub | `nom`* (string) | Tous |
| `/dev github release` | `github_release` | Dernière release (ou une version précise) d'un dépôt | `depot`* (string), `tag` (string) | Tous |
| `/dev pkg npm` | `pkg_npm` | Infos d'un paquet npm | `paquet`* (string) | Tous |
| `/dev pkg pypi` | `pkg_pypi` | Infos d'un paquet Python (PyPI) | `paquet`* (string) | Tous |
| `/dev pkg docker` | `pkg_docker` | Image Docker Hub et tags récents | `image`* (string) | Tous |
| `/dev pkg crate` | `pkg_crate` | Infos d'une crate Rust (crates.io) | `crate`* (string) | Tous |
| `/dev regex` | `regex` | Tester une expression régulière (isolée, délai 1 s) | `pattern`* (string), `texte`* (string), `flags` (string), `remplacement` (string) | Tous |
| `/dev json format` | `json_format` | Indenter (embellir) du JSON | `json` (string), `fichier` (attachment), `indentation` (choice), `trier` (boolean) | Tous |
| `/dev json minify` | `json_minify` | Minifier du JSON | `json` (string), `fichier` (attachment) | Tous |
| `/dev json validate` | `json_validate` | Valider du JSON (erreur avec ligne/colonne) | `json` (string), `fichier` (attachment) | Tous |
| `/dev json path` | `json_path` | Extraire une valeur par chemin (a.b[0].c) | `chemin`* (string), `json` (string), `fichier` (attachment) | Tous |
| `/dev json toyaml` | `json_toyaml` | Convertir du JSON en YAML | `json` (string), `fichier` (attachment) | Tous |
| `/dev json fromyaml` | `json_fromyaml` | Convertir du YAML simple en JSON | `yaml` (string), `fichier` (attachment) | Tous |
| `/dev cron` | `cron` | Expliquer une expression cron en français | `expression`* (string), `fuseau` (string) | Tous |
| `/dev timestamp` | `timestamp` | Convertir une date / un timestamp (formats Discord) | `valeur` (string), `fuseau` (string) | Tous |
| `/dev color` | `color` | Convertir une couleur (hex/rgb/hsl/cmyk) + aperçu et palette | `couleur`* (string) | Tous |
| `/dev sql` | `sql` | Formater une requête SQL | `requete` (string), `fichier` (attachment), `majuscules` (boolean) | Tous |
| `/dev gen uuid` | `gen_uuid` | Générer des UUID (v4 aléatoire ou v7 ordonné) | `version` (choice), `nombre` (integer), `majuscules` (boolean) | Tous |
| `/dev gen ulid` | `gen_ulid` | Générer des ULID | `nombre` (integer) | Tous |
| `/dev gen nanoid` | `gen_nanoid` | Générer des NanoID | `taille` (integer), `nombre` (integer), `alphabet` (string) | Tous |
| `/dev web http` | `web_http` | Signification d'un code de statut HTTP | `code`* (integer) | Tous |
| `/dev web mime` | `web_mime` | Type MIME d'une extension (ou extensions d'un type) | `valeur`* (string) | Tous |
| `/dev web url` | `web_url` | Décomposer une URL (composants + paramètres) | `url`* (string) | Tous |
| `/dev web useragent` | `web_useragent` | Analyser un User-Agent | `ua`* (string) | Tous |
| `/dev web ipcalc` | `web_ipcalc` | Calculatrice IP / CIDR (IPv4 et IPv6) | `cidr`* (string) | Tous |
| `/dev web status` | `web_status` | État des services (GitHub, Discord, Cloudflare, npm, Reddit) | `service` (choice) | Tous |
| `/dev encode base64img` | `encode_base64img` | Convertir une image en base64 (ou data URI) en fichier | `base64` (string), `fichier` (attachment), `nom` (string) | Tous |
| `/dev encode entities` | `encode_entities` | Encoder / décoder des entités HTML | `texte`* (string), `mode` (choice), `style` (choice) | Tous |
| `/dev encode jwt` | `encode_jwt` | Décoder un JWT (sans vérifier la signature) | `jeton`* (string) | Tous |
| `/dev encode hash` | `encode_hash` | Empreintes MD5/SHA d'un fichier, d'une URL ou d'un texte | `url` (string), `fichier` (attachment), `texte` (string) | Tous |
| `/dev search stackoverflow` | `search_stackoverflow` | Rechercher une question sur Stack Overflow | `question`* (string), `tag` (string) | Tous |
| `/dev search mdn` | `search_mdn` | Rechercher dans la documentation MDN | `recherche`* (string), `langue` (choice) | Tous |
| `/dev run` | `run_js` | Exécuter du JavaScript isolé (2 s, sans accès système) | `code`* (string) | Tous |


## 🔔 Notifications <a id="notifications"></a>

`notifications` — Mots-clés surveillés, abonnements aux salons/rôles, récapitulatifs par MP, historique des mentions et alertes staff. 

**Paramètres (10)** : `maxKeywords` (integer, défaut `20`) — Mots-clés max par membre · `keywordCooldown` (duration, défaut `5m`) — Cooldown par mot-clé et salon · `maxFollows` (integer, défaut `10`) — Abonnements max par membre · `followCooldown` (duration, défaut `10m`) — Cooldown des abonnements (par salon) · `trackMentions` (boolean, défaut `true`) — Historique des mentions · `digestHour` (integer, défaut `18`) — Heure d'envoi des récapitulatifs · `digestDay` (choice, défaut `1`) — Jour du récapitulatif hebdomadaire · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire · `staffAlertCooldown` (duration, défaut `1m`) — Cooldown des alertes staff (par mot et salon) · `ignoredChannels` (list) — Salons ignorés

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/notifications keyword add` | `keyword_add` | Surveiller un mot-clé (MP quand il apparaît) | `mot`* (string) | Tous |
| `/notifications keyword remove` | `keyword_remove` | Ne plus surveiller un mot-clé | `mot`* (string) | Tous |
| `/notifications keyword list` | `keyword_list` | Vos mots-clés surveillés | — | Tous |
| — | `keyword_purge` | Supprimer le mot-clé d'un membre (admin) | `id`* (integer) | ManageGuild |
| `/notifications follow channel` | `follow_channel` | Suivre un salon (MP à chaque nouveau message ou récapitulatif) | `salon`* (channel) | Tous |
| `/notifications follow role` | `follow_role` | Être prévenu quand un rôle est mentionné | `role`* (role) | Tous |
| `/notifications follow remove` | `follow_remove` | Ne plus suivre un salon ou un rôle | `salon` (channel), `role` (role) | Tous |
| `/notifications follow list` | `follow_list` | Vos abonnements | — | Tous |
| `/notifications digest` | `digest` | Récapitulatif par MP des salons suivis | `mode`* (choice) | Tous |
| `/notifications mentions` | `mentions` | Vos 20 dernières mentions sur le serveur | `limit` (integer) | Tous |
| `/notifications pause` | `pause` | Suspendre vos notifications | `duree`* (duration) | Tous |
| `/notifications resume` | `resume` | Réactiver vos notifications | — | Tous |
| `/notifications settings` | `settings` | Vos réglages de notification | — | Tous |
| `/notifications staffalert add` | `staffalert_add` | Alerte dans un salon staff quand un mot-clé apparaît | `mot`* (string), `salon`* (channel) | ManageGuild |
| `/notifications staffalert remove` | `staffalert_remove` | Supprimer une alerte staff | `id`* (integer) | ManageGuild |
| `/notifications staffalert list` | `staffalert_list` | Lister les alertes staff | — | ManageGuild |

**Vues du panel** : Alertes staff, Mots-clés des membres


## ⏰ Rappels <a id="reminders"></a>

`reminders` — Rappels personnels, de salon (avec ping de rôle), à date fixe ou récurrents, avec report (snooze). 

**Paramètres (3)** : `defaultDestination` (choice, défaut `dm`) — Destination par défaut · `maxPerUser` (integer, défaut `25`) — Rappels actifs max par membre · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/remind me` | `me` | Me rappeler quelque chose dans un délai | `duree`* (duration), `texte`* (text), `destination` (choice) | Tous |
| `/remind channel` | `channel` | Programmer un rappel dans un salon (avec ping de rôle) | `salon`* (channel), `duree`* (duration), `texte`* (text), `role` (role) | ManageMessages |
| `/remind at` | `at` | Rappel à une date/heure précise | `date`* (string), `texte`* (text), `destination` (choice), `fuseau` (string) | Tous |
| `/remind every` | `every` | Rappel récurrent (min. toutes les heures) | `intervalle`* (duration), `texte`* (text), `salon` (channel), `debut` (string) | Tous |
| `/remind list` | `list` | Lister mes rappels | `tous` (boolean) | Tous |
| `/remind delete` | `delete` | Supprimer un rappel | `id`* (integer) | Tous |
| `/remind clear` | `clear` | Supprimer tous mes rappels | — | Tous |

**Vues du panel** : Rappels


## 🔤 Outils texte <a id="textutils"></a>

`textutils` — Transformations de texte (styles unicode, zalgo, morse, binaire…), analyse, diff, pastes publics, snippets personnels, aperçu markdown/embed. 

**Paramètres (4)** : `pasteTtl` (string, défaut `7d`) — Expiration par défaut des pastes · `pasteMaxLength` (integer, défaut `100000`) — Taille maximale d'un paste (caractères) · `allowPaste` (boolean, défaut `true`) — Autoriser la création de pastes · `snippetLimit` (integer, défaut `50`) — Snippets maximum par utilisateur

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/text style upper` | `style_upper` | Mettre en MAJUSCULES | `texte`* (string) | Tous |
| `/text style lower` | `style_lower` | Mettre en minuscules | `texte`* (string) | Tous |
| `/text style title` | `style_title` | Mettre En Forme De Titre | `texte`* (string) | Tous |
| `/text style smallcaps` | `style_smallcaps` | Petites capitales (ᴛᴇxᴛᴇ) | `texte`* (string) | Tous |
| `/text style bubble` | `style_bubble` | Lettres en bulles (ⓣⓔⓧⓣⓔ) | `texte`* (string) | Tous |
| `/text style fullwidth` | `style_fullwidth` | Pleine chasse (ｔｅｘｔｅ) | `texte`* (string) | Tous |
| `/text style vaporwave` | `style_vaporwave` | Vaporwave (Ａ Ｅ Ｓ Ｔ) | `texte`* (string) | Tous |
| `/text style fancy` | `style_fancy` | Styles unicode (gras, gothique…) | `texte`* (string), `style` (choice) | Tous |
| `/text style zalgo` | `style_zalgo` | Texte maudit (Z̷a̶l̸g̵o̷) | `texte`* (string), `intensite` (integer), `retirer` (boolean) | Tous |
| `/text style morse` | `style_morse` | Encoder / décoder du morse | `texte`* (string), `mode` (choice) | Tous |
| `/text style binary` | `style_binary` | Encoder / décoder du binaire | `texte`* (string), `mode` (choice) | Tous |
| `/text style reverse` | `style_reverse` | Inverser le texte | `texte`* (string) | Tous |
| `/text style emojify` | `style_emojify` | Lettres → :regional_indicator: | `texte`* (string) | Tous |
| `/text style spoiler` | `style_spoiler` | Spoiler par lettre ou par mot | `texte`* (string), `mode` (choice) | Tous |
| `/text style mock` | `style_mock` | tExTe mOqUeUr | `texte`* (string), `aleatoire` (boolean) | Tous |
| `/text style leet` | `style_leet` | L33t 5p34k | `texte`* (string), `niveau` (choice) | Tous |
| `/text style clap` | `style_clap` | Mots 👏 séparés 👏 par 👏 des 👏 emojis | `texte`* (string), `emoji` (string) | Tous |
| `/text style strike` | `style_strike` | T̶e̶x̶t̶e̶ ̶b̶a̶r̶r̶é̶ (unicode) | `texte`* (string) | Tous |
| `/text style flip` | `style_flip` | Texte à l'envers (ʇxǝʇ) | `texte`* (string) | Tous |
| `/text wordcount` | `wordcount` | Compter mots, caractères, lignes, temps de lecture | `texte` (string), `fichier` (attachment) | Tous |
| `/text count` | `count` | Compter les occurrences d'un terme (ou mots fréquents) | `texte`* (string), `terme` (string), `casse` (boolean), `mot_entier` (boolean) | Tous |
| `/text case` | `case_detect` | Détecter la casse (camelCase, snake_case…) et convertir | `texte`* (string) | Tous |
| `/text slugify` | `slugify` | Transformer un texte en slug d'URL | `texte`* (string), `separateur` (choice) | Tous |
| `/text lorem` | `lorem` | Générer du faux texte (lorem ipsum) | `unite` (choice), `nombre` (integer), `classique` (boolean) | Tous |
| `/text unicode` | `unicode` | Infos unicode sur des caractères (nom, code point…) | `caracteres`* (string) | Tous |
| `/text diff` | `diff` | Différences ligne par ligne entre deux textes | `texte_a` (string), `texte_b` (string), `fichier_a` (attachment), `fichier_b` (attachment), `contexte` (boolean) | Tous |
| `/text markdown` | `markdown` | Prévisualiser du markdown Discord dans un embed | `texte`* (string), `source` (boolean) | Tous |
| `/text embed` | `embed_json` | Valider et afficher un embed depuis du JSON | `json` (string), `fichier` (attachment) | Tous |
| `/text template` | `template` | Tester le rendu d'un modèle avec les variables du bot | `modele` (string) | Tous |
| `/text lines sort` | `lines_sort` | Trier des lignes | `texte` (string), `fichier` (attachment), `ordre` (choice), `numerique` (boolean) | Tous |
| `/text lines unique` | `lines_unique` | Supprimer les lignes en double | `texte` (string), `fichier` (attachment), `casse` (boolean) | Tous |
| `/text lines shuffle` | `lines_shuffle` | Mélanger des lignes | `texte` (string), `fichier` (attachment) | Tous |
| `/text lines number` | `lines_number` | Numéroter des lignes | `texte` (string), `fichier` (attachment), `debut` (integer) | Tous |
| `/text snippet save` | `snippet_save` | Enregistrer un snippet personnel | `nom`* (string), `contenu`* (string) | Tous |
| `/text snippet get` | `snippet_get` | Afficher un de vos snippets | `nom`* (string) | Tous |
| `/text snippet list` | `snippet_list` | Lister vos snippets | — | Tous |
| `/text snippet delete` | `snippet_delete` | Supprimer un de vos snippets | `nom`* (string) | Tous |
| `/text paste create` | `paste_create` | Créer un paste public (lien web) | `texte` (string), `fichier` (attachment), `titre` (string), `langage` (string), `expiration` (duration) | Tous |
| `/text paste share` | `paste_share` | Transformer un message en paste (lien partageable) | `message_id`* (string), `salon` (channel) | Tous |
| `/text paste view` | `paste_view` | Afficher un paste | `id`* (string) | Tous |
| `/text paste list` | `paste_list` | Lister les pastes (les vôtres, ou tous pour les modérateurs) | `tous` (boolean) | Tous |
| `/text paste delete` | `paste_delete` | Supprimer un paste (le vôtre, ou n'importe lequel avec Gérer les messages) | `id`* (string) | Tous |

**Vues du panel** : Pastes


## 📊 Tickers <a id="tickers"></a>

`tickers` — Salons et tableau mis à jour automatiquement : cryptos, actions, devises, météo, comptes à rebours, abonnés YouTube/Twitch, étoiles GitHub, stats du serveur, API JSON. 

**Paramètres (10)** : `autoCreateChannel` (boolean, défaut `true`) — Créer un salon vocal verrouillé pour chaque ticker · `category` (channel) — Catégorie des salons créés · `defaultInterval` (string, défaut `15m`) — Intervalle par défaut · `maxTickers` (integer, défaut `15`) — Nombre max. de tickers · `boardChannel` (channel) — Salon du tableau · `boardMessageId` (string) — Message du tableau (automatique) · `youtubeKey` (string) — Clé YouTube Data API (optionnelle) · `twitchClientId` (string) — Twitch Client ID · `twitchClientSecret` (string) — Twitch Client Secret · `githubToken` (string) — Jeton GitHub (optionnel)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/tickers add crypto` | `add_crypto` | Cours d'une cryptomonnaie (CoinGecko) | `symbole`* (string), `devise` (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add stock` | `add_stock` | Cours d'une action (Yahoo Finance, repli Stooq) | `symbole`* (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add forex` | `add_forex` | Taux de change (BCE via Frankfurter) | `de`* (string), `vers`* (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add weather` | `add_weather` | Température actuelle d'une ville (Open-Meteo) | `ville`* (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add countdown` | `add_countdown` | Compte à rebours vers une date (« 🎉 Noël : J-12 ») | `date`* (date), `libelle`* (string), `emoji` (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add youtube` | `add_youtube` | Abonnés d'une chaîne YouTube | `chaine`* (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add twitch` | `add_twitch` | Followers d'une chaîne Twitch (clés Twitch requises) | `chaine`* (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add github` | `add_github` | Étoiles d'un dépôt GitHub | `depot`* (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add server` | `add_server` | Statistique du serveur (membres, boosts…) — tableau par défaut | `metrique`* (choice), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers add custom` | `add_custom` | Valeur extraite d'une API JSON | `url`* (string), `chemin`* (string), `libelle`* (string), `suffixe` (string), `emoji` (string), `salon` (channel), `format` (string), `intervalle` (duration), `tableau_seul` (boolean) | ManageChannels |
| `/tickers list` | `list` | Lister les tickers du serveur | — | Tous |
| `/tickers remove` | `remove` | Supprimer un ticker | `id`* (integer), `supprimer_salon` (boolean) | ManageChannels |
| `/tickers refresh` | `refresh` | Rafraîchir un ticker (ou tous) maintenant | `id` (integer) | ManageChannels |
| `/tickers pause` | `pause` | Mettre un ticker en pause | `id`* (integer) | ManageChannels |
| `/tickers resume` | `resume` | Reprendre un ticker en pause | `id`* (integer) | ManageChannels |
| `/tickers edit` | `edit` | Modifier le format, le libellé ou l'intervalle d'un ticker | `id`* (integer), `format` (string), `libelle` (string), `intervalle` (duration) | ManageChannels |
| `/tickers board` | `board` | Tableau (un message) regroupant tous les tickers, mis à jour toutes les 10 min | `salon` (channel), `desactiver` (boolean) | ManageChannels |

**Vues du panel** : Tickers


## 🧰 Boîte à outils <a id="tools"></a>

`tools` — Mots de passe, encodage, hachage, chiffrement AES, JWT, UUID, JSON, regex, QR codes, raccourcisseur de liens, aléatoire, comptes à rebours. 

**Paramètres (4)** : `shortBaseUrl` (string) — URL de base des liens courts · `shortenerStaffOnly` (boolean, défaut `false`) — Raccourcisseur réservé au staff · `maxLinksPerUser` (integer, défaut `50`) — Liens courts max par membre · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/tools password` | `password` | Générer des mots de passe sécurisés | `longueur` (integer), `nombre` (integer), `majuscules` (boolean), `minuscules` (boolean), `chiffres` (boolean), `symboles` (boolean), `sans_ambigus` (boolean) | Tous |
| `/tools passphrase` | `passphrase` | Générer une phrase de passe (mots français) | `mots` (integer), `separateur` (string), `majuscules` (boolean), `chiffre` (boolean), `nombre` (integer) | Tous |
| `/tools encode` | `encode` | Encoder un texte (base64, hex, url, binaire…) | `format`* (choice), `texte`* (text) | Tous |
| `/tools decode` | `decode` | Décoder un texte (base64, hex, url, binaire…) | `format`* (choice), `texte`* (text) | Tous |
| `/tools hash` | `hash` | Calculer l'empreinte d'un texte | `algo`* (choice), `texte`* (text) | Tous |
| `/tools encrypt` | `encrypt` | Chiffrer un texte (AES-256-GCM + mot de passe) | `texte`* (text), `mot_de_passe`* (string) | Tous |
| `/tools decrypt` | `decrypt` | Déchiffrer un texte chiffré avec /tools encrypt | `donnees`* (text), `mot_de_passe`* (string) | Tous |
| `/tools jwt` | `jwt` | Décoder un jeton JWT (sans vérifier la signature) | `token`* (text) | Tous |
| `/tools uuid` | `uuid` | Générer des UUID (v4 ou v7) | `version` (choice), `nombre` (integer) | Tous |
| `/tools lorem` | `lorem` | Générer du faux texte (lorem ipsum) | `paragraphes` (integer), `mots` (integer) | Tous |
| `/tools json` | `json` | Formater, minifier ou valider du JSON | `json`* (text), `mode` (choice) | Tous |
| `/tools regex` | `regex` | Tester une expression régulière | `motif`* (string), `texte`* (text), `drapeaux` (string) | Tous |
| `/tools shorten` | `shorten` | Raccourcir une URL | `url`* (string), `code` (string), `expiration` (duration) | Tous |
| `/tools links` | `links` | Lister les liens courts | `utilisateur` (user) | Tous |
| `/tools unshorten` | `unshorten` | Révéler la destination d'un lien court | `url`* (string) | Tous |
| `/tools delete` | `link_delete` | Supprimer un lien court | `code`* (string) | Tous |
| `/tools qr generate` | `qr_generate` | Générer un QR code | `texte`* (text), `taille` (integer), `couleur` (color), `fond` (color), `correction` (choice) | Tous |
| `/tools qr read` | `qr_read` | Lire le QR code d'une image | `image_url` (string), `attachment` (attachment) | Tous |
| `/tools timestamp` | `timestamp_tool` | Convertir un timestamp Unix ⇄ date | `valeur` (string), `fuseau` (string) | Tous |
| `/tools random` | `random` | Nombre(s) aléatoire(s) entre min et max | `min` (integer), `max` (integer), `nombre` (integer), `uniques` (boolean) | Tous |
| `/tools choose` | `choose` | Choisir au hasard parmi des options | `options`* (list), `nombre` (integer) | Tous |
| `/tools countdown` | `countdown` | Compte à rebours vers une date | `cible`* (string), `titre` (string), `annoncer` (boolean) | Tous |

**Vues du panel** : Liens courts


## 🔧 Utilitaires <a id="utility"></a>

`utility` — Infos membres/serveur, traduction, météo, convertisseurs, calculatrice, OCR, AFK, snipe, émojis et outils divers. 

**Paramètres (15)** : `defaultLanguage` (string, défaut `fr`) — Langue par défaut · `deeplKey` (string) — Clé API DeepL · `libreTranslateUrl` (string) — URL LibreTranslate · `libreTranslateKey` (string) — Clé LibreTranslate · `flagTranslation` (boolean, défaut `true`) — Traduction par réaction drapeau · `flagTranslationMode` (choice, défaut `channel`) — Réponse des traductions par drapeau · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire par défaut · `ocrSpaceKey` (string) — Clé API OCR.space · `ocrAllowDemo` (boolean, défaut `true`) — Utiliser la clé de démonstration OCR.space · `afkEnabled` (boolean, défaut `true`) — Activer le statut AFK · `afkNickname` (boolean, défaut `false`) — Préfixer le pseudo par [AFK] · `snipeEnabled` (boolean, défaut `true`) — Activer /snipe et editsnipe · `snipeMaxAgeMinutes` (integer, défaut `60`) — Durée de conservation des snipes (min) · `weatherWindThreshold` (integer, défaut `70`) — Seuil d'alerte vent (km/h) · `weatherRainThreshold` (number, défaut `30`) — Seuil d'alerte pluie (mm/jour)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/userinfo` | `userinfo` | Informations détaillées sur un membre | `user` (user) | Tous |
| `/util serverinfo` | `serverinfo` | Informations sur le serveur | — | Tous |
| `/avatar` | `avatar` | Afficher l'avatar (et la bannière) d'un membre | `user` (user) | Tous |
| `/util roleinfo` | `roleinfo` | Informations sur un rôle | `role`* (role) | Tous |
| `/util channelinfo` | `channelinfo` | Informations sur un salon | `channel` (channel) | Tous |
| `/util inviteinfo` | `inviteinfo` | Informations sur une invitation Discord | `code`* (string) | Tous |
| `/util emoji list` | `emoji_list` | Lister les émojis du serveur | — | Tous |
| `/util emoji add` | `emoji_add` | Ajouter un émoji depuis une URL ou une image | `nom`* (string), `url` (string), `image` (attachment) | ManageGuildExpressions |
| `/util emoji steal` | `emoji_steal` | Copier des émojis d'un autre serveur | `emojis`* (string), `nom` (string) | ManageGuildExpressions |
| `/util timestamp` | `timestamp` | Générer les balises <t:…> Discord pour une date | `date` (string), `fuseau` (string) | Tous |
| `/util calc` | `calc` | Calculatrice (+ - * / % ^ !, sqrt, sin, log…) | `expression`* (string), `angle` (choice) | Tous |
| `/util color` | `color` | Aperçu et conversions d'une couleur | `couleur`* (string) | Tous |
| `/util permissions` | `permissions` | Permissions d'un membre (globales ou dans un salon) | `user` (user), `channel` (channel) | Tous |
| `/util membercount` | `membercount` | Nombre de membres du serveur | — | Tous |
| `/util firstmessage` | `firstmessage` | Premier message d'un salon | `channel` (channel) | Tous |
| `/util define` | `define` | Définition d'un mot anglais (dictionnaire) | `mot`* (string) | Tous |
| `/util ocr` | `ocr` | Extraire le texte d'une image (OCR) | `image_url` (string), `attachment` (attachment), `langue` (choice) | Tous |
| `/translate` | `translate` | Traduire un texte | `langue_cible`* (string), `texte`* (text), `source` (string) | Tous |
| `/weather` | `weather` | Météo actuelle et prévisions | `ville`* (string), `jours` (integer) | Tous |
| `/util weatheralerts add` | `weather_watch_add` | Surveiller la météo d'une ville (alertes auto) | `ville`* (string), `salon`* (channel) | ManageGuild |
| `/util weatheralerts list` | `weather_watch_list` | Lister les villes surveillées | — | Tous |
| `/util weatheralerts remove` | `weather_watch_remove` | Arrêter la surveillance d'une ville | `id`* (integer) | ManageGuild |
| `/util convert currency` | `convert_currency` | Convertir des devises et cryptomonnaies | `montant`* (number), `de`* (string), `vers`* (string) | Tous |
| `/util convert units` | `convert_units` | Convertir des unités (longueur, masse, température…) | `valeur`* (number), `de`* (string), `vers`* (string) | Tous |
| `/util convert timezone` | `convert_timezone` | Convertir une heure d'un fuseau à un autre | `heure`* (string), `vers`* (string), `de` (string) | Tous |
| `/util convert base` | `convert_base` | Convertir un nombre entre bases (2, 8, 10, 16…) | `nombre`* (string), `de`* (integer), `vers`* (integer) | Tous |
| `/util afk` | `afk` | Se déclarer absent (AFK) | `raison` (string) | Tous |
| — | `afk_remove` | Retirer le statut AFK d'un membre | `user`* (user) | ManageNicknames |
| `/util snipe` | `snipe` | Voir le dernier message supprimé du salon | `position` (integer), `channel` (channel) | Tous |
| `/util editsnipe` | `editsnipe` | Voir le dernier message modifié du salon | `position` (integer), `channel` (channel) | Tous |

**Menus contextuels** : « Traduire », « Extraire le texte (OCR) »

**Vues du panel** : Membres AFK, Alertes météo


# Communauté

## 📊 Analytique <a id="analytics"></a>

`analytics` — Tableaux de bord d'activité : messages, membres actifs, croissance, heatmap, rétention, commandes, modération, rapports automatiques. 

**Paramètres (4)** : `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire des statistiques · `ignoredChannels` (list) — Salons ignorés · `countBots` (boolean, défaut `false`) — Compter les messages des bots · `trackEmojis` (boolean, défaut `true`) — Compter les emojis utilisés

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/analytics overview` | `overview` | Vue d'ensemble : messages, actifs, arrivées/départs, rétention | `jours` (integer) | ManageGuild |
| `/analytics heatmap` | `heatmap` | Heatmap d'activité (jours × heures) en image | `jours` (integer) | ManageGuild |
| `/analytics growth` | `growth` | Courbe des membres (arrivées − départs) en image | `jours` (integer) | ManageGuild |
| `/analytics channels` | `channels` | Salons les plus actifs | `jours` (integer), `limite` (integer) | ManageGuild |
| `/analytics users` | `users` | Membres les plus actifs | `jours` (integer), `limite` (integer) | ManageGuild |
| `/analytics emojis` | `emojis` | Emojis les plus utilisés | `jours` (integer) | ManageGuild |
| `/analytics commands` | `commands` | Usage des actions du bot (audit) : top et par source | `jours` (integer) | ManageGuild |
| `/analytics moderation` | `moderation` | Cas de modération par semaine | `semaines` (integer) | ManageGuild |
| `/analytics hours` | `hours` | Heures les plus actives | `jours` (integer) | ManageGuild |
| `/analytics retention` | `retention` | Rétention : membres arrivés il y a N jours encore présents | `jours` (integer) | ManageGuild |
| `/analytics export` | `export` | Exporter les statistiques quotidiennes en CSV | `jours` (integer) | ManageGuild |
| `/analytics compare` | `compare` | Comparer deux périodes (7j, 30j, 7j@7j, 2026-09, 2026-09-01..2026-09-15) | `periode1`* (string), `periode2` (string) | ManageGuild |
| `/analytics report schedule` | `report_schedule` | Programmer un rapport automatique | `salon`* (channel), `frequence` (choice), `jour` (choice), `heure` (integer) | ManageGuild |
| `/analytics report stop` | `report_stop` | Arrêter le rapport automatique | — | ManageGuild |
| `/analytics report status` | `report_status` | Voir le rapport programmé | — | ManageGuild |
| `/analytics report now` | `report_now` | Envoyer un rapport maintenant | `salon` (channel), `frequence` (choice) | ManageGuild |

**Vues du panel** : Vue d'ensemble (7 jours)


## 📝 Candidatures <a id="applications"></a>

`applications` — Formulaires de candidature et questionnaires (modals paginés), revue avec boutons, rôles à l'acceptation, exports CSV et avis sur le serveur. 

**Paramètres (11)** : `defaultReviewChannel` (channel) — Salon de revue par défaut · `reviewerRoles` (list) — Rôles examinateurs · `logChannel` (channel) — Salon des logs · `dmResults` (boolean, défaut `true`) — Prévenir le candidat par MP · `requireDenyReason` (boolean, défaut `false`) — Raison obligatoire pour un refus · `reapplyCooldown` (duration, défaut `0`) — Délai avant de recandidater après un refus · `acceptMessage` (text, défaut `Bonne nouvelle ! Votre candidature **{fo`) — Message d'acceptation (MP) · `denyMessage` (text, défaut `Votre candidature **{form}** sur **{serv`) — Message de refus (MP) · `feedbackChannel` (channel) — Salon des avis · `feedbackAnonymous` (boolean, défaut `true`) — Avis anonymes · `feedbackCooldown` (duration, défaut `7d`) — Délai entre deux avis d'un même membre

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/apply form create` | `form_create` | Créer un formulaire de candidature | `nom`* (string), `description` (text), `anonyme` (boolean) | ManageGuild |
| `/apply form list` | `form_list` | Lister les formulaires | — | Tous |
| `/apply form info` | `form_info` | Détails d'un formulaire | `form`* (string) | Tous |
| `/apply form delete` | `form_delete` | Supprimer un formulaire et ses candidatures | `form`* (string), `garder_reponses` (boolean) | ManageGuild |
| `/apply form toggle` | `form_toggle` | Ouvrir / fermer un formulaire | `form`* (string) | ManageGuild |
| `/apply form setrole` | `form_setrole` | Rôle attribué quand une candidature est acceptée | `form`* (string), `role` (role) | ManageGuild, ManageRoles |
| `/apply form setchannel` | `form_setchannel` | Salon où arrivent les candidatures à examiner | `form`* (string), `salon` (channel) | ManageGuild |
| `/apply form setpingrole` | `form_setpingrole` | Rôle mentionné à chaque nouvelle candidature | `form`* (string), `role` (role) | ManageGuild |
| `/apply form config` | `form_config` | Options d'un formulaire (anonymat, MP, délai, messages) | `form`* (string), `anonyme` (boolean), `mp_resultat` (boolean), `delai` (duration), `description` (text), `message_accepte` (text), `message_refuse` (text) | ManageGuild |
| `/apply form post` | `form_post` | Publier le message avec le bouton « Candidater » | `form`* (string), `salon` (channel), `message` (text) | ManageGuild |
| `/apply question add` | `question_add` | Ajouter une question à un formulaire | `form`* (string), `question`* (string), `type` (choice), `obligatoire` (boolean), `choix` (list), `aide` (string), `max` (integer) | ManageGuild |
| `/apply question list` | `question_list` | Lister les questions d'un formulaire | `form`* (string) | Tous |
| `/apply question remove` | `question_remove` | Retirer une question (par numéro) | `form`* (string), `numero`* (integer) | ManageGuild |
| `/apply question move` | `question_move` | Déplacer une question | `form`* (string), `numero`* (integer), `position`* (integer) | ManageGuild |
| `/apply start` | `start` | Remplir un formulaire de candidature | `form`* (string) | Tous |
| `/apply submit` | `submit` | Envoyer une candidature avec les réponses en JSON (API / CLI) | `form`* (string), `reponses`* (json), `membre` (user) | Tous |
| `/apply withdraw` | `withdraw` | Retirer votre candidature en cours | `form`* (string) | Tous |
| `/apply list` | `list` | Lister les candidatures (les vôtres si vous n'êtes pas examinateur) | `form` (string), `status` (choice), `page` (integer) | Tous |
| `/apply view` | `view` | Voir une candidature | `id`* (integer) | Tous |
| `/apply review` | `review` | Accepter, refuser ou mettre en attente une candidature | `id`* (integer), `decision`* (choice), `raison` (text) | Tous |
| `/apply reopen` | `reopen` | Rouvrir une candidature traitée | `id`* (integer), `retirer_role` (boolean) | Tous |
| `/apply stats` | `stats` | Statistiques des candidatures | `form` (string) | Tous |
| `/apply export` | `export` | Exporter les candidatures d'un formulaire en CSV | `form`* (string), `status` (choice) | Tous |
| `/apply feedback give` | `feedback_give` | Donner votre avis sur le serveur (note 1-5 + commentaire) | `note` (integer), `commentaire` (text) | Tous |
| `/apply feedback stats` | `feedback_stats` | Statistiques des avis sur le serveur | `jours` (integer) | Tous |

**Vues du panel** : Formulaires, Candidatures


## 🎂 Anniversaires <a id="birthday"></a>

`birthday` — Enregistrez les anniversaires des membres : annonce quotidienne, rôle d'anniversaire pendant 24 h, prochains anniversaires. 

**Paramètres (13)** : `channel` (channel) — Salon des annonces · `role` (role) — Rôle d'anniversaire (24 h) · `message` (text, défaut `🎂 Joyeux anniversaire {user.mention} !{`) — Message d'annonce · `embed` (boolean, défaut `true`) — Annonce en embed · `embedTitle` (string, défaut `🎉 Joyeux anniversaire !`) — Titre de l'embed · `embedColor` (color, défaut `#EB459E`) — Couleur de l'embed · `announceHour` (integer, défaut `9`) — Heure de l'annonce (0-23) · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire · `allowYear` (boolean, défaut `true`) — Autoriser l'année de naissance · `showAge` (boolean, défaut `true`) — Afficher l'âge dans l'annonce · `dmEnabled` (boolean, défaut `false`) — Souhaiter aussi en MP · `dmMessage` (text, défaut `Toute l'équipe de **{server.name}** te s`) — Message privé · `selfOnly` (boolean, défaut `false`) — Seuls les membres peuvent définir leur propre date

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/birthday set` | `birthday_set` | Enregistrer votre date d'anniversaire | `day`* (integer), `month`* (integer), `year` (integer), `user` (user) | Tous |
| `/birthday remove` | `birthday_remove` | Supprimer votre anniversaire | `user` (user) | Tous |
| `/birthday user` | `birthday_user` | Voir l'anniversaire d'un membre | `user` (user) | Tous |
| `/birthday list` | `birthday_list` | Lister les anniversaires (optionnellement d'un mois) | `month` (integer) | Tous |
| `/birthday next` | `birthday_next` | Voir les prochains anniversaires | `limit` (integer) | Tous |
| `/birthday setup` | `birthday_setup` | Configurer le salon, le rôle, l'heure et le fuseau des annonces | `channel` (channel), `role` (role), `hour` (integer), `timezone` (string) | ManageGuild |
| `/birthday announce` | `birthday_announce` | Lancer maintenant l'annonce des anniversaires du jour | `force` (boolean) | ManageGuild |

**Vues du panel** : Anniversaires


## 📅 Évènements <a id="events"></a>

`events` — Évènements Discord planifiés, rappels, rôles d'évènement, récurrences, modèles, compte à rebours, calendrier, export ICS et RSVP. 

**Paramètres (11)** : `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire · `reminders` (list) — Rappels avant le début · `reminderChannel` (channel) — Salon des rappels · `reminderPingRole` (role) — Rôle mentionné dans les rappels · `mentionSubscribers` (boolean, défaut `false`) — Mentionner les inscrits dans le rappel · `dmSubscribers` (boolean, défaut `false`) — Envoyer le rappel en MP aux inscrits · `reminderTemplate` (text, défaut `{mentions} ⏰ **{event.name}** commence {`) — Modèle du rappel · `announceChannel` (channel) — Salon d'annonce par défaut · `defaultDuration` (duration, défaut `2h`) — Durée par défaut (évènements externes) · `recurringLead` (duration, défaut `3d`) — Création anticipée des récurrences · `logChannel` (channel) — Salon des logs

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/events create` | `create` | Créer un évènement Discord planifié | `nom`* (string), `date`* (string), `fin` (string), `salon` (channel), `lieu` (string), `description` (text), `image` (string) | ManageEvents |
| `/events list` | `list` | Lister les évènements du serveur | `statut` (choice) | Tous |
| `/events info` | `info` | Détails d'un évènement | `id`* (string) | Tous |
| `/events edit` | `edit` | Modifier un évènement | `id`* (string), `nom` (string), `date` (string), `fin` (string), `salon` (channel), `lieu` (string), `description` (text), `image` (string) | ManageEvents |
| `/events cancel` | `cancel` | Annuler (ou supprimer) un évènement | `id`* (string), `raison` (string), `supprimer` (boolean) | ManageEvents |
| `/events start` | `start` | Démarrer un évènement maintenant | `id`* (string) | ManageEvents |
| `/events end` | `end` | Terminer un évènement en cours | `id`* (string) | ManageEvents |
| `/events interested` | `interested` | Liste des membres intéressés par un évènement | `id`* (string) | Tous |
| `/events role` | `role` | Rôle temporaire donné aux inscrits (retiré à la fin) | `id`* (string), `role` (role), `retirer` (boolean) | ManageRoles, ManageEvents |
| `/events countdown` | `countdown` | Compte à rebours (salon vocal renommé ou message mis à jour) | `id`* (string), `salon`* (channel), `libelle` (string) | ManageEvents |
| `/events calendar` | `calendar` | Calendrier mensuel des évènements (texte + image) | `mois` (string) | Tous |
| `/events ics` | `ics` | Exporter les évènements au format iCalendar (.ics) | `id` (string) | Tous |
| `/events announce` | `announce` | Annoncer un évènement dans un salon | `id`* (string), `salon` (channel), `message` (text), `mention` (role) | ManageEvents |
| `/events recurring add` | `recurring_add` | Créer un évènement récurrent (cron ou intervalle) | `nom`* (string), `mode`* (choice), `regle`* (string), `debut` (string), `duree` (duration), `salon` (channel), `lieu` (string), `description` (text), `image` (string), `avance` (duration) | ManageEvents |
| `/events recurring list` | `recurring_list` | Lister les évènements récurrents | — | Tous |
| `/events recurring toggle` | `recurring_toggle` | Mettre en pause / reprendre une récurrence | `id`* (integer) | ManageEvents |
| `/events recurring remove` | `recurring_remove` | Supprimer une récurrence | `id`* (integer) | ManageEvents |
| `/events template save` | `template_save` | Enregistrer un modèle (depuis un évènement ou des paramètres) | `nom`* (string), `id` (string), `titre` (string), `description` (text), `salon` (channel), `lieu` (string), `duree` (duration), `image` (string) | ManageEvents |
| `/events template use` | `template_use` | Créer un évènement depuis un modèle | `nom`* (string), `date`* (string), `titre` (string) | ManageEvents |
| `/events template list` | `template_list` | Lister les modèles | — | Tous |
| `/events template delete` | `template_delete` | Supprimer un modèle | `nom`* (string) | ManageEvents |
| `/events rsvp create` | `rsvp_create` | Créer un RSVP interne avec boutons Participe / Peut-être / Non | `titre`* (string), `date`* (string), `salon` (channel), `fin` (string), `description` (text), `lieu` (string), `max` (integer) | ManageEvents |
| `/events rsvp answer` | `rsvp_answer` | Répondre à un RSVP | `id`* (string), `statut`* (choice), `membre` (user) | Tous |
| `/events rsvp view` | `rsvp_view` | Voir un RSVP et ses réponses | `id`* (string) | Tous |
| `/events rsvp list` | `rsvp_list` | Lister les RSVP | `tous` (boolean) | Tous |
| `/events rsvp close` | `rsvp_close` | Clôturer / rouvrir un RSVP | `id`* (string) | ManageEvents |
| `/events rsvp delete` | `rsvp_delete` | Supprimer un RSVP | `id`* (string) | ManageEvents |

**Vues du panel** : Évènements Discord, Récurrences, RSVP


## 🎉 Giveaways <a id="giveaways"></a>

`giveaways` — Concours avec participation par bouton, conditions (rôle, niveau), entrées bonus, tirage automatique et reroll. 

**Paramètres (7)** : `pingRole` (role) — Rôle mentionné au lancement · `pingWinners` (boolean, défaut `true`) — Mentionner les gagnants · `dmWinners` (boolean, défaut `true`) — Prévenir les gagnants par MP · `winMessage` (text, défaut `🎉 Félicitations {winners} ! Vous rempor`) — Message des gagnants · `dmMessage` (text, défaut `🎉 Vous avez gagné **{prize}** sur **{se`) — MP envoyé aux gagnants · `maxRunning` (integer, défaut `20`) — Giveaways simultanés max · `logChannel` (channel) — Salon des logs

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/giveaway start` | `start` | Lancer un giveaway | `duration`* (duration), `winners`* (integer), `prize`* (string), `channel` (channel), `required_role` (role), `required_level` (integer), `bonus_entries` (json), `description` (text), `image` (string) | ManageGuild |
| `/giveaway end` | `end` | Terminer un giveaway maintenant et tirer les gagnants | `id`* (integer) | ManageGuild |
| `/giveaway reroll` | `reroll` | Tirer de nouveaux gagnants pour un giveaway terminé | `id`* (integer), `count` (integer) | ManageGuild |
| `/giveaway cancel` | `cancel` | Annuler un giveaway en cours (sans gagnant) | `id`* (integer) | ManageGuild |
| `/giveaway list` | `list` | Lister les giveaways du serveur | `status` (choice) | Tous |
| `/giveaway edit` | `edit` | Modifier un giveaway en cours | `id`* (integer), `prize` (string), `winners` (integer), `add_time` (duration), `ends_in` (duration), `description` (text), `image` (string), `required_role` (role), `required_level` (integer), `bonus_entries` (json), `clear_role` (boolean) | ManageGuild |
| `/giveaway entries` | `entries` | Voir les participants d'un giveaway | `id`* (integer) | Tous |

**Vues du panel** : Giveaways


## ✉️ Invitations <a id="invites"></a>

`invites` — Suivi des invitations : qui a invité qui, compteurs réels / faux / départs, classement, récompenses automatiques par rôle. 

**Paramètres (8)** : `fakeAccountDays` (integer, défaut `7`) — Compte « faux » si plus récent que (jours) · `joinMessageEnabled` (boolean, défaut `false`) — Annoncer les arrivées avec l'inviteur · `joinChannel` (channel) — Salon des annonces d'arrivée · `joinMessage` (text, défaut `📥 {user.mention} a rejoint le serveur, `) — Message (inviteur connu) · `joinMessageVanity` (text, défaut `📥 {user.mention} a rejoint le serveur v`) — Message (URL personnalisée) · `joinMessageUnknown` (text, défaut `📥 {user.mention} a rejoint le serveur (`) — Message (inviteur inconnu) · `stackRewards` (boolean, défaut `true`) — Cumuler les rôles récompenses · `removeRewardsOnDrop` (boolean, défaut `false`) — Retirer les récompenses si le total baisse

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/invites me` | `invites_me` | Voir vos invitations | — | Tous |
| `/invites user` | `invites_user` | Voir les invitations d'un membre | `user`* (user) | Tous |
| `/invites leaderboard` | `invites_leaderboard` | Classement des meilleurs inviteurs | `limit` (integer) | Tous |
| `/invites whoinvited` | `invites_whoinvited` | Savoir qui a invité un membre | `user`* (user) | Tous |
| `/invites invited` | `invites_invited` | Lister les membres invités par quelqu'un | `user` (user) | Tous |
| `/invites codes` | `invites_codes` | Lister les invitations actives avec leurs utilisations | `user` (user) | Tous |
| `/invites bonus` | `invites_bonus` | Ajouter / retirer des invitations bonus à un membre | `user`* (user), `amount`* (integer) | ManageGuild |
| `/invites reset` | `invites_reset` | Réinitialiser les invitations d'un membre ou de tout le serveur | `target`* (choice), `user` (user) | ManageGuild |
| `/invites rewards add` | `invites_rewards_add` | Ajouter un rôle récompense à partir de N invitations | `invites`* (integer), `role`* (role) | ManageRoles |
| `/invites rewards remove` | `invites_rewards_remove` | Retirer un rôle récompense | `role`* (role) | ManageRoles |
| `/invites rewards list` | `invites_rewards_list` | Lister les rôles récompenses | — | Tous |
| `/invites sync` | `invites_sync` | Resynchroniser le cache des invitations et appliquer les récompenses | — | ManageGuild |

**Vues du panel** : Classement, Arrivées, Récompenses, Invitations actives


## 📈 Niveaux <a id="leveling"></a>

`leveling` — XP textuel et vocal, niveaux, multiplicateurs, boosts, rôles récompenses, carte de rang, classement et succès. 

**Paramètres (33)** : `textXp` (boolean, défaut `true`) — XP par message · `xpMin` (integer, défaut `15`) — XP minimum par message · `xpMax` (integer, défaut `25`) — XP maximum par message · `cooldown` (integer, défaut `60`) — Délai entre deux gains (secondes) · `minMessageLength` (integer, défaut `1`) — Longueur minimale d'un message · `ignoredChannels` (list) — Salons ignorés · `ignoredRoles` (list) — Rôles sans XP · `voiceXp` (boolean, défaut `true`) — XP vocal · `voiceXpPerMinute` (number, défaut `4`) — XP par minute en vocal · `voiceIgnoreAlone` (boolean, défaut `true`) — Exclure les membres seuls · `voiceIgnoreMuted` (boolean, défaut `true`) — Exclure les membres muets / sourds · `voiceIgnoreAfk` (boolean, défaut `true`) — Exclure le salon AFK · `roleMultipliers` (json) — Multiplicateurs par rôle · `channelMultipliers` (json) — Multiplicateurs par salon · `stackMultipliers` (boolean, défaut `false`) — Cumuler les multiplicateurs de rôles · `weekendMultiplier` (number, défaut `1`) — Multiplicateur du week-end · `boostChannel` (channel) — Salon d'annonce des boosts · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire · `formula` (choice, défaut `mee6`) — Formule de niveau · `formulaBase` (integer, défaut `100`) — XP de base · `formulaGrowth` (number, défaut `1.1`) — Croissance (exponentielle) · `rewardMode` (choice, défaut `stack`) — Mode des rôles récompenses · `restoreRewardsOnJoin` (boolean, défaut `true`) — Rendre les récompenses au retour d'un membre · `resetOnLeave` (boolean, défaut `false`) — Effacer l'XP d'un membre qui quitte · `levelUpMode` (choice, défaut `current`) — Annonce de level-up · `levelUpChannel` (channel) — Salon des level-up · `levelUpMessage` (text, défaut `🎉 Bravo {user.mention}, tu passes au ni`) — Message de level-up · `achievementsEnabled` (boolean, défaut `true`) — Succès activés · `achievementAnnounce` (boolean, défaut `true`) — Annoncer les succès débloqués · `achievementChannel` (channel) — Salon des succès · `cardColor` (color, défaut `#5865f2`) — Couleur par défaut des cartes · `allowBackgrounds` (boolean, défaut `true`) — Autoriser les fonds personnalisés · `backgroundMinLevel` (integer, défaut `0`) — Niveau minimum pour un fond personnalisé

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/rank` | `rank` | Afficher la carte de rang d'un membre | `user` (user) | Tous |
| `/leaderboard` | `leaderboard` | Classement XP du serveur | `page` (integer) | Tous |
| `/xp achievements` | `achievements` | Voir les succès débloqués et leur progression | `user` (user) | Tous |
| `/xp leaderboard image` | `leaderboard_image` | Classement top 10 en image | — | Tous |
| `/xp card color` | `card_color` | Choisir la couleur de sa carte de rang | `color`* (color) | Tous |
| `/xp card background` | `card_background` | Définir une image de fond pour sa carte (URL) | `url`* (string) | Tous |
| `/xp card reset` | `card_reset` | Réinitialiser la personnalisation d'une carte | `user` (user) | Tous |
| `/xp add` | `xp_add` | Ajouter de l'XP (ou des niveaux) à un membre | `user`* (user), `amount`* (integer), `type` (choice) | ManageGuild |
| `/xp remove` | `xp_remove` | Retirer de l'XP (ou des niveaux) à un membre | `user`* (user), `amount`* (integer), `type` (choice) | ManageGuild |
| `/xp set` | `xp_set` | Définir l'XP (ou le niveau) d'un membre | `user`* (user), `amount`* (integer), `type` (choice) | ManageGuild |
| `/xp reset` | `xp_reset` | Réinitialiser la progression d'un membre | `user`* (user), `achievements` (boolean) | ManageGuild |
| `/xp resetall` | `xp_resetall` | Réinitialiser TOUTE la progression du serveur | `confirm`* (string), `achievements` (boolean), `remove_roles` (boolean) | Administrator |
| `/xp config` | `xp_config` | Afficher ou modifier la configuration des niveaux | `text_xp` (boolean), `xp_min` (integer), `xp_max` (integer), `cooldown` (integer), `voice_xp` (boolean), `voice_per_minute` (number), `weekend_multiplier` (number), `formula` (choice), `formula_base` (integer), `levelup_mode` (choice), `levelup_channel` (channel), `levelup_message` (string), `reward_mode` (choice), `timezone` (string) | ManageGuild |
| `/xp import` | `xp_import` | Importer des XP (JSON MEE6-like : [{"id":"…","xp":123}]) | `file` (attachment), `data` (json), `mode` (choice) | Administrator |
| `/xp export` | `xp_export` | Exporter la progression du serveur (JSON) | — | ManageGuild |
| `/xp rewards add` | `rewards_add` | Ajouter un rôle récompense à un niveau | `level`* (integer), `role`* (role) | ManageRoles |
| `/xp rewards remove` | `rewards_remove` | Retirer une récompense de niveau | `level`* (integer), `role` (role) | ManageRoles |
| `/xp rewards list` | `rewards_list` | Lister les rôles récompenses | — | Tous |
| `/xp rewards sync` | `rewards_sync` | Appliquer rétroactivement les rôles récompenses à tous les membres | — | ManageRoles |
| `/xp boost start` | `boost_start` | Lancer un boost d'XP temporaire | `multiplier`* (number), `duration`* (duration), `reason` (string), `channel` (channel) | ManageGuild |
| `/xp boost stop` | `boost_stop` | Arrêter un boost d'XP (ou tous) | `id` (integer) | ManageGuild |
| `/xp boost list` | `boost_list` | Boosts d'XP actifs et récents | — | Tous |
| `/xp ignore channel` | `ignore_channel` | Ignorer (ou ne plus ignorer) un salon ou une catégorie | `channel`* (channel) | ManageGuild |
| `/xp ignore role` | `ignore_role` | Ajouter (ou retirer) un rôle sans XP | `role`* (role) | ManageGuild |
| `/xp ignore list` | `ignore_list` | Salons et rôles ignorés | — | Tous |
| `/xp multiplier role` | `multiplier_role` | Définir le multiplicateur d'XP d'un rôle (1 = retirer) | `role`* (role), `multiplier`* (number) | ManageGuild |
| `/xp multiplier channel` | `multiplier_channel` | Définir le multiplicateur d'XP d'un salon ou d'une catégorie (1 = retirer) | `channel`* (channel), `multiplier`* (number) | ManageGuild |
| `/xp multiplier list` | `multiplier_list` | Voir les multiplicateurs d'XP | — | Tous |
| `/xp achievement grant` | `achievement_grant` | Débloquer manuellement un succès pour un membre | `user`* (user), `key`* (string) | ManageGuild |
| `/xp achievement revoke` | `achievement_revoke` | Retirer un succès à un membre | `user`* (user), `key`* (string) | ManageGuild |

**Vues du panel** : Classement, Rôles récompenses, Boosts d'XP, Succès


## 🧭 Accueil & FAQ <a id="onboarding"></a>

`onboarding` — Règlement avec acceptation, messages d'accueil différés, guide du serveur, FAQ avec réponse automatique et présentations. 

**Paramètres (18)** : `rulesTitle` (string, défaut `📜 Règlement`) — Titre du règlement · `rulesText` (text, défaut ``) — Texte du règlement · `rulesEmbed` (json) — Embed du règlement (JSON, prioritaire) · `acceptedRole` (role) — Rôle donné à l'acceptation · `removeRoleOnAccept` (role) — Rôle retiré à l'acceptation (ex : Non vérifié) · `acceptButtonLabel` (string, défaut `J'accepte`) — Texte du bouton · `rulesChannel` (channel) — Salon du règlement · `rulesMessageId` (string) — ID du message de règlement publié · `dripEnabled` (boolean, défaut `true`) — Messages différés actifs · `guideIntro` (text, défaut `Bienvenue sur **{server.name}** ! Voici `) — Introduction du guide · `guideChannels` (list) — Salons importants · `guideRoles` (list) — Rôles présentés · `autoAnswer` (boolean, défaut `false`) — Réponse automatique de la FAQ · `autoAnswerChannels` (list) — Salons de réponse auto (vide = tous) · `autoAnswerThreshold` (number, défaut `0.6`) — Score minimal (0-1) · `autoAnswerCooldown` (duration, défaut `10m`) — Cooldown par question et salon · `introChannel` (channel) — Salon des présentations · `introRole` (role) — Rôle « Présenté »

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/onboarding rules set` | `rules_set` | Définir le règlement (texte ou embed JSON) | `texte` (text), `embed` (json), `titre` (string) | ManageGuild |
| `/onboarding rules show` | `rules_show` | Prévisualiser le règlement | — | Tous |
| `/onboarding rules post` | `rules_post` | Publier le règlement avec le bouton « J'accepte » | `salon`* (channel), `role` (role) | ManageGuild |
| `/onboarding drip add` | `drip_add` | Ajouter un message d'accueil différé (J+1, J+3…) | `delai`* (duration), `message`* (text), `cible` (choice), `salon` (channel), `embed` (boolean) | ManageGuild |
| `/onboarding drip list` | `drip_list` | Lister les messages différés | — | ManageGuild |
| `/onboarding drip remove` | `drip_remove` | Supprimer un message différé | `id`* (integer) | ManageGuild |
| `/onboarding drip test` | `drip_test` | Recevoir un message différé en MP pour le tester | `id` (integer) | ManageGuild |
| `/onboarding guide set` | `guide_set` | Configurer le guide du serveur | `intro` (text), `salons` (list), `roles` (list) | ManageGuild |
| `/onboarding guide show` | `guide_show` | Afficher (ou publier) le guide du serveur | `publier` (channel) | Tous |
| `/onboarding intro channel` | `intro_channel` | Configurer le salon de présentation (bouton + formulaire) | `salon`* (channel), `role` (role), `texte` (text) | ManageGuild |
| `/onboarding welcomer stats` | `welcomer_stats` | Statistiques d'accueil (taux d'acceptation, présentations) | `jours` (integer) | ManageGuild |
| `/onboarding faq add` | `faq_add` | Ajouter une question à la FAQ | `question`* (string), `reponse`* (text), `mots_cles` (list) | ManageMessages |
| `/onboarding faq edit` | `faq_edit` | Modifier une entrée de la FAQ | `id`* (integer), `question` (string), `reponse` (text), `mots_cles` (list) | ManageMessages |
| `/onboarding faq get` | `faq_get` | Afficher une réponse de la FAQ | `id`* (integer), `membre` (user) | Tous |
| `/onboarding faq search` | `faq_search` | Rechercher dans la FAQ | `recherche`* (string) | Tous |
| `/onboarding faq list` | `faq_list` | Lister les questions de la FAQ | — | Tous |
| `/onboarding faq remove` | `faq_remove` | Supprimer une entrée de la FAQ | `id`* (integer) | ManageMessages |

**Vues du panel** : Messages différés, FAQ


## 🤝 Partenariats <a id="partners"></a>

`partners` — Gestion des partenariats (exigences, publication, vérification des invitations), rappels de bump DISBOARD et publicité du serveur. 

**Paramètres (22)** : `partnerChannel` (channel) — Salon des partenariats · `partnerTemplate` (text, défaut `{partner.description}

👥 **{partner.mem`) — Modèle de l'embed · `postContent` (string) — Texte au-dessus de l'embed (optionnel) · `embedColor` (color, défaut `#5865F2`) — Couleur de l'embed · `autoPost` (boolean, défaut `true`) — Publier automatiquement à l'ajout · `deleteOldPost` (boolean, défaut `true`) — Supprimer l'ancienne publication en republiant · `scheduleInterval` (duration) — Intervalle de republication / rappel · `scheduleMode` (choice, défaut `reminder`) — Mode de la planification · `reminderChannel` (channel) — Salon des rappels staff · `minMembers` (integer, défaut `0`) — Membres minimum · `minServerAgeDays` (integer, défaut `0`) — Âge minimum du serveur (jours) · `requirePermanentInvite` (boolean, défaut `true`) — Invitation permanente requise · `requireRepresentative` (boolean, défaut `false`) — Représentant requis · `autoCheck` (boolean, défaut `true`) — Vérifier les invitations chaque jour · `bumpReminder` (boolean, défaut `true`) — Rappel de bump DISBOARD · `bumpChannel` (channel) — Salon du rappel (défaut : salon du bump) · `bumpRole` (role) — Rôle à mentionner · `bumpDelay` (duration, défaut `2h`) — Délai avant rappel · `bumpMessage` (text, défaut `⏰ {role} Il est l'heure de **bumper** le`) — Message de rappel · `bumpThanks` (text, défaut `💖 Merci {user.mention} pour le bump ! (`) — Remerciement (vide = aucun) · `adText` (text, défaut ``) — Notre publicité · `adInvite` (string) — Notre invitation

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/partners add` | `add` | Ajouter un partenaire | `nom`* (string), `invite`* (string), `description`* (text), `representant` (user), `salon` (channel), `ignorer_exigences` (boolean) | ManageGuild |
| `/partners edit` | `edit` | Modifier un partenaire | `id`* (integer), `nom` (string), `description` (text), `invite` (string), `representant` (user), `salon` (channel) | ManageGuild |
| `/partners remove` | `remove` | Supprimer un partenaire | `id`* (integer), `supprimer_message` (boolean) | ManageGuild |
| `/partners list` | `list` | Lister les partenaires | — | Tous |
| `/partners info` | `info` | Détails d'un partenaire | `id`* (integer) | Tous |
| `/partners post` | `post` | Publier l'embed d'un partenaire | `id`* (integer), `salon` (channel) | ManageGuild |
| `/partners verify` | `verify` | Vérifier une invitation face aux exigences (sans l'ajouter) | `invite`* (string) | ManageGuild |
| `/partners check` | `check` | Vérifier la validité des invitations partenaires | — | ManageGuild |
| `/partners schedule` | `schedule` | Rappel ou republication périodique des partenariats | `intervalle` (duration), `mode` (choice), `salon` (channel) | ManageGuild |
| `/partners requirements set` | `requirements_set` | Définir les exigences de partenariat | `membres_min` (integer), `age_min_jours` (integer), `invitation_permanente` (boolean), `representant_requis` (boolean) | ManageGuild |
| `/partners requirements show` | `requirements_show` | Afficher les exigences de partenariat | — | Tous |
| `/partners bump setup` | `bump_setup` | Configurer le rappel de bump DISBOARD | `actif`* (boolean), `salon` (channel), `role` (role) | ManageGuild |
| `/partners bump status` | `bump_status` | État du bump (dernier bump, prochain rappel) | — | Tous |
| `/partners bump stats` | `bump_stats` | Classement des bumpeurs | `periode` (choice) | Tous |
| `/partners ad set` | `ad_set` | Définir la publicité de notre serveur | `texte`* (text), `invitation` (string) | ManageGuild |
| `/partners ad show` | `ad_show` | Afficher notre publicité (prête à copier) | — | Tous |

**Vues du panel** : Partenaires, Bumps, Classement des bumpeurs


## 📊 Sondages <a id="polls"></a>

`polls` — Sondages à boutons ou choix multiples, résultats en temps réel (barres + graphique), anonymes ou nominatifs, export CSV, sondages natifs Discord. 

**Paramètres (5)** : `defaultDuration` (duration, défaut `1d`) — Durée par défaut · `chartImage` (boolean, défaut `true`) — Graphique PNG des résultats · `showResultsLive` (boolean, défaut `true`) — Résultats visibles pendant le vote · `pingRole` (role) — Rôle mentionné à chaque sondage · `maxActive` (integer, défaut `25`) — Sondages actifs max

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/poll create` | `create` | Créer un sondage (options séparées par \|) | `question`* (string), `options`* (string), `duration` (duration), `multiple` (boolean), `anonymous` (boolean), `channel` (channel) | ManageMessages |
| `/poll end` | `end` | Clore un sondage | `id`* (integer) | ManageMessages |
| `/poll results` | `results` | Résultats d'un sondage (avec export CSV) | `id`* (integer) | Tous |
| `/poll voters` | `voters` | Voir qui a voté quoi (sondages nominatifs uniquement) | `id`* (integer) | ManageMessages |
| `/poll list` | `list` | Lister les sondages | `status` (choice) | Tous |
| `/poll native` | `native` | Créer un sondage natif Discord (options séparées par \|) | `question`* (string), `options`* (string), `duration` (integer), `multiple` (boolean), `channel` (channel) | ManageMessages |
| `/poll delete` | `delete` | Supprimer un sondage et ses votes | `id`* (integer), `delete_message` (boolean) | ManageMessages |

**Vues du panel** : Sondages


## 💬 Citations <a id="quotes"></a>

`quotes` — Sauvegardez les meilleures phrases du serveur : citations manuelles ou depuis un message, recherche, aléatoire, classement. 

**Paramètres (7)** : `channel` (channel) — Salon des citations · `allowEveryone` (boolean, défaut `true`) — Tout le monde peut ajouter · `staffRoles` (list) — Rôles staff · `allowBots` (boolean, défaut `false`) — Autoriser les messages de bots · `allowSelfQuote` (boolean, défaut `true`) — Autoriser à se citer soi-même · `minLength` (integer, défaut `3`) — Longueur minimale · `color` (color, défaut `#9B59B6`) — Couleur des embeds

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/quote add` | `quote_add` | Sauvegarder une citation (texte ou message existant) | `content` (text), `author` (user), `author_name` (string), `message` (string), `channel` (channel) | Tous |
| `/quote random` | `quote_random` | Citation aléatoire | `user` (user) | Tous |
| `/quote show` | `quote_show` | Afficher une citation par son numéro | `number`* (integer) | Tous |
| `/quote search` | `quote_search` | Rechercher des citations | `query`* (string), `limit` (integer) | Tous |
| `/quote byuser` | `quote_byuser` | Citations d'un membre | `user`* (user), `limit` (integer) | Tous |
| `/quote info` | `quote_info` | Informations détaillées sur une citation | `number`* (integer) | Tous |
| `/quote delete` | `quote_delete` | Supprimer une citation (auteur, ajouteur ou staff) | `number`* (integer) | Tous |
| `/quote leaderboard` | `quote_leaderboard` | Membres les plus cités | `limit` (integer) | Tous |

**Menus contextuels** : « Sauvegarder comme citation »

**Vues du panel** : Citations


## 🎭 Rôles-réactions <a id="reactionroles"></a>

`reactionroles` — Panneaux d'attribution de rôles par boutons, menu déroulant ou réactions (modes multiple, unique ou vérification). 

**Paramètres (4)** : `deniedMessage` (text, défaut `🔒 Vous devez avoir le rôle **{role}** p`) — Message si rôle requis manquant · `dmOnReaction` (boolean, défaut `false`) — Confirmer par MP (panneaux à réactions) · `defaultColor` (color, défaut `#5865F2`) — Couleur par défaut des panneaux · `logChannel` (channel) — Salon des logs

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/reactionroles create` | `rr_create` | Créer un panneau de rôles | `title`* (string), `pairs`* (text), `channel` (channel), `description` (text), `color` (color), `type` (choice), `mode` (choice), `required_role` (role), `placeholder` (string) | ManageRoles |
| `/reactionroles edit` | `rr_edit` | Modifier un panneau (ajouter / retirer des rôles, titre, mode…) | `panel`* (integer), `add_pairs` (text), `remove_role` (role), `title` (string), `description` (text), `color` (color), `type` (choice), `mode` (choice), `required_role` (role), `clear_required_role` (boolean), `placeholder` (string) | ManageRoles |
| `/reactionroles delete` | `rr_delete` | Supprimer un panneau de rôles | `panel`* (integer), `keep_message` (boolean) | ManageRoles |
| `/reactionroles list` | `rr_list` | Lister les panneaux de rôles | — | ManageRoles |
| `/reactionroles info` | `rr_info` | Détails d'un panneau de rôles | `panel`* (integer) | ManageRoles |
| `/reactionroles refresh` | `rr_refresh` | Réafficher un panneau (renvoie le message s'il a été supprimé) | `panel`* (integer), `resend` (boolean) | ManageRoles |

**Vues du panel** : Panneaux de rôles


## 💞 Social <a id="social"></a>

`social` — Profils personnalisés (carte image), réputation, likes, mariages, amis, badges, cadeaux, câlins et classements. 

**Paramètres (11)** : `repCooldown` (duration, défaut `12h`) — Délai entre deux points de réputation donnés · `repSameUserCooldown` (duration, défaut `24h`) — Délai avant de réputer le même membre · `anniversaryChannel` (channel) — Salon des anniversaires de mariage · `anniversaryTemplate` (text, défaut `💍 Joyeux anniversaire de mariage à {a} `) — Message d'anniversaire de mariage · `marriageAnnounce` (boolean, défaut `true`) — Annoncer les mariages dans le salon des anniversaires · `interactionGifs` (boolean, défaut `true`) — GIF animés pour câlins / pat / high five / poke · `allowSelfInteractions` (boolean, défaut `false`) — Autoriser les interactions avec soi-même · `maxFriends` (integer, défaut `100`) — Nombre maximum d'amis · `maxBioLength` (integer, défaut `300`) — Longueur maximale de la bio · `defaultColor` (color, défaut `#5865f2`) — Couleur de profil par défaut · `profileImage` (boolean, défaut `true`) — Générer la carte de profil en image

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/social profile` | `profile` | Afficher le profil d'un membre (carte image) | `user` (user) | Tous |
| `/social bio set` | `bio_set` | Définir votre bio | `texte`* (text) | Tous |
| `/social bio clear` | `bio_clear` | Effacer votre bio | — | Tous |
| `/social color` | `color` | Couleur de votre profil | `couleur` (color) | Tous |
| `/social timezone` | `timezone` | Définir votre fuseau ou voir l'heure locale d'un membre | `fuseau` (string), `user` (user) | Tous |
| `/social pronouns` | `pronouns` | Définir vos pronoms | `pronoms` (string) | Tous |
| `/social quote` | `quote` | Citation affichée sur votre profil | `citation` (string) | Tous |
| `/social socials set` | `socials_set` | Ajouter un réseau à votre profil | `reseau`* (choice), `lien`* (string) | Tous |
| `/social socials remove` | `socials_remove` | Retirer un réseau de votre profil | `reseau`* (choice) | Tous |
| — | `profile_reset` | Réinitialiser le profil d'un membre (modération) | `user`* (user) | ManageGuild |
| `/social rep user` | `rep_give` | Donner +1 de réputation à un membre | `user`* (user), `raison` (string) | Tous |
| `/social rep top` | `rep_top` | Classement de la réputation | `jours` (integer) | Tous |
| `/social rep history` | `rep_history` | Derniers points de réputation reçus | `user` (user) | Tous |
| `/social like` | `like` | Liker (ou ne plus liker) le profil d'un membre | `user`* (user) | Tous |
| `/social marry` | `marry` | Demander un membre en mariage (ou accepter sa demande) | `user`* (user) | Tous |
| `/social divorce` | `divorce` | Divorcer 💔 | — | Tous |
| `/social partner` | `partner` | Voir le ou la partenaire d'un membre | `user` (user) | Tous |
| `/social badge create` | `badge_create` | Créer un badge | `nom`* (string), `emoji`* (string), `description` (string) | ManageGuild |
| `/social badge delete` | `badge_delete` | Supprimer un badge | `badge`* (string) | ManageGuild |
| `/social badge give` | `badge_give` | Donner un badge à un membre | `badge`* (string), `user`* (user) | ManageGuild |
| `/social badge remove` | `badge_remove` | Retirer un badge à un membre | `badge`* (string), `user`* (user) | ManageGuild |
| `/social badge list` | `badge_list` | Lister les badges (du serveur ou d'un membre) | `user` (user) | Tous |
| `/social friend add` | `friend_add` | Envoyer (ou accepter) une demande d'ami | `user`* (user) | Tous |
| `/social friend remove` | `friend_remove` | Retirer un ami (ou annuler / refuser une demande) | `user`* (user) | Tous |
| `/social friend list` | `friend_list` | Liste d'amis | `user` (user) | Tous |
| `/social gift` | `gift` | Offrir un cadeau virtuel (emoji + message) | `user`* (user), `emoji`* (string), `message` (string) | Tous |
| `/social top` | `top` | Classements sociaux | `type` (choice), `limite` (integer) | Tous |
| `/social hug` | `hug` | 🤗 Câlin à un membre | `user`* (user) | Tous |
| `/social pat` | `pat` | 🫳 Caresse à un membre | `user`* (user) | Tous |
| `/social highfive` | `highfive` | 🙌 High five à un membre | `user`* (user) | Tous |
| `/social poke` | `poke` | 👉 Poke à un membre | `user`* (user) | Tous |

**Vues du panel** : Profils, Badges


## ⭐ Starboard <a id="starboard"></a>

`starboard` — Met en avant les messages qui reçoivent assez de réactions ⭐ dans un salon dédié. 

**Paramètres (11)** : `channel` (channel) — Salon du starboard · `emoji` (string, défaut `⭐`) — Emoji · `threshold` (integer, défaut `3`) — Seuil · `selfStar` (boolean, défaut `false`) — Auto-étoile autorisée · `ignoreBots` (boolean, défaut `true`) — Ignorer les messages des bots · `ignoreNsfw` (boolean, défaut `true`) — Ignorer les salons NSFW · `ignoredChannels` (list) — Salons ignorés · `removeBelowThreshold` (boolean, défaut `true`) — Retirer sous le seuil · `countStarboardReactions` (boolean, défaut `true`) — Compter les réactions sur le starboard · `maxAgeDays` (integer, défaut `0`) — Âge maximal (jours) · `color` (color, défaut `#FFAC33`) — Couleur de l'embed

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/starboard config` | `starboard_config` | Configurer le starboard | `channel` (channel), `emoji` (string), `threshold` (integer), `self_star` (boolean), `ignore_nsfw` (boolean), `ignore_bots` (boolean), `remove_below` (boolean), `ignore_channel` (channel) | ManageGuild |
| `/starboard top` | `starboard_top` | Messages les plus étoilés | `limit` (integer), `channel` (channel) | Tous |
| `/starboard user` | `starboard_user` | Statistiques starboard d'un membre | `user` (user) | Tous |
| `/starboard stats` | `starboard_stats` | Statistiques globales du starboard | — | Tous |
| `/starboard random` | `starboard_random` | Un message aléatoire du starboard | `user` (user) | Tous |
| `/starboard remove` | `starboard_remove` | Retirer un message du starboard | `message`* (string) | ManageMessages |
| `/starboard refresh` | `starboard_refresh` | Recompter les réactions d'un message | `message`* (string), `channel` (channel) | ManageMessages |

**Vues du panel** : Messages étoilés


## 📊 Statistiques <a id="stats"></a>

`stats` — Salons compteurs, horloges mondiales, statistiques d'activité (messages et vocal) avec classements et graphiques. 

**Paramètres (6)** : `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire des statistiques · `trackMessages` (boolean, défaut `true`) — Compter les messages · `trackVoice` (boolean, défaut `true`) — Compter le temps vocal · `countAfk` (boolean, défaut `false`) — Compter le salon AFK · `ignoredChannels` (list) — Salons exclus des statistiques · `retentionDays` (integer, défaut `365`) — Conservation des données (jours)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/stats server` | `stats_server` | Résumé des statistiques du serveur | — | Tous |
| `/stats user` | `stats_user` | Statistiques d'activité d'un membre | `user` (user) | Tous |
| `/stats top` | `stats_top` | Classement des membres ou salons les plus actifs | `type` (choice), `period` (choice), `limit` (integer) | Tous |
| `/stats graph` | `stats_graph` | Graphique d'activité par jour (image) | `days` (integer), `metric` (choice), `user` (user), `channel` (channel) | Tous |
| `/stats counter add` | `stats_counter_add` | Créer un salon compteur (ou utiliser un salon existant) | `type`* (choice), `channel` (channel), `category` (channel), `template` (string) | ManageChannels |
| `/stats counter remove` | `stats_counter_remove` | Supprimer un salon compteur | `id` (integer), `channel` (channel), `delete_channel` (boolean) | ManageChannels |
| `/stats counter list` | `stats_counter_list` | Lister les salons compteurs | — | ManageChannels |
| `/stats clock add` | `stats_clock_add` | Créer un salon horloge (heure d'un fuseau) | `timezone`* (string), `label` (string), `channel` (channel), `category` (channel), `template` (string), `hour12` (boolean) | ManageChannels |
| `/stats clock remove` | `stats_clock_remove` | Supprimer un salon horloge | `id` (integer), `channel` (channel), `delete_channel` (boolean) | ManageChannels |
| `/stats clock list` | `stats_clock_list` | Lister les salons horloges | — | Tous |
| `/stats refresh` | `stats_refresh` | Forcer la mise à jour des compteurs et horloges | — | ManageChannels |
| `/stats reset` | `stats_reset` | Effacer des statistiques d'activité | `scope`* (choice), `user` (user) | ManageGuild |

**Vues du panel** : Activité (30 jours), Membres les plus actifs (30 jours), Salons compteurs, Horloges mondiales


## 💡 Suggestions <a id="suggestions"></a>

`suggestions` — Salon de suggestions avec votes (pour / contre / neutre), fil de discussion automatique et traitement par le staff. 

**Paramètres (12)** : `channel` (channel) — Salon des suggestions · `createThread` (boolean, défaut `true`) — Créer un fil de discussion · `threadName` (string, défaut `Discussion — Suggestion #{number}`) — Nom du fil · `lockThreadOnClose` (boolean, défaut `true`) — Archiver le fil une fois traitée · `staffRoles` (list) — Rôles staff · `dmOnStatus` (boolean, défaut `true`) — Prévenir l'auteur par MP · `allowChangeVote` (boolean, défaut `true`) — Autoriser le changement de vote · `allowSelfVote` (boolean, défaut `true`) — Autoriser l'auteur à voter · `minLength` (integer, défaut `10`) — Longueur minimale · `cooldown` (integer, défaut `60`) — Délai entre deux suggestions (secondes) · `approvedChannel` (channel) — Salon des suggestions approuvées · `logChannel` (channel) — Salon des logs

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/suggest` | `suggest` | Proposer une suggestion | `content` (text), `title` (string) | Tous |
| `/suggestion status` | `suggestion_status` | Changer le statut d'une suggestion (approuver, refuser, étudier, implémentée) | `number`* (integer), `status`* (choice), `reason` (string) | Tous |
| `/suggestion approve` | `suggestion_approve` | Approuver une suggestion | `number`* (integer), `reason` (string) | Tous |
| `/suggestion deny` | `suggestion_deny` | Refuser une suggestion | `number`* (integer), `reason` (string) | Tous |
| `/suggestion list` | `suggestion_list` | Lister les suggestions | `status` (choice), `user` (user), `limit` (integer) | Tous |
| `/suggestion info` | `suggestion_info` | Détails d'une suggestion | `number`* (integer) | Tous |
| `/suggestion edit` | `suggestion_edit` | Modifier votre suggestion (tant qu'elle est en attente) | `number`* (integer), `content`* (text), `title` (string) | Tous |
| `/suggestion delete` | `suggestion_delete` | Supprimer une suggestion (auteur ou staff) | `number`* (integer) | Tous |
| `/suggestion top` | `suggestion_top` | Suggestions les mieux notées | `status` (choice), `limit` (integer) | Tous |
| `/suggestion stats` | `suggestion_stats` | Statistiques des suggestions | — | Tous |
| `/suggestion config` | `suggestion_config` | Configurer le module suggestions | `channel` (channel), `thread` (boolean), `dm` (boolean), `staff_role` (role), `approved_channel` (channel), `change_vote` (boolean), `self_vote` (boolean), `cooldown` (integer) | ManageGuild |

**Vues du panel** : Suggestions


## 🔊 Salons vocaux temporaires <a id="tempvoice"></a>

`tempvoice` — Salons vocaux « rejoindre pour créer » : chaque membre obtient son salon personnel, géré par boutons ou /voice, supprimé quand il est vide. 

**Paramètres (9)** : `nameTemplate` (string, défaut `🔊 {user.displayName}`) — Modèle de nom · `defaultLimit` (integer, défaut `0`) — Limite de membres par défaut · `defaultBitrate` (integer, défaut `64`) — Débit par défaut (kbps) · `controlPanel` (boolean, défaut `true`) — Panneau de contrôle · `rememberPrefs` (boolean, défaut `true`) — Mémoriser les préférences · `ownerManageChannel` (boolean, défaut `false`) — Donner « Gérer le salon » au propriétaire · `maxChannelsPerUser` (integer, défaut `1`) — Salons max par membre · `creationCooldown` (integer, défaut `10`) — Délai entre deux créations (s) · `logChannel` (channel) — Salon des logs

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/voice setup` | `setup` | Créer un salon « hub » : le rejoindre crée un salon vocal personnel | `category` (channel), `name` (string), `limit` (integer), `bitrate` (integer), `template` (string) | ManageChannels |
| `/voice unsetup` | `hub_remove` | Retirer un hub de salons temporaires | `hub`* (channel), `delete_channel` (boolean) | ManageChannels |
| `/voice hubs` | `hub_list` | Lister les hubs et salons temporaires actifs | — | ManageChannels |
| `/voice name` | `name` | Renommer votre salon | `name`* (string), `channel` (channel) | Tous |
| `/voice limit` | `limit` | Limiter le nombre de membres (0 = illimité) | `limit`* (integer), `channel` (channel) | Tous |
| `/voice lock` | `lock` | Verrouiller votre salon (seuls les membres autorisés peuvent entrer) | `channel` (channel) | Tous |
| `/voice unlock` | `unlock` | Déverrouiller votre salon | `channel` (channel) | Tous |
| `/voice hide` | `hide` | Masquer votre salon aux autres membres | `channel` (channel) | Tous |
| `/voice show` | `show` | Rendre votre salon visible | `channel` (channel) | Tous |
| `/voice kick` | `kick` | Expulser un membre de votre salon | `user`* (user), `channel` (channel) | Tous |
| `/voice ban` | `ban` | Bannir un membre de votre salon (ne peut plus le voir ni le rejoindre) | `user`* (user), `channel` (channel) | Tous |
| `/voice unban` | `unban` | Lever le bannissement d'un membre de votre salon | `user`* (user), `channel` (channel) | Tous |
| `/voice permit` | `permit` | Autoriser un membre à voir / rejoindre votre salon (même verrouillé) | `user`* (user), `channel` (channel) | Tous |
| `/voice claim` | `claim` | Devenir propriétaire du salon si son propriétaire est parti | `channel` (channel) | Tous |
| `/voice transfer` | `transfer` | Transférer la propriété du salon à un autre membre | `user`* (user), `channel` (channel) | Tous |
| `/voice bitrate` | `bitrate` | Régler le débit audio du salon (kbps) | `kbps`* (integer), `channel` (channel) | Tous |
| `/voice region` | `region` | Choisir la région du serveur vocal | `region`* (choice), `channel` (channel) | Tous |
| `/voice info` | `info` | Informations sur votre salon temporaire | `channel` (channel) | Tous |
| `/voice panel` | `panel` | Renvoyer le panneau de contrôle dans le salon | `channel` (channel) | Tous |
| `/voice reset` | `reset_prefs` | Oublier vos préférences de salon (nom, limite, verrouillage…) | — | Tous |
| `/voice delete` | `delete` | Supprimer un salon temporaire | `channel` (channel) | Tous |

**Vues du panel** : Salons actifs, Hubs


## 🎫 Tickets <a id="tickets"></a>

`tickets` — Système de tickets avancé : catégories avec formulaires, assignation automatique, relances, escalade, transcripts HTML et statistiques. 

**Paramètres (24)** : `categories` (json) — Catégories de tickets · `supportRoles` (list) — Rôles support (toutes catégories) · `adminRole` (role) — Rôle administrateur (escalade) · `escalationCategory` (string) — Catégorie d'escalade par défaut · `autoAssign` (boolean, défaut `true`) — Assignation automatique (round-robin) · `preferOnline` (boolean, défaut `true`) — Privilégier le staff en ligne · `pingSupportOnOpen` (boolean, défaut `true`) — Mentionner l'équipe à l'ouverture · `logChannel` (channel) — Salon des logs et transcripts · `defaultCategoryChannel` (channel) — Catégorie Discord par défaut · `maxOpenPerUser` (integer, défaut `1`) — Tickets ouverts maximum par membre · `allowUserClose` (boolean, défaut `true`) — L'auteur peut fermer son ticket · `blockedRole` (role) — Rôle interdit de tickets · `reminderHours` (number, défaut `24`) — Relance automatique après (heures d'inactivité) · `autoCloseHours` (number, défaut `24`) — Fermeture automatique après la relance (heures) · `inactivityScope` (choice, défaut `awaiting_user`) — Inactivité prise en compte · `closeAction` (choice, défaut `delete`) — À la fermeture · `deleteDelay` (integer, défaut `10`) — Délai avant suppression du salon (secondes) · `archiveCategory` (channel) — Catégorie d'archives · `dmTranscript` (boolean, défaut `true`) — Envoyer le transcript en MP à l'auteur · `transcriptInLog` (boolean, défaut `true`) — Joindre le transcript dans les logs · `panelTitle` (string, défaut `🎫 Besoin d'aide ? Ouvrez un ticket`) — Titre du panel · `panelDescription` (text, défaut `Choisissez la catégorie correspondant à `) — Description du panel · `panelStyle` (choice, défaut `buttons`) — Style du panel · `panelColor` (color, défaut `#5865F2`) — Couleur du panel

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/ticket open` | `ticket_open` | Ouvrir un ticket | `category` (string), `subject` (string), `answers` (text), `user` (user) | Tous |
| `/ticket close` | `ticket_close` | Fermer un ticket (transcript généré) | `ticket` (integer), `reason` (string) | Tous |
| `/ticket claim` | `ticket_claim` | Prendre en charge un ticket | `ticket` (integer), `user` (user) | Tous |
| `/ticket unclaim` | `ticket_unclaim` | Libérer un ticket pris en charge | `ticket` (integer) | Tous |
| `/ticket add` | `ticket_add` | Ajouter un membre au ticket | `user`* (user), `ticket` (integer) | Tous |
| `/ticket remove` | `ticket_remove` | Retirer un membre du ticket | `user`* (user), `ticket` (integer) | Tous |
| `/ticket rename` | `ticket_rename` | Renommer le salon du ticket | `name`* (string), `ticket` (integer) | Tous |
| `/ticket priority` | `ticket_priority` | Définir la priorité d'un ticket | `level`* (choice), `ticket` (integer) | Tous |
| `/ticket transfer` | `ticket_transfer` | Transférer un ticket à un autre membre du staff | `user`* (user), `ticket` (integer), `reason` (string) | Tous |
| `/ticket escalate` | `ticket_escalate` | Escalader un ticket (priorité haute, alerte admin, changement d'équipe) | `ticket` (integer), `reason` (string), `category` (string) | Tous |
| `/ticket remind` | `ticket_remind` | Relancer l'auteur d'un ticket inactif | `ticket` (integer), `message` (string) | Tous |
| `/ticket transcript` | `ticket_transcript` | Générer / récupérer le transcript HTML d'un ticket | `ticket` (integer) | Tous |
| `/ticket list` | `ticket_list` | Lister les tickets | `status` (choice), `user` (user), `assigned` (user), `limit` (integer) | Tous |
| `/ticket info` | `ticket_info` | Détails d'un ticket | `ticket` (integer) | Tous |
| `/ticketadmin panel` | `tkadmin_panel` | Envoyer le panel d'ouverture de tickets | `channel` (channel), `style` (choice), `title` (string), `description` (text), `categories` (list) | ManageGuild |
| `/ticketadmin category add` | `tkadmin_category_add` | Créer ou modifier une catégorie de tickets | `id`* (string), `label` (string), `emoji` (string), `description` (string), `category_channel` (channel), `support_roles` (list), `questions` (json), `welcome_message` (text), `name_format` (string) | ManageGuild |
| `/ticketadmin category remove` | `tkadmin_category_remove` | Supprimer une catégorie de tickets | `id`* (string) | ManageGuild |
| `/ticketadmin category list` | `tkadmin_category_list` | Lister les catégories de tickets | — | ManageGuild |
| `/ticketadmin stats` | `tkadmin_stats` | Statistiques des tickets (temps de réponse, résolution, staff) | `days` (integer), `category` (string) | ManageGuild |
| `/ticketadmin config` | `tkadmin_config` | Configurer le module tickets | `log_channel` (channel), `support_role` (role), `admin_role` (role), `default_category` (channel), `archive_category` (channel), `max_open` (integer), `reminder_hours` (number), `autoclose_hours` (number), `auto_assign` (boolean), `dm_transcript` (boolean), `close_action` (choice), `escalation_category` (string) | ManageGuild |
| `/ticketadmin forceclose` | `tkadmin_forceclose` | Forcer la fermeture d'un ticket | `ticket`* (integer), `reason` (string), `transcript` (boolean) | ManageGuild |
| `/ticketadmin purge` | `tkadmin_purge` | Purger les tickets fermés (et leurs transcripts) | `days` (integer), `delete_files` (boolean) | ManageGuild |

**Vues du panel** : Tickets, Statistiques du staff, Catégories


## 🔊 Vocal <a id="voice"></a>

`voice` — Gestion des salons vocaux : déplacements et mutes de masse, rôles vocaux automatiques, statistiques de temps en vocal, journal, conférences, activités, heures calmes. 

**Paramètres (5)** : `logChannel` (channel) — Salon du journal vocal · `trackSessions` (boolean, défaut `true`) — Enregistrer le temps passé en vocal · `ignoreAfk` (boolean, défaut `true`) — Ignorer le salon AFK dans les statistiques · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire (heures calmes) · `defaultInviteDuration` (string, défaut `1h`) — Durée par défaut de /vc invite

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/vc list` | `list` | Qui est dans quel salon vocal | — | Tous |
| `/vc moveall` | `moveall` | Déplacer tous les membres d'un salon vers un autre | `de`* (channel), `vers`* (channel) | MoveMembers |
| `/vc muteall` | `muteall` | Rendre muets tous les membres d'un salon | `salon`* (channel), `sauf_moi` (boolean) | MuteMembers |
| `/vc unmuteall` | `unmuteall` | Rétablir le micro de tous les membres d'un salon | `salon`* (channel) | MuteMembers |
| `/vc deafall` | `deafall` | Mettre en sourdine tous les membres d'un salon | `salon`* (channel), `sauf_moi` (boolean) | DeafenMembers |
| `/vc undeafall` | `undeafall` | Retirer la sourdine de tous les membres d'un salon | `salon`* (channel) | DeafenMembers |
| `/vc disconnectall` | `disconnectall` | Déconnecter tous les membres d'un salon | `salon`* (channel), `sauf_moi` (boolean) | MoveMembers |
| `/vc kick` | `kick` | Déconnecter un membre du vocal | `membre`* (user), `raison` (string) | MoveMembers |
| `/vc move` | `move` | Déplacer un membre vers un salon vocal | `membre`* (user), `salon`* (channel) | MoveMembers |
| `/vc afkmove` | `afkmove` | Envoyer un membre dans le salon AFK | `membre`* (user) | MoveMembers |
| `/vc limit` | `limit` | Limite de membres d'un salon (0 = illimité) | `salon`* (channel), `nombre`* (integer) | ManageChannels |
| `/vc bitrate` | `bitrate` | Débit audio d'un salon (kb/s) | `salon`* (channel), `kbps`* (integer) | ManageChannels |
| `/vc region` | `region` | Région du serveur vocal d'un salon | `salon`* (channel), `region`* (choice) | ManageChannels |
| `/vc lock` | `lock` | Verrouiller un salon vocal (plus personne ne peut rejoindre) | `salon`* (channel), `garder_presents` (boolean) | ManageChannels |
| `/vc unlock` | `unlock` | Déverrouiller un salon vocal | `salon`* (channel) | ManageChannels |
| `/vc invite` | `invite` | Autoriser temporairement un membre à rejoindre un salon | `membre`* (user), `salon`* (channel), `duree` (duration) | ManageChannels |
| `/vc stats` | `stats` | Temps passé en vocal | `membre` (user), `periode` (choice) | Tous |
| `/vc top` | `top` | Classement du temps passé en vocal | `periode` (choice) | Tous |
| `/vc priority` | `priority` | Donner / retirer la voix prioritaire à un membre | `membre`* (user), `salon` (channel), `retirer` (boolean) | ManageChannels |
| `/vc activity` | `activity` | Lancer une activité Discord (YouTube, Poker, Échecs…) dans un salon | `salon`* (channel), `application`* (choice) | Tous |
| `/vc voicerole set` | `voicerole_set` | Attribuer un rôle aux membres en vocal (un salon ou tous) | `role`* (role), `salon` (channel) | ManageRoles |
| `/vc voicerole remove` | `voicerole_remove` | Supprimer une règle de rôle vocal | `role`* (role), `salon` (channel), `retirer_roles` (boolean) | ManageRoles |
| `/vc voicerole list` | `voicerole_list` | Lister les rôles vocaux | — | Tous |
| `/vc log set` | `log_set` | Définir le salon du journal vocal | `salon`* (channel) | ManageGuild |
| `/vc log off` | `log_off` | Désactiver le journal vocal | — | ManageGuild |
| `/vc stage start` | `stage_start` | Démarrer une conférence (salon de type conférence) | `salon`* (channel), `sujet`* (string), `notifier` (boolean) | ManageChannels |
| `/vc stage end` | `stage_end` | Terminer une conférence | `salon`* (channel) | ManageChannels |
| `/vc stage speaker` | `stage_speaker` | Faire monter (ou descendre) un membre sur scène | `membre`* (user), `retirer` (boolean) | MuteMembers |
| `/vc schedule mute` | `schedule_mute` | Heures calmes : interdire de parler sur une plage horaire | `salon`* (channel), `debut`* (string), `fin`* (string), `muter_presents` (boolean) | ManageChannels |
| `/vc schedule list` | `schedule_list` | Lister les heures calmes | — | Tous |
| `/vc schedule remove` | `schedule_remove` | Supprimer une plage d'heures calmes | `id`* (integer) | ManageChannels |

**Vues du panel** : Rôles vocaux, Heures calmes, Top vocal (30 j)


## 👋 Bienvenue <a id="welcome"></a>

`welcome` — Messages de bienvenue et de départ, carte image, MP, autorôles, rôles persistants, paliers de membres et remerciements de boost. 

**Paramètres (35)** : `welcomeEnabled` (boolean, défaut `true`) — Message de bienvenue · `welcomeChannel` (channel) — Salon de bienvenue · `welcomeMessage` (text, défaut `Bienvenue {user.mention} sur **{server.n`) — Message de bienvenue · `welcomeEmbed` (boolean, défaut `false`) — Envoyer en embed · `welcomeEmbedTitle` (string, défaut `Bienvenue {user.displayName} !`) — Titre de l'embed · `welcomeEmbedColor` (color, défaut `#57F287`) — Couleur de l'embed · `welcomeEmbedImage` (string) — Image de l'embed (URL, optionnelle) · `welcomeMention` (boolean, défaut `true`) — Mentionner le membre hors de l'embed · `welcomeCard` (boolean, défaut `false`) — Joindre une carte image · `cardBackground` (string, défaut `#23272A`) — Fond de la carte · `cardTitle` (string, défaut `BIENVENUE`) — Titre de la carte · `cardSubtitle` (string, défaut `Tu es le membre n°{server.memberCount}`) — Sous-titre de la carte · `cardAccentColor` (color, défaut `#5865F2`) — Couleur d'accent · `cardTextColor` (color, défaut `#FFFFFF`) — Couleur du texte · `leaveEnabled` (boolean, défaut `false`) — Message de départ · `leaveChannel` (channel) — Salon des départs · `leaveMessage` (text, défaut `**{user.tag}** a quitté le serveur. Nous`) — Message de départ · `leaveEmbed` (boolean, défaut `false`) — Départ en embed · `dmEnabled` (boolean, défaut `false`) — MP de bienvenue · `dmMessage` (text, défaut `Bienvenue sur **{server.name}**, {user.n`) — Contenu du MP · `dmEmbed` (boolean, défaut `true`) — MP en embed · `autorolesHumans` (list) — Autorôles (humains) · `autorolesBots` (list) — Autorôles (bots) · `autoroleDelay` (duration) — Délai avant attribution · `stickyRoles` (boolean, défaut `false`) — Rôles persistants · `stickyIgnoredRoles` (list) — Rôles jamais restaurés · `stickySafe` (boolean, défaut `true`) — Ne pas restaurer les rôles à permissions sensibles · `milestoneEvery` (integer, défaut `0`) — Palier tous les N membres · `milestoneChannel` (channel) — Salon des paliers · `milestoneMessage` (text, défaut `🎉 Nous venons d'atteindre **{milestone}`) — Message de palier · `milestoneEmbed` (boolean, défaut `true`) — Palier en embed · `boostEnabled` (boolean, défaut `false`) — Remercier les boosts · `boostChannel` (channel) — Salon des boosts · `boostMessage` (text, défaut `💎 Merci {user.mention} pour le boost ! `) — Message de boost · `boostEmbed` (boolean, défaut `true`) — Boost en embed

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/welcome test` | `welcome_test` | Envoyer un aperçu d'un message (bienvenue, départ, MP, boost, palier) | `type` (choice), `user` (user), `channel` (channel) | ManageGuild |
| `/welcome setchannel` | `welcome_setchannel` | Définir le salon d'un type de message (et l'activer) | `type`* (choice), `channel`* (channel) | ManageGuild |
| `/welcome setmessage` | `welcome_setmessage` | Modifier le texte d'un message (bienvenue, départ, MP, boost, palier) | `type`* (choice), `message`* (text), `embed` (boolean) | ManageGuild |
| `/welcome toggle` | `welcome_toggle` | Activer / désactiver une fonctionnalité de bienvenue | `feature`* (choice), `enabled`* (boolean) | ManageGuild |
| `/welcome milestone` | `welcome_milestone` | Configurer les messages de palier (tous les N membres) | `every`* (integer), `channel` (channel) | ManageGuild |
| `/welcome card` | `welcome_card` | Aperçu de la carte de bienvenue (image PNG) | `user` (user), `background` (string) | Tous |
| `/welcome autorole add` | `welcome_autorole_add` | Ajouter un autorôle (humains ou bots) | `role`* (role), `target` (choice) | ManageRoles |
| `/welcome autorole remove` | `welcome_autorole_remove` | Retirer un autorôle | `role`* (role), `target` (choice) | ManageRoles |
| `/welcome autorole list` | `welcome_autorole_list` | Lister les autorôles | — | ManageRoles |
| `/welcome sticky` | `welcome_sticky` | Voir ou effacer les rôles persistants mémorisés d'un utilisateur | `user`* (user), `mode` (choice) | ManageRoles |
| `/welcome status` | `welcome_status` | Résumé de la configuration de bienvenue | — | ManageGuild |

**Vues du panel** : Autorôles, Rôles persistants mémorisés


# Sécurité

## 🛡️ Anti-raid <a id="antiraid"></a>

`antiraid` — Détection de vagues d'arrivées, mode raid / panique, quarantaine des comptes récents, vérification captcha (Discord ou web) et liste noire globale. 

**Paramètres (29)** : `logChannel` (channel) — Salon des logs · `alertChannel` (channel) — Salon des alertes raid · `alertRole` (role) — Rôle à mentionner lors d'une alerte · `joinThreshold` (integer, défaut `10`) — Seuil d'arrivées · `joinWindow` (integer, défaut `10`) — Fenêtre (secondes) · `raidDuration` (integer, défaut `10`) — Durée du mode raid (minutes) · `raidLockdown` (boolean, défaut `true`) — Verrouiller les salons pendant un raid · `raidVerificationLevel` (boolean, défaut `true`) — Augmenter le niveau de vérification du serveur · `raidAction` (choice, défaut `kick`) — Action sur les comptes arrivés pendant la vague · `quarantineEnabled` (boolean, défaut `false`) — Quarantaine automatique des comptes récents · `minAccountAgeHours` (integer, défaut `24`) — Âge minimum du compte (heures) · `quarantineRole` (role) — Rôle de quarantaine · `quarantineReleaseMinutes` (integer, défaut `0`) — Libération automatique (minutes) · `quarantineReleaseOnVerify` (boolean, défaut `true`) — Libérer la quarantaine après vérification · `verificationEnabled` (boolean, défaut `false`) — Vérification des nouveaux membres · `verificationMethod` (choice, défaut `emoji`) — Méthode · `unverifiedRole` (role) — Rôle « non vérifié » · `verifiedRole` (role) — Rôle « vérifié » · `verifyChannel` (channel) — Salon de vérification · `dmVerifyLink` (boolean, défaut `true`) — Envoyer les instructions en MP à l'arrivée · `verifyDmMessage` (text, défaut `Bienvenue sur **{server.name}** ! Pour a`) — Message de MP · `kickUnverifiedMinutes` (integer, défaut `0`) — Expulser si non vérifié après (minutes) · `vpnCheck` (boolean, défaut `false`) — Refuser VPN / proxy / hébergeurs (captcha web) · `verifiedWelcomeChannel` (channel) — Salon du message de bienvenue (après vérification) · `verifiedWelcomeMessage` (text, défaut ``) — Message de bienvenue vérifié · `enforceGlobalBlacklist` (boolean, défaut `true`) — Bannir automatiquement les comptes de la liste noire globale · `allowLocalAdditions` (boolean, défaut `false`) — Les admins du serveur peuvent alimenter la liste noire globale · `whitelist` (list) — Utilisateurs exemptés · `botsExempt` (boolean, défaut `true`) — Ignorer les bots

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/verify` | `verify` | Se vérifier (captcha) pour accéder au serveur | — | Tous |
| `/antiraid status` | `status` | État de l'anti-raid (raid en cours, quarantaine, vérification) | — | ModerateMembers |
| `/antiraid config` | `config` | Voir ou modifier un paramètre de l'anti-raid | `key` (string), `value` (string) | ManageGuild |
| `/antiraid panic` | `panic` | Activer manuellement le mode raid (panique) | `duration` (duration), `reason` (string), `action` (choice) | Administrator |
| `/antiraid stop` | `stop` | Mettre fin au mode raid | `reason` (string) | Administrator |
| `/antiraid setup` | `setup` | Créer / configurer automatiquement les rôles et le salon de vérification | `restrict_channels` (boolean), `post_message` (boolean) | Administrator |
| `/antiraid approve` | `approve` | Vérifier manuellement un membre | `user`* (user) | ModerateMembers |
| `/antiraid joins` | `joins` | Arrivées récentes et comptes suspects | `limit` (integer) | ModerateMembers |
| `/antiraid whitelist` | `whitelist` | Exempter (ou non) un utilisateur de l'anti-raid | `user`* (user), `mode` (choice) | ManageGuild |
| `/antiraid quarantine add` | `quarantine_add` | Mettre un membre en quarantaine | `user`* (user), `reason` (string), `duration` (duration) | ModerateMembers |
| `/antiraid quarantine release` | `quarantine_release` | Libérer un membre de la quarantaine | `user`* (user) | ModerateMembers |
| `/antiraid quarantine list` | `quarantine_list` | Lister les membres en quarantaine | — | ModerateMembers |
| `/antiraid blacklist add` | `blacklist_add` | Ajouter un utilisateur à la liste noire globale | `user`* (user), `reason`* (string), `ban_now` (boolean) | BanMembers |
| `/antiraid blacklist remove` | `blacklist_remove` | Retirer un utilisateur de la liste noire globale | `user`* (user) | BanMembers |
| `/antiraid blacklist check` | `blacklist_check` | Vérifier si un utilisateur est sur la liste noire globale | `user`* (user) | BanMembers |
| `/antiraid blacklist list` | `blacklist_list` | Lister la liste noire globale | `limit` (integer) | BanMembers |

**Vues du panel** : Arrivées récentes, Quarantaine, Liste noire globale


## 🤖 Auto-modération <a id="automod"></a>

`automod` — Anti-spam, anti-invite, anti-lien, mots interdits, majuscules, zalgo, liens d'affiliation, fichiers dangereux, anti-phishing, NSFW par IA, slowmode dynamique et règles AutoMod natives. 

**Paramètres (14)** : `logChannel` (channel) — Salon des logs · `rules` (json) — Configuration des règles · `bannedWords` (list) — Mots interdits · `linkWhitelist` (list) — Domaines autorisés (anti-lien) · `blockedExtensions` (list) — Extensions de fichiers bloquées · `affiliateParams` (list) — Paramètres d'affiliation supplémentaires · `ignoredChannels` (list) — Salons ignorés (toutes règles) · `ignoredRoles` (list) — Rôles ignorés (toutes règles) · `bypassStaff` (boolean, défaut `true`) — Le staff est exempté · `notifyUser` (boolean, défaut `true`) — Prévenir l'auteur · `notifyTemplate` (text, défaut `{user.mention}, votre message a été supp`) — Modèle du message d'avertissement · `safeBrowsingKey` (string) — Clé Google Safe Browsing v4 · `sightengineUser` (string) — Sightengine — api_user · `sightengineSecret` (string) — Sightengine — api_secret

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/automod status` | `status` | État de l'auto-modération et de chaque règle | — | ManageMessages |
| `/automod enable` | `enable` | Activer une règle | `rule`* (choice) | ManageGuild |
| `/automod disable` | `disable` | Désactiver une règle | `rule`* (choice) | ManageGuild |
| `/automod set` | `set` | Modifier un réglage d'une règle (action, seuil…) | `rule`* (choice), `key`* (string), `value`* (string) | ManageGuild |
| `/automod words add` | `words_add` | Ajouter un mot interdit (jokers * ou /regex/) | `word`* (string) | ManageGuild |
| `/automod words remove` | `words_remove` | Retirer un mot interdit | `word`* (string) | ManageGuild |
| `/automod words list` | `words_list` | Lister les mots interdits | — | ManageMessages |
| `/automod whitelist add` | `whitelist_add` | Autoriser un domaine (règle anti-lien) | `domain`* (string) | ManageGuild |
| `/automod whitelist remove` | `whitelist_remove` | Retirer un domaine de la liste blanche | `domain`* (string) | ManageGuild |
| `/automod whitelist list` | `whitelist_list` | Lister les domaines autorisés | — | ManageMessages |
| `/automod ignore channel` | `ignore_channel` | Ignorer / réintégrer un salon (toutes règles ou une seule) | `channel`* (channel), `mode` (choice), `rule` (choice) | ManageGuild |
| `/automod ignore role` | `ignore_role` | Ignorer / réintégrer un rôle (toutes règles ou une seule) | `role`* (role), `mode` (choice), `rule` (choice) | ManageGuild |
| `/automod test` | `test` | Analyser un texte et indiquer les règles qui se déclencheraient | `text`* (text) | ManageMessages |
| `/automod native create` | `native_create` | Créer une règle AutoMod native Discord | `type`* (choice), `name` (string), `keywords` (list), `regex` (list), `mention_limit` (integer), `action` (choice), `timeout_duration` (duration), `alert_channel` (channel) | ManageGuild |
| `/automod native list` | `native_list` | Lister les règles AutoMod natives du serveur | — | ManageGuild |
| `/automod native delete` | `native_delete` | Supprimer une règle AutoMod native | `rule_id`* (string) | ManageGuild |
| `/automod stats` | `stats` | Statistiques des déclenchements | `days` (integer) | ManageMessages |
| `/automod hits` | `hits` | Derniers déclenchements | `rule` (choice), `user` (user), `limit` (integer) | ManageMessages |
| `/automod refresh` | `phishing_refresh` | Rafraîchir la liste noire anti-phishing | — | ManageGuild |

**Vues du panel** : Déclenchements


## 🛡️ Anti-nuke (ServerGuard) <a id="serverguard"></a>

`serverguard` — Protection contre les raids d'administrateurs : surveillance du journal d'audit, seuils par exécuteur, punition et restauration automatiques, liste blanche de bots, webhooks, détection d'alts, audit de permissions, snapshots et mode panique. 

**Paramètres (19)** : `alertChannel` (channel) — Salon des alertes · `alertRole` (role) — Rôle mentionné lors d'une alerte · `punishment` (choice, défaut `stripRoles`) — Punition de l'exécuteur · `quarantineRole` (role) — Rôle de quarantaine · `thresholds` (json) — Seuils par type d'action · `restoreOnNuke` (boolean, défaut `true`) — Restaurer automatiquement (salons, rôles, permissions…) · `restoreBans` (boolean, défaut `true`) — Débannir les victimes lors de la restauration · `trustedUsers` (list) — Administrateurs de confiance (exemptés) · `trustedRoles` (list) — Rôles de confiance (exemptés) · `exemptWhitelistedBots` (boolean, défaut `true`) — Exempter les bots de la liste blanche · `botWhitelistEnabled` (boolean, défaut `false`) — Expulser les bots non listés · `allowTrustedBotAdds` (boolean, défaut `false`) — Autoriser les ajouts de bots par les utilisateurs de confiance · `punishBotAdder` (boolean, défaut `false`) — Punir celui qui ajoute un bot non listé · `webhookGuard` (boolean, défaut `false`) — Supprimer les webhooks créés par des membres non approuvés · `snapshotIntervalHours` (integer, défaut `6`) — Intervalle des snapshots automatiques (heures, 0 = désactivé) · `snapshotKeep` (integer, défaut `10`) — Nombre de snapshots conservés · `altAutoScan` (boolean, défaut `false`) — Analyser les nouveaux membres (comptes alternatifs) · `altThreshold` (number, défaut `0.7`) — Seuil de similarité (0 à 1) · `altAction` (choice, défaut `none`) — Action sur un alt suspecté

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/guard status` | `status` | État de la protection anti-nuke | — | ManageGuild |
| `/guard test` | `test` | Simuler un déclenchement (sans action réelle) | `type`* (choice), `user` (user), `count` (integer), `alert` (boolean) | Administrator |
| `/guard log` | `log` | Journal des actions détectées | `user` (user), `triggered` (boolean), `limit` (integer) | ManageGuild |
| `/guard restore` | `restore` | Annuler les actions récentes d'un exécuteur | `user`* (user) | Administrator |
| `/guard punish` | `punish_user` | Appliquer la punition anti-nuke à un membre | `user`* (user), `reason` (string) | Administrator |
| `/guard audit` | `audit` | Audit des permissions dangereuses | — | ManageGuild |
| `/guard permissions fix` | `permissions_fix` | Retirer les permissions dangereuses de @everyone | `confirm` (boolean) | Administrator |
| `/guard panic` | `panic` | Mode panique : retirer les permissions dangereuses des rôles | `reason` (string) | Administrator |
| `/guard unpanic` | `unpanic` | Quitter le mode panique (restaure les permissions) | — | Administrator |
| `/guard bots add` | `bots_add` | Autoriser un bot | `bot`* (user), `note` (string) | Administrator |
| `/guard bots remove` | `bots_remove` | Retirer un bot de la liste blanche | `bot`* (user) | Administrator |
| `/guard bots list` | `bots_list` | Liste blanche des bots | — | ManageGuild |
| `/guard trust add` | `trust_add` | Ajouter un utilisateur ou un rôle de confiance | `user` (user), `role` (role) | Administrator |
| `/guard trust remove` | `trust_remove` | Retirer un utilisateur ou un rôle de confiance | `user` (user), `role` (role) | Administrator |
| `/guard trust list` | `trust_list` | Utilisateurs et rôles de confiance | — | ManageGuild |
| `/guard alts scan` | `alts_scan` | Rechercher des comptes alternatifs de bannis | `user` (user), `days` (integer), `threshold` (number) | BanMembers |
| `/guard alts config` | `alts_config` | Configurer la détection d'alts | `auto` (boolean), `threshold` (number), `action` (choice) | Administrator |
| `/guard snapshot now` | `snapshot_now` | Prendre un snapshot de la structure | — | Administrator |
| `/guard snapshot list` | `snapshot_list` | Lister les snapshots | — | ManageGuild |
| `/guard snapshot diff` | `snapshot_diff` | Comparer le serveur à un snapshot | `id` (integer) | ManageGuild |
| `/guard snapshot restore` | `snapshot_restore` | Recréer les rôles/salons manquants depuis un snapshot | `id` (integer), `confirm` (boolean) | Administrator |

**Vues du panel** : Évènements détectés, Bots autorisés, Snapshots


# Économie & jeux

## 🎰 Casino <a id="casino"></a>

`casino` — Blackjack, roulette, machine à sous à jackpot progressif, paris fictifs et matchs e-sport simulés (nécessite le module économie). 

**Paramètres (10)** : `minBet` (integer, défaut `10`) — Mise minimale · `maxBet` (integer, défaut `100000`) — Mise maximale · `casinoChannels` (list) — Salons casino · `houseEdge` (number, défaut `2`) — Avantage maison (%) · `jackpotSeed` (integer, défaut `5000`) — Jackpot initial · `jackpotContribution` (number, défaut `5`) — Contribution au jackpot (%) · `animations` (boolean, défaut `true`) — Animations · `betsChannel` (channel) — Salon des paris · `autoMatchMinutes` (integer, défaut `30`) — Durée d'un match e-sport (minutes) · `autoMatchInterval` (integer, défaut `0`) — Match e-sport automatique toutes les N heures

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/casino blackjack` | `blackjack` | Jouer au blackjack contre le croupier (boutons Tirer / Rester / Doubler / Split) | `mise` (integer), `coup` (choice) | Tous |
| `/casino roulette` | `roulette` | Roulette européenne : rouge/noir, pair/impair, manque/passe, douzaine, colonne ou numéro | `mise`* (integer), `type`* (choice), `valeur` (integer) | Tous |
| `/casino slots` | `slots` | Machine à sous 3x3 (5 lignes) avec jackpot progressif | `mise`* (integer) | Tous |
| `/casino bet create` | `bet_create` | Créer un pari fictif (options au format « Nom:cote, Nom:cote ») | `titre`* (string), `options`* (list), `duree` (duration), `salon` (channel) | ManageGuild |
| `/casino bet auto` | `bet_auto` | Générer un match e-sport fictif avec cotes, résolu automatiquement | `jeu` (choice), `duree` (duration), `salon` (channel) | ManageGuild |
| `/casino bet list` | `bet_list` | Lister les paris ouverts (ou récents) | `statut` (choice) | Tous |
| `/casino bet view` | `bet_view` | Détails d'un pari | `id`* (integer) | Tous |
| `/casino bet place` | `bet_place` | Placer une mise sur une option d'un pari | `id`* (integer), `option`* (string), `montant`* (integer) | Tous |
| `/casino bet mine` | `bet_mine` | Voir mes paris récents | `membre` (user) | Tous |
| `/casino bet close` | `bet_close` | Fermer les mises d'un pari | `id`* (integer) | ManageGuild |
| `/casino bet resolve` | `bet_resolve` | Désigner l'option gagnante et payer les gagnants selon les cotes | `id`* (integer), `option`* (string) | ManageGuild |
| `/casino bet cancel` | `bet_cancel` | Annuler un pari et rembourser toutes les mises | `id`* (integer) | ManageGuild |
| `/casino stats` | `stats` | Statistiques casino d'un joueur (gains/pertes par jeu) | `membre` (user) | Tous |
| `/casino leaderboard` | `leaderboard` | Classement des joueurs du casino | `tri` (choice), `jeu` (choice) | Tous |
| `/casino jackpot` | `jackpot` | Voir le jackpot progressif du serveur | — | Tous |
| `/casino jackpot-set` | `jackpot_set` | Définir manuellement le montant du jackpot | `montant`* (integer) | ManageGuild |
| `/casino gains` | `paytable` | Tableau des gains et règles du casino | — | Tous |
| `/casino reset` | `stats_reset` | Réinitialiser les statistiques casino (d'un membre ou de tout le serveur) | `membre` (user) | ManageGuild |

**Vues du panel** : Paris, Joueurs


## 💰 Économie <a id="economy"></a>

`economy` — Monnaie virtuelle : daily, métiers, banque à intérêts, boutique, inventaire, échanges sécurisés, primes, braquages, bourse et trésorerie. 

**Paramètres (53)** : `currencyName` (string, défaut `pièces`) — Nom de la monnaie · `currencySymbol` (string, défaut `🪙`) — Symbole de la monnaie · `startBalance` (integer, défaut `500`) — Solde de départ · `logChannel` (channel) — Salon des logs économie · `dailyAmount` (integer, défaut `200`) — Récompense quotidienne · `dailyStreakBonus` (integer, défaut `25`) — Bonus par jour de série · `dailyStreakMax` (integer, défaut `30`) — Série maximale prise en compte (jours) · `dailyMilestoneBonus` (integer, défaut `500`) — Bonus tous les 7 jours de série · `dailyCooldownHours` (integer, défaut `24`) — Délai entre deux daily (heures) · `dailyStreakGraceHours` (integer, défaut `48`) — Délai max pour conserver la série (heures) · `weeklyAmount` (integer, défaut `1500`) — Récompense hebdomadaire (0 = désactivée) · `monthlyAmount` (integer, défaut `7500`) — Récompense mensuelle (0 = désactivée) · `jobs` (json) — Métiers · `defaultJob` (string, défaut `interim`) — Métier par défaut sans emploi (vide = aucun) · `jobChangeCooldownHours` (integer, défaut `12`) — Délai entre deux changements de métier (heures) · `bankCapacity` (integer, défaut `10000`) — Capacité bancaire initiale · `bankMaxCapacity` (integer, défaut `0`) — Capacité bancaire maximale (0 = illimitée) · `bankUpgradeAmount` (integer, défaut `10000`) — Capacité ajoutée par agrandissement · `bankUpgradeCost` (integer, défaut `5000`) — Coût du premier agrandissement · `bankUpgradeGrowth` (number, défaut `1.5`) — Multiplicateur de coût par niveau · `bankInterestRate` (number, défaut `1`) — Taux d'intérêt bancaire (% par jour) · `interestMaxDays` (integer, défaut `7`) — Jours d'intérêts cumulables au maximum · `payTaxPercent` (number, défaut `5`) — Taxe sur /pay (%) versée à la trésorerie · `payMinAmount` (integer, défaut `10`) — Montant minimum de /pay · `payMaxAmount` (integer, défaut `0`) — Montant maximum de /pay (0 = illimité) · `shopSellPercent` (integer, défaut `50`) — Prix de revente (% du prix d'achat, 0 = désactivé) · `revenueToTreasury` (boolean, défaut `false`) — Achats boutique et agrandissements versés à la trésorerie · `tradeTimeoutMinutes` (integer, défaut `5`) — Expiration des échanges (minutes) · `robEnabled` (boolean, défaut `true`) — Braquages activés · `robBaseChance` (number, défaut `40`) — Chance de réussite de base (%) · `robMinChance` (number, défaut `5`) — Chance minimale (%) · `robMaxChance` (number, défaut `85`) — Chance maximale (%) · `robCooldownMinutes` (integer, défaut `120`) — Recharge entre deux braquages (minutes) · `robStealMinPercent` (number, défaut `10`) — Part minimale volée (% du portefeuille) · `robStealMaxPercent` (number, défaut `30`) — Part maximale volée (%) · `robMaxSteal` (integer, défaut `5000`) — Butin maximum (0 = illimité) · `robMinTargetWallet` (integer, défaut `200`) — Portefeuille minimum de la victime · `robMinWallet` (integer, défaut `100`) — Portefeuille minimum du voleur · `robFailPercent` (number, défaut `10`) — Amende en cas d'échec (% du portefeuille) · `robFailMin` (integer, défaut `100`) — Amende minimale · `robFineTo` (choice, défaut `victim`) — Destinataire de l'amende · `robRequireLicense` (boolean, défaut `false`) — Exiger une licence (avantage rob_license) · `robNotifyVictim` (boolean, défaut `true`) — Prévenir la victime par MP · `bountyMinAmount` (integer, défaut `100`) — Prime minimum · `bountyAutoClaimOnBan` (boolean, défaut `true`) — Verser les primes au modérateur lors d'un ban · `marketEnabled` (boolean, défaut `true`) — Bourse activée · `marketFeePercent` (number, défaut `1`) — Frais de transaction (%) versés à la trésorerie · `marketVolatility` (number, défaut `1`) — Multiplicateur de volatilité · `marketPressureImpact` (number, défaut `1`) — Impact des achats/ventes sur les cours · `marketEventChance` (number, défaut `1`) — Chance d'évènement (krach/envolée) par tick (%) · `marketMaxShares` (integer, défaut `0`) — Actions max par transaction (0 = illimité) · `marketHistoryPoints` (integer, défaut `672`) — Points d'historique conservés (1 point / 15 min) · `marketChannel` (channel) — Salon des flashs bourse (krachs, envolées)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/balance` | `balance` | Afficher le solde d'un membre (portefeuille, banque, rang) | `user` (user) | Tous |
| `/daily` | `daily` | Récupérer la récompense quotidienne (bonus de série) | — | Tous |
| `/eco weekly` | `weekly` | Récupérer la récompense hebdomadaire | — | Tous |
| `/eco monthly` | `monthly` | Récupérer la récompense mensuelle | — | Tous |
| `/work` | `work` | Travailler pour gagner de l'argent (selon votre métier) | — | Tous |
| `/eco pay` | `pay` | Envoyer de l'argent à un membre (taxe serveur possible) | `user`* (user), `amount`* (string), `note` (string) | Tous |
| `/eco deposit` | `deposit` | Déposer de l'argent en banque | `amount`* (string) | Tous |
| `/eco withdraw` | `withdraw` | Retirer de l'argent de la banque | `amount`* (string) | Tous |
| `/eco interest` | `interest` | Collecter les intérêts de votre compte bancaire | — | Tous |
| `/eco upgrade` | `bank_upgrade` | Agrandir la capacité de votre banque | — | Tous |
| `/eco leaderboard` | `leaderboard` | Classement des plus riches du serveur | `by` (choice), `page` (integer) | Tous |
| `/eco history` | `transactions` | Historique des transactions (les vôtres, ou d'un membre pour le staff) | `user` (user), `type` (choice), `limit` (integer) | Tous |
| `/eco config` | `config` | Afficher la configuration de l'économie du serveur | — | Tous |
| `/eco job list` | `job_list` | Lister les métiers disponibles | — | Tous |
| `/eco job choose` | `job_choose` | Choisir (ou changer de) métier | `job`* (string) | Tous |
| `/eco job quit` | `job_quit` | Démissionner de votre métier | — | Tous |
| `/eco shop list` | `shop_list` | Voir les objets de la boutique | `page` (integer) | Tous |
| `/eco shop info` | `shop_info` | Détails d'un objet de la boutique | `item`* (string) | Tous |
| `/eco shop buy` | `shop_buy` | Acheter un objet de la boutique | `item`* (string), `quantity` (integer) | Tous |
| `/eco shop sell` | `shop_sell` | Revendre un objet de votre inventaire | `item`* (string), `quantity` (integer) | Tous |
| `/eco shop add` | `shop_add` | Ajouter un objet à la boutique | `name`* (string), `price`* (integer), `type` (choice), `description` (string), `role` (role), `duration` (duration), `stock` (integer), `max_per_user` (integer), `emoji` (string), `usable` (boolean), `use_message` (string), `meta` (json) | ManageGuild |
| `/eco shop edit` | `shop_edit` | Modifier un objet de la boutique | `item`* (string), `price` (integer), `type` (choice), `description` (string), `role` (role), `duration` (duration), `stock` (integer), `max_per_user` (integer), `emoji` (string), `usable` (boolean), `use_message` (string), `meta` (json), `new_name` (string), `enabled` (boolean) | ManageGuild |
| `/eco shop remove` | `shop_remove` | Supprimer un objet de la boutique (et des inventaires) | `item`* (string), `refund` (boolean) | ManageGuild |
| `/eco inventory` | `inventory` | Afficher l'inventaire d'un membre | `user` (user) | Tous |
| `/eco use` | `use` | Utiliser un objet de votre inventaire | `item`* (string), `quantity` (integer) | Tous |
| `/eco give` | `give` | Donner un objet de votre inventaire à un membre | `user`* (user), `item`* (string), `quantity` (integer) | Tous |
| `/eco trade` | `trade` | Proposer un échange sécurisé (argent / objets) à un membre | `user`* (user), `offer_money` (integer), `offer_item` (string), `offer_qty` (integer), `request_money` (integer), `request_item` (string), `request_qty` (integer) | Tous |
| — | `trade_respond` | Répondre à un échange (accepter, refuser ou annuler) — API/CLI | `trade_id`* (integer), `response`* (choice) | Tous |
| `/eco rob` | `rob` | Tenter de braquer le portefeuille d'un membre | `user`* (user) | Tous |
| `/eco bounty place` | `bounty_place` | Placer une prime sur la tête d'un membre | `user`* (user), `amount`* (integer), `reason` (string) | Tous |
| `/eco bounty list` | `bounty_list` | Voir les primes actives | `user` (user) | Tous |
| `/eco bounty claim` | `bounty_claim` | Attribuer les primes d'une cible à un chasseur (staff) | `target`* (user), `hunter`* (user) | ModerateMembers |
| `/eco bounty cancel` | `bounty_cancel` | Annuler une prime (auteur ou staff) et la rembourser | `id`* (integer) | Tous |
| `/eco treasury view` | `treasury_view` | Voir la trésorerie du serveur | — | ManageGuild |
| `/eco treasury withdraw` | `treasury_withdraw` | Verser de l'argent de la trésorerie à un membre (évènements) | `user`* (user), `amount`* (integer), `reason` (string) | ManageGuild |
| `/eco treasury deposit` | `treasury_deposit` | Alimenter la trésorerie (depuis votre portefeuille ou par création monétaire) | `amount`* (integer), `source` (choice), `reason` (string) | ManageGuild |
| `/eco market list` | `market_list` | Cours de la bourse | — | Tous |
| `/eco market info` | `market_info` | Détails d'un actif boursier | `symbol`* (string) | Tous |
| `/eco market buy` | `market_buy` | Acheter des actions | `symbol`* (string), `shares`* (string) | Tous |
| `/eco market sell` | `market_sell` | Vendre des actions | `symbol`* (string), `shares`* (string) | Tous |
| `/eco market portfolio` | `market_portfolio` | Portefeuille boursier d'un membre | `user` (user) | Tous |
| `/eco market history` | `market_history` | Graphique de l'historique d'un actif | `symbol`* (string), `period` (choice) | Tous |
| `/eco market create` | `market_create` | Créer un nouvel actif boursier | `symbol`* (string), `name`* (string), `price`* (number), `volatility` (number), `supply` (integer), `emoji` (string) | ManageGuild |
| `/eco market delete` | `market_delete` | Supprimer un actif (les positions sont rachetées au cours actuel) | `symbol`* (string), `confirm`* (boolean) | ManageGuild |
| `/eco admin add` | `admin_add` | Ajouter de l'argent à un membre | `user`* (user), `amount`* (integer), `target` (choice), `reason` (string) | ManageGuild |
| `/eco admin remove` | `admin_remove` | Retirer de l'argent à un membre | `user`* (user), `amount`* (integer), `target` (choice), `reason` (string) | ManageGuild |
| `/eco admin set` | `admin_set` | Définir le solde d'un membre | `user`* (user), `amount`* (integer), `target` (choice), `reason` (string) | ManageGuild |
| `/eco admin reset` | `admin_reset` | Réinitialiser le compte d'un membre (solde, inventaire, actions) | `user`* (user), `reason` (string) | ManageGuild |
| `/eco admin resetall` | `admin_resetall` | Réinitialiser TOUTE l'économie du serveur (irréversible) | `confirm`* (boolean) | Administrator |

**Vues du panel** : Comptes, Boutique, Transactions, Bourse, Primes, Échanges


## 💎 Économie+ <a id="economyplus"></a>

`economyplus` — Loterie, braquages en groupe, enchères, craft, ferme, pêche, chasse, mine, prêts, entreprises, quêtes journalières, prestige, coupons, cadeaux et évènements saisonniers (nécessite le module économie). 

**Paramètres (47)** : `logChannel` (channel) — Salon des annonces / logs · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire (quêtes) · `lotteryTicketPrice` (integer, défaut `100`) — Prix d'un ticket · `lotteryDrawEvery` (integer, défaut `24`) — Tirage toutes les N heures · `lotterySeed` (integer, défaut `1000`) — Cagnotte de départ (seed) · `lotteryHouseCut` (number, défaut `0`) — Prélèvement sur les tickets (%) · `lotteryMaxTickets` (integer, défaut `100`) — Tickets max par membre et par tirage · `lotteryChannel` (channel) — Salon des tirages · `heistMinPlayers` (integer, défaut `2`) — Participants minimum · `heistMaxPlayers` (integer, défaut `10`) — Participants maximum · `heistJoinSeconds` (integer, défaut `120`) — Durée de recrutement (s) · `heistMinStake` (integer, défaut `100`) — Mise minimale · `heistBaseChance` (integer, défaut `30`) — Chance de base (%) · `heistChancePerPlayer` (integer, défaut `8`) — Bonus par complice (%) · `heistMaxChance` (integer, défaut `85`) — Chance maximale (%) · `heistEquipment` (json) — Équipement (objet → bonus %) · `heistBankMultiplier` (number, défaut `1.5`) — Multiplicateur du butin (banque) · `heistStealPercent` (integer, défaut `30`) — Part du portefeuille volée (cible membre, %) · `heistMaxLoot` (integer, défaut `50000`) — Butin maximal (cible membre) · `heistFinePercent` (integer, défaut `50`) — Amende en cas d'échec (% de la mise) · `heistJailMinutes` (integer, défaut `30`) — Prison fictive (minutes) · `heistCooldownMinutes` (integer, défaut `60`) — Délai entre deux braquages lancés (minutes) · `auctionFeePercent` (number, défaut `5`) — Commission sur les ventes (%) · `auctionMinIncrement` (integer, défaut `10`) — Surenchère minimale (%) · `auctionMaxHours` (integer, défaut `72`) — Durée maximale (heures) · `auctionChannel` (channel) — Salon des enchères · `recipes` (json) — Recettes de craft · `crops` (json) — Cultures · `farmPlots` (integer, défaut `4`) — Parcelles par membre · `fertilizerCost` (integer, défaut `150`) — Prix de l'engrais · `fishCooldown` (integer, défaut `30`) — Délai de pêche (s) · `huntCooldown` (integer, défaut `300`) — Délai de chasse (s) · `mineCooldown` (integer, défaut `120`) — Délai de minage (s) · `pickaxeBaseCost` (integer, défaut `1000`) — Coût de la 1re amélioration de pioche · `loanMax` (integer, défaut `10000`) — Montant maximal d'un prêt · `loanInterest` (number, défaut `10`) — Intérêt (%) · `loanMaxDays` (integer, défaut `14`) — Durée maximale (jours) · `loanAutoCollect` (boolean, défaut `true`) — Prélever automatiquement à l'échéance · `businesses` (json) — Entreprises · `businessMax` (integer, défaut `5`) — Entreprises max par membre · `questRewardMultiplier` (number, défaut `1`) — Multiplicateur des récompenses de quêtes · `questBonus` (integer, défaut `250`) — Bonus pour les 3 quêtes du jour · `prestigeBaseCost` (integer, défaut `100000`) — Coût du 1er prestige (fortune totale) · `prestigeGrowth` (number, défaut `2`) — Multiplicateur de coût par niveau · `prestigeBonus` (number, défaut `0.1`) — Bonus de gains par niveau · `giftMaxMessage` (integer, défaut `300`) — Longueur max du message de cadeau · `eventApplyMode` (choice, défaut `bonus`) — Application des évènements saisonniers

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/ecoplus lottery buy` | `lottery_buy` | Acheter des tickets de loterie | `nombre` (integer) | Tous |
| `/ecoplus lottery info` | `lottery_info` | Cagnotte et tirage en cours | — | Tous |
| `/ecoplus lottery history` | `lottery_history` | Derniers tirages | — | Tous |
| `/ecoplus lottery draw` | `lottery_draw` | Forcer le tirage de la loterie | — | ManageGuild |
| `/ecoplus heist start` | `heist_start` | Organiser un braquage en groupe | `montant`* (integer), `cible` (user) | Tous |
| `/ecoplus heist join` | `heist_join` | Rejoindre un braquage en préparation | `id` (integer) | Tous |
| `/ecoplus auction create` | `auction_create` | Mettre un objet ou un montant aux enchères | `lot`* (string), `prix`* (integer), `duree`* (duration), `quantite` (integer) | Tous |
| `/ecoplus auction bid` | `auction_bid` | Enchérir sur un lot | `id`* (integer), `montant` (integer) | Tous |
| `/ecoplus auction list` | `auction_list` | Enchères en cours | — | Tous |
| `/ecoplus auction cancel` | `auction_cancel` | Annuler une enchère | `id`* (integer) | Tous |
| `/ecoplus craft recipes` | `craft_recipes` | Recettes de fabrication | — | Tous |
| `/ecoplus craft make` | `craft_make` | Fabriquer un objet | `recette`* (string), `quantite` (integer) | Tous |
| `/ecoplus farm plant` | `farm_plant` | Planter une culture | `culture`* (string), `parcelles` (integer) | Tous |
| `/ecoplus farm harvest` | `farm_harvest` | Récolter les cultures mûres | — | Tous |
| `/ecoplus farm status` | `farm_status` | État de votre ferme | `user` (user) | Tous |
| `/ecoplus farm fertilize` | `farm_fertilize` | Engrais : accélère les cultures en cours | — | Tous |
| `/ecoplus fish cast` | `fish_cast` | Pêcher (bouton « Ferrer » au bon moment) | — | Tous |
| `/ecoplus fish sell` | `fish_sell` | Vendre vos poissons | `espece` (choice) | Tous |
| `/ecoplus fish collection` | `fish_collection` | Votre collection de poissons | `user` (user) | Tous |
| `/ecoplus hunt` | `hunt` | Partir à la chasse | — | Tous |
| `/ecoplus mine dig` | `mine_dig` | Miner un filon | — | Tous |
| `/ecoplus mine upgrade` | `mine_upgrade` | Améliorer votre pioche | — | Tous |
| `/ecoplus loan take` | `loan_take` | Contracter un prêt | `montant`* (integer), `duree`* (duration) | Tous |
| `/ecoplus loan repay` | `loan_repay` | Rembourser votre prêt | `montant` (integer) | Tous |
| `/ecoplus loan status` | `loan_status` | État de votre prêt | `user` (user) | Tous |
| `/ecoplus loan forgive` | `loan_forgive` | Annuler la dette d'un membre (admin) | `id`* (integer) | ManageGuild |
| `/ecoplus business list` | `business_list` | Entreprises disponibles et possédées | `user` (user) | Tous |
| `/ecoplus business buy` | `business_buy` | Acheter une entreprise | `type`* (string) | Tous |
| `/ecoplus business collect` | `business_collect` | Encaisser les revenus de vos entreprises | — | Tous |
| `/ecoplus business upgrade` | `business_upgrade` | Améliorer une entreprise | `type`* (string) | Tous |
| `/ecoplus quests list` | `quests_list` | Vos quêtes du jour | — | Tous |
| `/ecoplus quests claim` | `quests_claim` | Réclamer les récompenses des quêtes terminées | — | Tous |
| `/ecoplus prestige` | `prestige` | Prestige : tout recommencer contre un bonus permanent | `confirmer` (boolean) | Tous |
| `/ecoplus coupon create` | `coupon_create` | Créer un coupon (admin) | `code`* (string), `montant`* (integer), `usages` (integer), `duree` (duration) | ManageGuild |
| `/ecoplus coupon redeem` | `coupon_redeem` | Utiliser un coupon | `code`* (string) | Tous |
| `/ecoplus coupon list` | `coupon_list` | Lister les coupons (admin) | — | ManageGuild |
| `/ecoplus coupon delete` | `coupon_delete` | Supprimer un coupon (admin) | `code`* (string) | ManageGuild |
| `/ecoplus gift` | `gift` | Offrir de l'argent avec un message | `user`* (user), `montant`* (integer), `message` (string) | Tous |
| `/ecoplus event start` | `event_start` | Lancer un évènement saisonnier (multiplicateur) | `nom`* (string), `multiplicateur`* (number), `duree`* (duration) | ManageGuild |
| `/ecoplus event stop` | `event_stop` | Arrêter l'évènement en cours | — | ManageGuild |
| `/ecoplus event status` | `event_status` | Évènement saisonnier en cours | — | Tous |
| `/ecoplus globaltop` | `globaltop` | Classement de richesse multi-serveurs | — | Tous |
| `/ecoplus stats` | `stats` | Statistiques Économie+ du serveur | — | Tous |

**Vues du panel** : Prêts, Enchères, Entreprises, Coupons


## ⚔️ RPG <a id="rpg"></a>

`rpg` — Personnages (guerrier, mage, voleur), boutique, combats de boss et duels au tour par tour, boss de serveur et familiers Tamagotchi. 

**Paramètres (18)** : `healCostPerHp` (number, défaut `1`) — Coût du soin par PV · `potionPrice` (integer, défaut `60`) — Prix d'une potion · `trainCost` (integer, défaut `150`) — Coût de base de l'entraînement · `trainCooldownMinutes` (integer, défaut `60`) — Délai entre deux entraînements (min) · `regenPercent` (number, défaut `5`) — Régénération passive (% PV / 10 min) · `xpMultiplier` (number, défaut `1`) — Multiplicateur d'XP · `goldMultiplier` (number, défaut `1`) — Multiplicateur d'or · `bossCooldownMinutes` (integer, défaut `3`) — Délai entre deux combats de boss (min) · `maxDuelStake` (integer, défaut `10000`) — Mise maximale en duel · `bossEventChannel` (channel) — Salon des boss de serveur · `bossEventInterval` (integer, défaut `0`) — Boss automatique toutes les N heures · `bossEventDurationMinutes` (integer, défaut `30`) — Durée d'un boss de serveur (min) · `bossEventGold` (integer, défaut `1500`) — Or distribué par palier · `petChannel` (channel) — Salon des alertes familiers · `petDecayRate` (number, défaut `1`) — Vitesse de dégradation · `petRunawayHours` (integer, défaut `24`) — Fuite après N heures affamé · `petFoodCost` (integer, défaut `5`) — Prix d'un repas · `petAdoptCost` (integer, défaut `0`) — Prix d'adoption

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/rpg profile` | `profile` | Voir le profil RPG d'un joueur | `membre` (user) | Tous |
| `/rpg classes` | `classes` | Présentation des classes jouables | — | Tous |
| `/rpg create` | `create` | Créer votre personnage RPG | `classe`* (choice) | Tous |
| `/rpg heal` | `heal` | Se soigner à l'auberge (coût proportionnel aux PV manquants) | — | Tous |
| `/rpg train` | `train` | S'entraîner pour améliorer une statistique | `stat`* (choice) | Tous |
| `/rpg shop` | `shop` | Boutique RPG : afficher les objets ou en acheter un | `article` (string), `quantite` (integer) | Tous |
| `/rpg equip` | `equip` | Équiper (ou retirer) un objet de votre inventaire | `objet`* (string) | Tous |
| `/rpg inventory` | `inventory` | Voir votre inventaire RPG | — | Tous |
| `/rpg leaderboard` | `leaderboard` | Classement RPG du serveur | `tri` (choice) | Tous |
| `/rpg reset` | `reset` | Supprimer le personnage d'un membre | `membre`* (user) | ManageGuild |
| `/rpg fight boss` | `fight_boss` | Affronter un boss au tour par tour (Attaquer / Compétence / Potion / Fuir) | `palier` (integer) | Tous |
| `/rpg fight user` | `fight_user` | Défier un membre en duel (mise optionnelle) | `adversaire`* (user), `mise` (integer) | Tous |
| `/rpg fight accept` | `fight_accept` | Accepter le défi en duel qui vous a été lancé | — | Tous |
| `/rpg fight action` | `fight_action` | Jouer une action dans votre combat en cours (sans boutons) | `action`* (choice) | Tous |
| `/rpg fight status` | `fight_status` | Voir votre combat en cours | — | Tous |
| `/rpg bossevent start` | `bossevent_start` | Lancer (ou planifier) un boss de serveur que tout le monde peut attaquer | `palier` (integer), `duree` (duration), `pv` (integer), `salon` (channel), `delai` (duration) | ManageGuild |
| `/rpg bossevent status` | `bossevent_status` | État du boss de serveur actuel | — | Tous |
| `/rpg bossevent stop` | `bossevent_stop` | Arrêter le boss de serveur (sans récompense d'or) | — | ManageGuild |
| `/rpg pet adopt` | `pet_adopt` | Adopter un familier virtuel | `espece`* (choice), `nom`* (string) | Tous |
| `/rpg pet status` | `pet_status` | État de votre familier (ou de celui d'un membre) | `membre` (user) | Tous |
| `/rpg pet feed` | `pet_feed` | Nourrir votre familier | — | Tous |
| `/rpg pet play` | `pet_play` | Jouer avec votre familier | — | Tous |
| `/rpg pet rename` | `pet_rename` | Renommer votre familier | `nom`* (string) | Tous |
| `/rpg pet release` | `pet_release` | Relâcher votre familier (définitif) | `confirmer`* (boolean) | Tous |

**Vues du panel** : Personnages, Familiers, Boss de serveur


# Fun

## 🎪 Jeux de salon <a id="channelgames"></a>

`channelgames` — Compteur, chaîne de mots, histoire à un mot, salons restreints (emoji/média/lien/image), question et citation du jour, action ou vérité, ce ou ça, dernière lettre, patate chaude. 

**Paramètres (17)** : `countingFailMode` (choice, défaut `reset`) — Erreur de comptage · `countingPenalty` (integer, défaut `50`) — Amende par erreur (mode amende) · `countingAllowMath` (boolean, défaut `true`) — Accepter les calculs (ex : 2+3) · `countingSameUser` (boolean, défaut `false`) — Autoriser à compter deux fois de suite · `countingReactions` (boolean, défaut `true`) — Réagir aux bons nombres · `wordchainMinLength` (integer, défaut `2`) — Longueur minimale des mots · `wordchainSameUser` (boolean, défaut `false`) — Autoriser deux mots de suite du même membre · `wordchainFailMode` (choice, défaut `delete`) — Mot invalide · `storySameUser` (boolean, défaut `false`) — Histoire : deux mots de suite du même membre · `storyMaxWords` (integer, défaut `0`) — Histoire : nombre de mots avant clôture (0 = illimité) · `enforceBypassStaff` (boolean, défaut `true`) — Le staff (Gérer les messages) ignore les restrictions · `reminderSeconds` (integer, défaut `6`) — Durée des rappels temporaires (s) · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire · `qotdPingRole` (role) — Rôle mentionné pour la question du jour · `qotdThread` (boolean, défaut `true`) — Créer un fil de discussion · `todDefaults` (boolean, défaut `true`) — Action ou vérité : inclure les défis intégrés · `lastletterSeconds` (integer, défaut `20`) — Dernière lettre : secondes par tour

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/channelgames counting setup` | `counting_setup` | Définir un salon de comptage | `salon` (channel), `depart` (integer) | ManageChannels |
| `/channelgames counting status` | `counting_status` | État du compteur | `salon` (channel) | Tous |
| `/channelgames counting reset` | `counting_reset` | Remettre le compteur à zéro | `salon` (channel), `record` (boolean) | ManageChannels |
| `/channelgames counting record` | `counting_record` | Records et meilleurs compteurs | `salon` (channel) | Tous |
| `/channelgames counting disable` | `counting_disable` | Désactiver un salon de comptage | `salon` (channel) | ManageChannels |
| `/channelgames wordchain setup` | `wordchain_setup` | Définir un salon de chaîne de mots | `salon` (channel) | ManageChannels |
| `/channelgames wordchain status` | `wordchain_status` | État de la chaîne de mots | `salon` (channel) | Tous |
| `/channelgames wordchain reset` | `wordchain_reset` | Réinitialiser la chaîne de mots | `salon` (channel) | ManageChannels |
| `/channelgames wordchain disable` | `wordchain_disable` | Désactiver la chaîne de mots | `salon` (channel) | ManageChannels |
| `/channelgames onewordstory setup` | `story_setup` | Définir un salon d'histoire à un mot | `salon` (channel) | ManageChannels |
| `/channelgames onewordstory show` | `story_show` | Afficher l'histoire en cours | `salon` (channel), `archive` (integer) | Tous |
| `/channelgames onewordstory reset` | `story_reset` | Archiver l'histoire et en commencer une nouvelle | `salon` (channel) | ManageChannels |
| `/channelgames onewordstory disable` | `story_disable` | Désactiver l'histoire à un mot | `salon` (channel) | ManageChannels |
| `/channelgames lastletter` | `lastletter` | Partie de « dernière lettre » (élimination) | — | Tous |
| `/channelgames potato` | `potato` | Patate chaude : passez-la avant qu'elle explose | — | Tous |
| `/channelgames enforce set` | `enforce_set` | Restreindre un salon à un type de contenu | `type`* (choice), `salon` (channel) | ManageChannels |
| `/channelgames enforce remove` | `enforce_remove` | Retirer la restriction d'un salon | `salon` (channel) | ManageChannels |
| `/channelgames enforce list` | `enforce_list` | Lister les salons restreints | — | ManageChannels |
| `/channelgames qotd add` | `qotd_add` | Ajouter une question du jour | `question`* (string) | ManageMessages |
| `/channelgames qotd remove` | `qotd_remove` | Supprimer une question du jour | `id`* (integer) | ManageMessages |
| `/channelgames qotd list` | `qotd_list` | Lister les questions du jour | `toutes` (boolean) | ManageMessages |
| `/channelgames qotd schedule` | `qotd_schedule` | Planifier la question du jour | `salon`* (channel), `heure`* (string), `actif` (boolean) | ManageGuild |
| `/channelgames qotd now` | `qotd_now` | Publier la question du jour maintenant | — | ManageGuild |
| `/channelgames tod random` | `tod_random` | Tirer une action ou une vérité | `type` (choice) | Tous |
| `/channelgames tod add` | `tod_add` | Ajouter une action ou une vérité | `type`* (choice), `texte`* (string) | ManageMessages |
| `/channelgames tod list` | `tod_list` | Lister les actions/vérités du serveur | — | Tous |
| `/channelgames tod remove` | `tod_remove` | Supprimer une action/vérité | `id`* (integer) | ManageMessages |
| `/channelgames thisorthat play` | `tot_play` | Lancer un vote « ce ou ça » | `a` (string), `b` (string) | Tous |
| `/channelgames thisorthat add` | `tot_add` | Ajouter un duo « ce ou ça » | `a`* (string), `b`* (string) | ManageMessages |
| `/channelgames quoteoftheday setup` | `quote_setup` | Planifier la citation du jour | `salon`* (channel), `heure` (string), `actif` (boolean) | ManageGuild |
| `/channelgames quoteoftheday now` | `quote_now` | Publier la citation du jour maintenant | — | ManageGuild |
| `/channelgames quoteoftheday add` | `quote_add` | Ajouter une citation personnalisée | `texte`* (string), `auteur` (string) | ManageMessages |

**Vues du panel** : Salons restreints, Questions du jour, Compteurs


## 🎲 Fun <a id="fun"></a>

`fun` — Mini-jeux (morpion, pendu, quiz, devinette), 8ball, blagues, mèmes, manipulations d'images et commandes amusantes. 

**Paramètres (5)** : `removeBgKey` (string) — Clé API remove.bg · `memeSubreddits` (list) — Subreddits de mèmes · `triviaSeconds` (integer, défaut `30`) — Temps de réponse au quiz (s) · `guessMax` (integer, défaut `100`) — Borne par défaut de /game guess · `messageGuesses` (boolean, défaut `true`) — Réponses par message

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/fun 8ball` | `eightball` | Poser une question à la boule magique | `question`* (string) | Tous |
| `/fun coinflip` | `coinflip` | Pile ou face | `choix` (choice) | Tous |
| `/fun dice` | `dice` | Lancer des dés (ex: 2d20+3) | `faces` (integer), `nombre` (integer), `notation` (string) | Tous |
| `/fun rps` | `rps` | Pierre-feuille-ciseaux contre le bot ou un membre (boutons) | `adversaire` (user), `choix` (choice) | Tous |
| `/fun choose` | `choose` | Choisir au hasard parmi plusieurs options | `options`* (list) | Tous |
| `/fun ship` | `ship` | Calculer la compatibilité entre deux membres | `membre1`* (user), `membre2` (user) | Tous |
| `/fun lovecalc` | `lovecalc` | Calculateur d'amour entre deux noms | `nom1`* (string), `nom2`* (string) | Tous |
| `/fun joke` | `joke` | Une blague au hasard | — | Tous |
| `/fun fact` | `fact` | Un fait insolite | — | Tous |
| `/fun wyr` | `wyr` | Tu préfères… ? (vote par boutons) | `option_a` (string), `option_b` (string) | Tous |
| `/fun roast` | `roast` | Clasher gentiment un membre | `membre`* (user) | Tous |
| `/fun hug` | `hug` | Faire un câlin à un membre | `membre`* (user) | Tous |
| `/fun slap` | `slap` | Mettre une claque à un membre | `membre`* (user) | Tous |
| `/fun reverse` | `reverse` | Inverser un texte | `texte`* (string) | Tous |
| `/fun mock` | `mock` | tExTe MoQuEuR façon Bob l'éponge | `texte`* (string) | Tous |
| `/fun ascii` | `ascii` | Encadrer un texte en ASCII | `texte`* (string), `style` (choice) | Tous |
| `/fun cat` | `cat` | Une photo de chat au hasard | — | Tous |
| `/fun dog` | `dog` | Une photo de chien au hasard | `race` (string) | Tous |
| `/game tictactoe` | `tictactoe` | Morpion contre un membre ou contre l'IA (minimax) | `adversaire` (user), `difficulte` (choice), `case` (integer) | Tous |
| `/game hangman` | `hangman` | Jeu du pendu (lettres via menus ou messages) | `categorie` (choice), `ouvert` (boolean), `lettre` (string) | Tous |
| `/game trivia` | `trivia` | Question de quiz (60+ questions en français) | `categorie` (choice), `ouvert` (boolean), `reponse` (choice) | Tous |
| `/game guess` | `guess` | Deviner un nombre (plus / moins) | `max` (integer), `proposition` (integer) | Tous |
| `/game reset` | `scores_reset` | Réinitialiser les scores des mini-jeux (d'un membre ou du serveur) | `membre` (user) | ManageGuild |
| `/game leaderboard` | `game_leaderboard` | Classement des mini-jeux | `jeu` (choice) | Tous |
| `/fun meme random` | `meme_random` | Un mème au hasard depuis Reddit | `subreddit` (string) | Tous |
| `/fun meme create` | `meme_create` | Créer un mème à partir d'un modèle memegen.link | `template`* (string), `haut` (string), `bas` (string) | Tous |
| `/fun meme templates` | `meme_templates` | Lister les modèles de mèmes disponibles | `recherche` (string) | Tous |
| `/fun meme caption` | `meme_caption` | Ajouter un texte façon mème sur une image (« haut \| bas ») | `texte`* (string), `image_url` (string), `fichier` (attachment), `membre` (user) | Tous |
| `/fun image grayscale` | `image_grayscale` | Convertir une image en noir et blanc | `membre` (user), `url` (string), `fichier` (attachment) | Tous |
| `/fun image invert` | `image_invert` | Inverser les couleurs d'une image | `membre` (user), `url` (string), `fichier` (attachment) | Tous |
| `/fun image pixelate` | `image_pixelate` | Pixeliser une image | `membre` (user), `url` (string), `fichier` (attachment), `intensite` (integer) | Tous |
| `/fun image blur` | `image_blur` | Flouter une image | `membre` (user), `url` (string), `fichier` (attachment), `rayon` (integer) | Tous |
| `/fun image flip` | `image_flip` | Retourner une image | `membre` (user), `url` (string), `fichier` (attachment), `sens` (choice) | Tous |
| `/fun image deepfry` | `image_deepfry` | Effet « deep fried » saturé | `membre` (user), `url` (string), `fichier` (attachment) | Tous |
| `/fun image circle` | `image_circle` | Découper une image en cercle | `membre` (user), `url` (string), `fichier` (attachment) | Tous |
| `/fun image wanted` | `image_wanted` | Affiche WANTED | `membre` (user), `url` (string), `fichier` (attachment), `prime` (integer) | Tous |
| `/fun image triggered` | `image_triggered` | GIF animé « TRIGGERED » | `membre` (user), `url` (string), `fichier` (attachment) | Tous |
| `/fun image removebg` | `image_removebg` | Supprimer l'arrière-plan d'une image (API remove.bg) | `membre` (user), `url` (string), `fichier` (attachment) | Tous |

**Vues du panel** : Scores des mini-jeux


## 🕹️ Mini-jeux <a id="minigames"></a>

`minigames` — Wordle, puissance 4, 2048, démineur, memory, bataille navale, quiz duel, pendu, courses de frappe et de calcul… avec scores et mises optionnelles. 

**Paramètres (9)** : `allowBets` (boolean, défaut `true`) — Autoriser les mises · `maxBet` (integer, défaut `10000`) — Mise maximale (0 = illimitée) · `gameChannels` (list) — Salons autorisés · `typingTolerance` (number, défaut `0.9`) — Tolérance de la course de frappe · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire · `quizDayEnabled` (boolean, défaut `false`) — Quiz du jour activé · `quizDayChannel` (channel) — Salon du quiz du jour · `quizDayTime` (string, défaut `12:00`) — Heure de publication (HH:MM) · `quizDayPing` (role) — Rôle à mentionner

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/minigames wordle` | `wordle` | Wordle : trouver un mot de 5 lettres en 6 essais | `mode` (choice), `mise` (integer) | Tous |
| `/minigames connect4` | `connect4` | Puissance 4 contre un membre ou le bot | `adversaire` (user), `mise` (integer) | Tous |
| `/minigames 2048` | `g2048` | Jeu 2048 avec des boutons fléchés | — | Tous |
| `/minigames minesweeper` | `minesweeper` | Démineur 5×5 à boutons | `mines` (integer), `mise` (integer) | Tous |
| `/minigames typing` | `typing` | Course de frappe : recopier la phrase le plus vite | — | Tous |
| `/minigames scramble` | `scramble` | Anagramme : retrouver le mot mélangé | — | Tous |
| `/minigames memory` | `memory` | Memory : retrouver les paires d'emojis | — | Tous |
| `/minigames mathrace` | `mathrace` | Course de calcul mental dans le salon | `manches` (integer), `difficulte` (choice) | Tous |
| `/minigames reaction` | `reaction` | Réflexes : cliquer dès que le bouton devient vert | — | Tous |
| `/minigames roulette` | `roulette` | Roulette russe : tirez ou encaissez | `mise` (integer) | Tous |
| `/minigames dice` | `dice` | Duel de dés contre un membre | `adversaire`* (user), `mise` (integer) | Tous |
| `/minigames battleship` | `battleship` | Bataille navale 5×5 (solo ou contre un membre) | `adversaire` (user), `mise` (integer) | Tous |
| `/minigames quizduel` | `quizduel` | Duel de quiz contre un membre | `adversaire`* (user), `manches` (integer), `mise` (integer) | Tous |
| `/minigames quizday` | `quizday` | Configurer le quiz du jour (salon, heure) | `salon` (channel), `heure` (string), `actif` (boolean), `maintenant` (boolean) | ManageGuild |
| `/minigames hangman` | `hangman` | Pendu coopératif dans le salon | — | Tous |
| `/minigames guessnumber` | `guessnumber` | Devine le nombre (multijoueur, plus/moins) | `max` (integer) | Tous |
| `/minigames guess` | `guess` | Proposer une réponse (wordle, pendu, anagramme…) | `texte`* (string) | Tous |
| `/minigames leaderboard` | `leaderboard` | Classement des mini-jeux | `jeu` (choice) | Tous |
| `/minigames stats` | `stats` | Statistiques de mini-jeux d'un membre | `user` (user) | Tous |
| `/minigames cancel` | `cancel` | Annuler votre partie en cours | — | Tous |


## 🎲 Jeu de rôle <a id="tabletop"></a>

`tabletop` — Dés avancés, tables aléatoires, PNJ, butin, initiative, fiches de personnage, cartes, dés Fate et générateurs. 

**Paramètres (3)** : `maxRepeat` (integer, défaut `20`) — Répétitions max par lancer · `showDetails` (boolean, défaut `true`) — Afficher le détail de chaque dé · `critMessages` (boolean, défaut `true`) — Messages de critique (nat 20 / nat 1)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/roll dice` | `dice` | Lancer des dés (2d6+3, 4d6kh3, d20 adv, 3d6!, 6d10>=7, x3…) | `expression`* (string), `personnage` (string), `secret` (boolean) | Tous |
| `/roll stats` | `stats` | Distribution statistique d'une expression de dés | `expression`* (string) | Tous |
| `/roll npc` | `npc` | Générer un PNJ (nom, race, métier, trait, secret) | `nombre` (integer) | Tous |
| `/roll loot` | `loot` | Générer un butin selon le niveau | `niveau` (integer) | Tous |
| `/roll name` | `name` | Générateur de noms (fantasy, sf, moderne, nain, orc) | `style` (choice), `nombre` (integer) | Tous |
| `/roll coin` | `coin` | Pile ou face | `nombre` (integer) | Tous |
| `/roll card` | `card` | Tirer des cartes d'un jeu de 52 (paquet par salon) | `nombre` (integer), `melanger` (boolean), `salon` (channel) | Tous |
| `/roll fate` | `fate` | Lancer 4 dés Fate (4dF) avec l'échelle des résultats | `modificateur` (integer) | Tous |
| `/roll encounter` | `encounter` | Générer une rencontre aléatoire | `environnement` (choice) | Tous |
| `/roll weather` | `weather` | Générer la météo du jour | `saison` (choice) | Tous |
| `/roll tavern` | `tavern` | Générer une taverne et une rumeur | — | Tous |
| `/roll table create` | `table_create` | Créer une table aléatoire | `nom`* (string), `description` (string), `entrees` (list) | ManageMessages |
| `/roll table add` | `table_add` | Ajouter une entrée à une table | `table`* (string), `entree`* (string), `poids` (integer) | ManageMessages |
| `/roll table remove` | `table_remove` | Retirer une entrée (par numéro) | `table`* (string), `numero`* (integer) | ManageMessages |
| `/roll table roll` | `table_roll` | Tirer dans une table aléatoire | `table`* (string), `fois` (integer), `unique` (boolean) | Tous |
| `/roll table list` | `table_list` | Lister les tables aléatoires | — | Tous |
| `/roll table view` | `table_view` | Voir le contenu d'une table | `table`* (string) | Tous |
| `/roll table delete` | `table_delete` | Supprimer une table | `table`* (string) | ManageMessages |
| `/roll initiative add` | `initiative_add` | Ajouter un combattant à l'initiative du salon | `nom`* (string), `valeur` (integer), `modificateur` (integer), `joueur` (user), `salon` (channel) | Tous |
| `/roll initiative list` | `initiative_list` | Afficher l'ordre d'initiative | `salon` (channel) | Tous |
| `/roll initiative next` | `initiative_next` | Passer au tour suivant | `salon` (channel) | Tous |
| `/roll initiative remove` | `initiative_remove` | Retirer un combattant | `nom`* (string), `salon` (channel) | Tous |
| `/roll initiative clear` | `initiative_clear` | Réinitialiser l'initiative du salon | `salon` (channel) | Tous |
| `/roll character create` | `character_create` | Créer une fiche de personnage | `nom`* (string), `classe` (string), `niveau` (integer), `pv` (integer), `caracs` (string), `notes` (text) | Tous |
| `/roll character show` | `character_show` | Afficher une fiche de personnage | `nom` (string), `joueur` (user) | Tous |
| `/roll character set` | `character_set` | Modifier un champ de votre fiche | `nom`* (string), `champ`* (choice), `valeur`* (string) | Tous |
| `/roll character list` | `character_list` | Lister les fiches de personnage | `joueur` (user) | Tous |
| `/roll character delete` | `character_delete` | Supprimer une fiche de personnage | `nom`* (string), `joueur` (user) | Tous |

**Vues du panel** : Personnages, Tables aléatoires


# Général

## 📁 Salons <a id="channels"></a>

`channels` — Gestion avancée des salons : création, clonage, archives, modèles, salons temporaires, messages collants, planifications, nettoyage. 

**Paramètres (9)** : `logChannel` (channel) — Salon des logs · `archiveCategory` (channel) — Catégorie des archives · `archiveMode` (choice, défaut `readonly`) — Mode d'archivage · `pinsArchiveChannel` (channel) — Salon d'archive des épingles · `tempCategory` (channel) — Catégorie des salons temporaires · `tempMaxDuration` (duration, défaut `30d`) — Durée max d'un salon temporaire · `stickyDefaultEvery` (integer, défaut `5`) — Message collant : repost tous les N messages (défaut) · `cleanupProtected` (list) — Salons protégés du nettoyage · `timezone` (string, défaut `Europe/Paris`) — Fuseau horaire des planifications

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/channels create` | `create` | Créer un salon | `name`* (string), `type` (choice), `parent` (channel), `topic` (string), `nsfw` (boolean), `slowmode` (integer), `private` (boolean) | ManageChannels |
| `/channels delete` | `delete` | Supprimer un salon | `channel`* (channel), `reason` (string) | ManageChannels |
| `/channels clone` | `clone` | Cloner un salon (permissions comprises) | `channel`* (channel), `name` (string) | ManageChannels |
| `/channels edit` | `edit` | Modifier un salon | `channel`* (channel), `name` (string), `topic` (string), `nsfw` (boolean), `slowmode` (integer), `bitrate` (integer), `user_limit` (integer), `parent` (channel), `no_parent` (boolean) | ManageChannels |
| `/channels move` | `move` | Déplacer un salon (catégorie / position) | `channel`* (channel), `parent` (channel), `position` (integer), `sync` (boolean) | ManageChannels |
| `/channels syncperms` | `syncperms` | Synchroniser les permissions avec la catégorie | `channel`* (channel) | ManageChannels |
| `/channels copyperms` | `copyperms` | Copier les permissions d'un salon vers un autre | `from`* (channel), `to`* (channel) | ManageChannels |
| `/channels archive` | `archive` | Archiver un salon (déplacer + verrouiller) | `channel`* (channel), `reason` (string) | ManageChannels |
| `/channels unarchive` | `unarchive` | Restaurer un salon archivé | `channel`* (channel) | ManageChannels |
| `/channels cleanup` | `cleanup` | Lister/supprimer les salons inactifs | `days`* (integer), `category` (channel), `delete` (boolean), `confirm` (boolean) | ManageChannels |
| `/channels nsfw` | `nsfw` | Activer/désactiver le NSFW d'un salon | `channel`* (channel), `value` (boolean) | ManageChannels |
| `/channels rename` | `rename` | Préfixe/suffixe sur les salons d'une catégorie | `category`* (channel), `prefix` (string), `suffix` (string), `strip` (boolean) | ManageChannels |
| `/channels stats` | `stats` | Messages des 7 derniers jours par salon | `category` (channel) | ManageChannels |
| `/channels topic` | `topic` | Définir le sujet d'un salon | `text` (string), `channel` (channel) | ManageChannels |
| `/channels order` | `order` | Trier les salons d'une catégorie par nom | `category`* (channel), `desc` (boolean) | ManageChannels |
| `/channels info` | `info` | Informations sur un salon | `channel` (channel) | Tous |
| `/channels templates save` | `templates_save` | Enregistrer la structure d'une catégorie | `category`* (channel), `name`* (string) | ManageChannels |
| `/channels templates apply` | `templates_apply` | Créer une catégorie depuis un modèle | `name`* (string), `category_name` (string) | ManageChannels |
| `/channels templates list` | `templates_list` | Lister les modèles de catégories | — | ManageChannels |
| `/channels templates delete` | `templates_delete` | Supprimer un modèle de catégorie | `name`* (string) | ManageChannels |
| `/channels temptext create` | `temptext_create` | Créer un salon textuel temporaire | `name`* (string), `duration`* (duration), `parent` (channel), `private` (boolean), `user` (user) | ManageChannels |
| `/channels temptext list` | `temptext_list` | Lister les salons temporaires | — | ManageChannels |
| `/channels temptext delete` | `temptext_delete` | Supprimer / prolonger un salon temporaire | `channel`* (channel), `extend` (duration) | ManageChannels |
| `/channels pins list` | `pins_list` | Lister les messages épinglés | `channel` (channel) | Tous |
| `/channels pins pin` | `pins_pin` | Épingler un message | `message_id`* (string), `channel` (channel) | ManageMessages |
| `/channels pins unpin` | `pins_unpin` | Désépingler un message | `message_id`* (string), `channel` (channel) | ManageMessages |
| `/channels pins archive` | `pins_archive` | Copier les épingles dans un salon d'archives | `channel`* (channel), `dest` (channel), `unpin` (boolean) | ManageMessages |
| `/channels sticky set` | `sticky_set` | Définir un message collant | `content`* (text), `channel` (channel), `every` (integer), `delay` (duration), `embed` (boolean) | ManageMessages |
| `/channels sticky remove` | `sticky_remove` | Retirer le message collant | `channel` (channel) | ManageMessages |
| `/channels sticky list` | `sticky_list` | Lister les messages collants | — | ManageMessages |
| `/channels slowmode add` | `slowmode_add` | Planifier un mode lent quotidien | `channel`* (channel), `seconds`* (integer), `start`* (string), `end`* (string), `off` (integer) | ManageChannels |
| `/channels slowmode remove` | `slowmode_remove` | Supprimer un mode lent planifié | `id`* (integer) | ManageChannels |
| `/channels slowmode list` | `slowmode_list` | Lister les modes lents planifiés | — | ManageChannels |
| `/channels purge add` | `purge_add` | Planifier une purge automatique | `channel`* (channel), `interval`* (duration), `keep_pinned` (boolean) | ManageMessages, ManageChannels |
| `/channels purge remove` | `purge_remove` | Supprimer une purge planifiée | `id`* (integer) | ManageMessages |
| `/channels purge list` | `purge_list` | Lister les purges planifiées | — | ManageMessages |
| `/channels purge run` | `purge_run` | Exécuter une purge planifiée maintenant | `id`* (integer) | ManageMessages |

**Vues du panel** : Messages collants, Modèles de catégories, Purges automatiques, Salons archivés, Modes lents planifiés, Salons temporaires


## 😀 Emojis <a id="emojis"></a>

`emojis` — Emojis et stickers : ajout, vol, packs, verrouillage par rôle, statistiques d'utilisation, nettoyage, agrandissement. 

**Paramètres (4)** : `logChannel` (channel) — Salon des logs · `trackUsage` (boolean, défaut `true`) — Suivre l'utilisation dans les messages · `trackReactions` (boolean, défaut `true`) — Suivre l'utilisation en réaction · `maxPerMessage` (integer, défaut `3`) — Occurrences max comptées par emoji et par message

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/emojis list` | `list` | Lister les emojis du serveur | `type` (choice), `page` (integer), `grid` (boolean) | Tous |
| `/emojis add` | `add` | Ajouter un emoji (URL ou fichier) | `name`* (string), `url` (string), `attachment` (attachment), `roles` (list) | ManageGuildExpressions |
| `/emojis steal` | `steal` | Copier des emojis d'un autre serveur | `emojis`* (string), `name` (string) | ManageGuildExpressions |
| `/emojis rename` | `rename` | Renommer un emoji | `emoji`* (string), `name`* (string) | ManageGuildExpressions |
| `/emojis delete` | `delete` | Supprimer un emoji | `emoji`* (string), `reason` (string) | ManageGuildExpressions |
| `/emojis info` | `info` | Informations sur un emoji | `emoji`* (string) | Tous |
| `/emojis big` | `big` | Afficher un emoji en grand | `emoji`* (string) | Tous |
| `/emojis stats` | `stats` | Statistiques d'utilisation des emojis | `mode` (choice), `days` (integer), `limit` (integer) | Tous |
| `/emojis lock` | `lock` | Restreindre un emoji à des rôles | `emoji`* (string), `role`* (role), `role2` (role), `role3` (role) | ManageGuildExpressions |
| `/emojis unlock` | `unlock` | Retirer la restriction de rôles d'un emoji | `emoji`* (string), `role` (role) | ManageGuildExpressions |
| `/emojis cleanup` | `cleanup` | Supprimer les emojis inutilisés depuis N jours | `days`* (integer), `delete` (boolean), `confirm` (boolean) | ManageGuildExpressions |
| `/emojis random` | `random` | Un emoji du serveur au hasard | `type` (choice) | Tous |
| `/emojis pack export` | `pack_export` | Exporter les emojis (JSON + liste d'URL) | `type` (choice) | ManageGuildExpressions |
| `/emojis pack import` | `pack_import` | Importer un pack d'emojis (JSON) | `file` (attachment), `json` (json), `prefix` (string), `limit` (integer) | ManageGuildExpressions |
| `/emojis stickers list` | `stickers_list` | Lister les stickers du serveur | — | Tous |
| `/emojis stickers add` | `stickers_add` | Ajouter un sticker (PNG/APNG/GIF) | `name`* (string), `tags`* (string), `url` (string), `attachment` (attachment), `description` (string) | ManageGuildExpressions |
| `/emojis stickers delete` | `stickers_delete` | Supprimer un sticker | `sticker`* (string) | ManageGuildExpressions |
| `/emojis stickers steal` | `stickers_steal` | Copier un sticker (ID ou message) | `sticker_id` (string), `message_id` (string), `channel` (channel), `name` (string) | ManageGuildExpressions |

**Vues du panel** : Utilisation des emojis, Stickers


## 🎭 Rôles <a id="roles"></a>

`roles` — Gestion avancée des rôles : création, clonage, audit, rôles couleur, auto-attribuables, temporaires, instantanés, statistiques. 

**Paramètres (11)** : `logChannel` (channel) — Salon des logs · `colorRolesEnabled` (boolean, défaut `false`) — Rôles couleur personnels · `colorAnchorRole` (role) — Rôle repère des couleurs · `colorAllowedRoles` (list) — Rôles autorisés à choisir une couleur · `colorRolePrefix` (string, défaut `🎨 `) — Préfixe des rôles couleur · `colorDeleteOnLeave` (boolean, défaut `true`) — Supprimer le rôle couleur au départ du membre · `boostRole` (role) — Rôle des boosters · `boostRoleRemove` (boolean, défaut `true`) — Retirer le rôle à la fin du boost · `selfroleMax` (integer, défaut `0`) — Nombre max de rôles auto-attribuables par membre · `selfroleExclusiveGroups` (boolean, défaut `false`) — Groupes exclusifs · `mentionDefaultDuration` (duration, défaut `5m`) — Durée par défaut de /roles mention

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/roles create` | `create` | Créer un rôle | `name`* (string), `color` (color), `hoist` (boolean), `mentionable` (boolean), `preset` (choice), `below` (role) | ManageRoles |
| `/roles delete` | `delete` | Supprimer un rôle | `role`* (role), `reason` (string) | ManageRoles |
| `/roles edit` | `edit` | Modifier un rôle | `role`* (role), `name` (string), `color` (color), `hoist` (boolean), `mentionable` (boolean), `preset` (choice), `add_perms` (list), `remove_perms` (list) | ManageRoles |
| `/roles clone` | `clone` | Cloner un rôle (permissions, couleur…) | `role`* (role), `name` (string), `copy_members` (boolean) | ManageRoles |
| `/roles info` | `info` | Informations sur un rôle | `role`* (role) | Tous |
| `/roles members` | `members` | Membres d'un rôle (paginé, export CSV) | `role`* (role), `page` (integer), `csv` (boolean) | ManageRoles |
| `/roles list` | `list` | Lister les rôles du serveur | `page` (integer) | Tous |
| `/roles move` | `move` | Déplacer un rôle dans la hiérarchie | `role`* (role), `position` (integer), `above` (role), `below` (role) | ManageRoles |
| `/roles color` | `color` | Choisir sa couleur de pseudo (rôle couleur personnel) | `color` (color), `reset` (boolean), `user` (user) | Tous |
| `/roles hierarchy` | `hierarchy` | Arbre de la hiérarchie des rôles | — | Tous |
| `/roles audit` | `audit` | Rapport des rôles aux permissions dangereuses | — | ManageRoles |
| `/roles compare` | `compare` | Comparer les permissions (membre ou rôle vs rôle) | `role`* (role), `user` (user), `role2` (role) | ManageRoles |
| `/roles stats` | `stats` | Nombre de membres par rôle (graphique) | `limit` (integer), `managed` (boolean) | Tous |
| `/roles mention` | `mention` | Rendre un rôle mentionnable temporairement | `role`* (role), `duration` (duration), `message` (string), `channel` (channel) | ManageRoles |
| `/roles give` | `give` | Ajouter/retirer un rôle selon des critères | `role`* (role), `criterion`* (choice), `date` (date), `filter_role` (role), `mode` (choice), `dry` (boolean) | ManageRoles |
| `/roles boostrole` | `boostrole` | Configurer le rôle automatique des boosters | `role` (role), `disable` (boolean), `sync` (boolean) | ManageRoles |
| `/roles selfrole add` | `selfrole_add` | Ajouter un rôle auto-attribuable | `role`* (role), `description` (string), `emoji` (string), `group` (string) | ManageRoles |
| `/roles selfrole remove` | `selfrole_remove` | Retirer un rôle auto-attribuable | `role`* (role) | ManageRoles |
| `/roles selfrole list` | `selfrole_list` | Lister les rôles auto-attribuables | — | Tous |
| `/roles selfrole get` | `selfrole_get` | Prendre ou retirer un rôle auto-attribuable | `role`* (role) | Tous |
| `/roles selfrole panel` | `selfrole_panel` | Publier un menu de rôles auto-attribuables | `channel` (channel), `title` (string), `group` (string) | ManageRoles |
| `/roles timed add` | `timed_add` | Donner un rôle temporaire | `user`* (user), `role`* (role), `duration`* (duration), `reason` (string) | ManageRoles |
| `/roles timed list` | `timed_list` | Lister les rôles temporaires | `user` (user) | ManageRoles |
| `/roles timed remove` | `timed_remove` | Retirer un rôle temporaire maintenant | `id`* (integer), `keep_role` (boolean) | ManageRoles |
| `/roles snapshot save` | `snapshot_save` | Sauvegarder les rôles d'un membre | `user`* (user), `name`* (string) | ManageRoles |
| `/roles snapshot restore` | `snapshot_restore` | Restaurer une sauvegarde de rôles | `user`* (user), `name`* (string), `exact` (boolean) | ManageRoles |
| `/roles snapshot list` | `snapshot_list` | Lister les sauvegardes de rôles | `user` (user) | ManageRoles |
| `/roles snapshot delete` | `snapshot_delete` | Supprimer une sauvegarde de rôles | `user`* (user), `name`* (string) | ManageRoles |
| `/roles everyone show` | `everyone_show` | Afficher les permissions de @everyone | — | ManageRoles |
| `/roles everyone set` | `everyone_set` | Ajouter/retirer des permissions à @everyone | `permissions`* (list), `mode` (choice), `force` (boolean) | ManageRoles |

**Vues du panel** : Rôles auto-attribuables, Rôles temporaires, Sauvegardes de rôles, Rôles couleur


## 🧵 Fils <a id="threads"></a>

`threads` — Fils de discussion : création automatique, maintien en vie, gestion, forums (tags, publications, tags automatiques), nettoyage. 

**Paramètres (5)** : `logChannel` (channel) — Salon des logs · `defaultArchive` (choice, défaut `1440`) — Archivage automatique par défaut · `autothreadTemplate` (string, défaut `Discussion de {user}`) — Nom par défaut des fils automatiques · `autothreadMessage` (text, défaut ``) — Message posté dans chaque fil automatique · `keepaliveUnarchive` (boolean, défaut `true`) — Désarchiver immédiatement les fils maintenus

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/threads create` | `create` | Créer un fil | `name`* (string), `channel` (channel), `message_id` (string), `content` (text), `private` (boolean), `archive` (choice) | CreatePublicThreads |
| `/threads archive` | `archive` | Archiver un fil | `thread`* (channel) | ManageThreads |
| `/threads unarchive` | `unarchive` | Désarchiver un fil | `thread`* (channel) | ManageThreads |
| `/threads lock` | `lock` | Verrouiller un fil | `thread`* (channel), `archive` (boolean) | ManageThreads |
| `/threads unlock` | `unlock` | Déverrouiller un fil | `thread`* (channel) | ManageThreads |
| `/threads rename` | `rename` | Renommer un fil | `thread`* (channel), `name`* (string) | ManageThreads |
| `/threads delete` | `delete` | Supprimer un fil | `thread`* (channel), `reason` (string) | ManageThreads |
| `/threads list` | `list` | Fils actifs et archivés récents | `channel` (channel) | Tous |
| `/threads joinall` | `joinall` | Ajouter un membre (ou le bot) à tous les fils actifs | `user` (user), `channel` (channel) | ManageThreads |
| `/threads cleanup` | `cleanup` | Archiver les fils inactifs depuis N jours | `days`* (integer), `channel` (channel), `dry` (boolean), `lock` (boolean) | ManageThreads |
| `/threads stats` | `stats` | Statistiques des fils | — | Tous |
| `/threads autothread add` | `autothread_add` | Créer un fil sous chaque message d'un salon | `channel`* (channel), `name` (string), `archive` (choice), `include_bots` (boolean) | ManageThreads |
| `/threads autothread remove` | `autothread_remove` | Désactiver les fils automatiques d'un salon | `channel`* (channel) | ManageThreads |
| `/threads autothread list` | `autothread_list` | Lister les salons à fils automatiques | — | ManageThreads |
| `/threads keepalive add` | `keepalive_add` | Empêcher l'archivage automatique d'un fil | `thread`* (channel) | ManageThreads |
| `/threads keepalive remove` | `keepalive_remove` | Ne plus maintenir un fil actif | `thread`* (channel) | ManageThreads |
| `/threads keepalive list` | `keepalive_list` | Lister les fils maintenus actifs | — | ManageThreads |
| `/threads forum tags` | `forum_tags` | Lister les tags d'un forum | `channel`* (channel) | Tous |
| `/threads forum tag-add` | `forum_tag_add` | Ajouter un tag à un forum | `channel`* (channel), `name`* (string), `emoji` (string), `moderated` (boolean) | ManageChannels |
| `/threads forum tag-remove` | `forum_tag_remove` | Retirer un tag d'un forum | `channel`* (channel), `tag`* (string) | ManageChannels |
| `/threads forum post` | `forum_post` | Publier un post dans un forum | `channel`* (channel), `title`* (string), `content`* (text), `tags` (list) | ManageThreads |
| `/threads forum pin` | `forum_pin` | Épingler un post de forum | `thread`* (channel) | ManageThreads |
| `/threads forum unpin` | `forum_unpin` | Désépingler un post de forum | `thread`* (channel) | ManageThreads |
| `/threads forum autotag` | `forum_autotag` | Tag automatique (par défaut ou mots-clés) | `channel`* (channel), `tag`* (string), `keywords` (list) | ManageThreads |
| `/threads forum autotag-remove` | `forum_autotag_remove` | Supprimer une règle de tag automatique | `id`* (integer) | ManageThreads |
| `/threads forum rules` | `forum_rules` | Lister les règles de tags automatiques | `channel` (channel) | ManageThreads |

**Vues du panel** : Fils automatiques, Fils maintenus actifs, Règles de tags de forum


## 🪝 Webhooks <a id="webhooks"></a>

`webhooks` — Webhooks : liste, création, envoi avec identité personnalisée, « parler en tant que », protection contre les webhooks non autorisés, webhooks externes enregistrés. 

**Paramètres (7)** : `logChannel` (channel) — Salon des logs · `guardEnabled` (boolean, défaut `false`) — Protection des webhooks · `guardAction` (choice, défaut `delete`) — Action de la protection · `guardWhitelistRoles` (list) — Rôles autorisés à créer des webhooks · `guardWhitelistUsers` (list) — Utilisateurs autorisés à créer des webhooks · `sendasEnabled` (boolean, défaut `true`) — Autoriser « parler en tant que » · `proxyName` (string, défaut `HeiphaisBot Relais`) — Nom du webhook relais du bot

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/webhooks list` | `list` | Lister les webhooks du serveur | `channel` (channel) | ManageWebhooks |
| `/webhooks create` | `create` | Créer un webhook | `channel`* (channel), `name`* (string), `avatar` (string) | ManageWebhooks |
| `/webhooks delete` | `delete` | Supprimer un webhook | `webhook`* (string), `reason` (string) | ManageWebhooks |
| `/webhooks edit` | `edit` | Modifier un webhook | `webhook`* (string), `name` (string), `avatar` (string), `channel` (channel) | ManageWebhooks |
| `/webhooks send` | `send` | Envoyer un message via un webhook | `webhook`* (string), `message` (text), `embed` (json), `username` (string), `avatar` (string), `thread` (string) | ManageWebhooks |
| `/webhooks sendas` | `sendas` | Envoyer un message « en tant que » un membre | `user`* (user), `message`* (text), `channel` (channel) | ManageWebhooks |
| `/webhooks editmsg` | `editmsg` | Modifier un message envoyé par un webhook | `webhook`* (string), `message_id`* (string), `content` (text), `embed` (json), `thread` (string) | ManageWebhooks |
| `/webhooks deletemsg` | `deletemsg` | Supprimer un message envoyé par un webhook | `webhook`* (string), `message_id`* (string), `thread` (string) | ManageWebhooks |
| `/webhooks info` | `info` | Détails d'un webhook | `webhook`* (string), `reveal` (boolean) | ManageWebhooks |
| `/webhooks test` | `test` | Envoyer un message de test via un webhook | `webhook`* (string), `thread` (string) | ManageWebhooks |
| `/webhooks guard status` | `guard_status` | État de la protection des webhooks | — | ManageWebhooks |
| `/webhooks guard set` | `guard_set` | Activer/configurer la protection | `enabled`* (boolean), `action` (choice) | ManageGuild, ManageWebhooks |
| `/webhooks guard allow` | `guard_allow` | Autoriser un rôle/membre à créer des webhooks | `target`* (mentionable) | ManageGuild, ManageWebhooks |
| `/webhooks guard disallow` | `guard_disallow` | Retirer une autorisation de création | `target`* (mentionable) | ManageGuild, ManageWebhooks |
| `/webhooks saved add` | `saved_add` | Enregistrer un webhook externe (URL) | `name`* (string), `url`* (string) | ManageWebhooks |
| `/webhooks saved remove` | `saved_remove` | Supprimer un webhook enregistré | `name`* (string) | ManageWebhooks |
| `/webhooks saved list` | `saved_list` | Lister les webhooks enregistrés | — | ManageWebhooks |

**Vues du panel** : Webhooks du serveur, Webhooks externes enregistrés


# Intégrations

## 📡 Flux & alertes <a id="feeds"></a>

`feeds` — Flux RSS/Atom, vidéos YouTube, lives Twitch, jeux gratuits Epic Games et alertes de prix (CheapShark / Steam). 

**Paramètres (13)** : `pollMinutes` (integer, défaut `15`) — Intervalle de vérification des flux (minutes) · `maxItemsPerPoll` (integer, défaut `5`) — Articles publiés max par vérification · `maxFeeds` (integer, défaut `50`) — Nombre maximum de flux · `template` (text, défaut `{role} 📰 Nouvel article sur **{feed}**`) — Message des articles RSS · `youtubeTemplate` (text, défaut `{role} 🎬 **{author}** a publié une nouv`) — Message des vidéos YouTube · `epicTemplate` (text, défaut `{role} 🎁 **{title}** est gratuit sur l'`) — Message des jeux gratuits Epic · `twitchClientId` (string) — Twitch Client ID · `twitchClientSecret` (string) — Twitch Client Secret · `streamTemplate` (text, défaut `{role} 🔴 **{name}** est en live sur Twi`) — Message de début de live · `streamEndAction` (choice, défaut `edit`) — À la fin du live · `updateLiveEmbed` (boolean, défaut `true`) — Mettre à jour titre/jeu/spectateurs pendant le live · `priceTemplate` (text, défaut `{role} 💸 **{title}** est à **{price} $*`) — Message des alertes de prix · `logChannel` (channel) — Salon des logs

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/feed add` | `feed_add` | Ajouter un flux RSS / Atom | `url`* (string), `channel`* (channel), `role` (role), `template` (text) | ManageGuild |
| `/feed youtube` | `feed_youtube` | Suivre une chaîne YouTube (ID, URL ou @handle) | `youtube_channel`* (string), `channel`* (channel), `role` (role), `template` (text) | ManageGuild |
| `/feed epic` | `feed_epic` | Annoncer les jeux gratuits de l'Epic Games Store | `channel`* (channel), `role` (role) | ManageGuild |
| `/feed list` | `feed_list` | Lister les flux suivis | — | ManageGuild |
| `/feed remove` | `feed_remove` | Supprimer un flux | `id`* (integer) | ManageGuild |
| `/feed test` | `feed_test` | Tester un flux (dernier article) sans le marquer comme lu | `id` (integer), `url` (string), `post` (boolean) | ManageGuild |
| `/feed refresh` | `feed_refresh` | Vérifier un flux maintenant (publie les nouveautés) | `id`* (integer) | ManageGuild |
| `/feed toggle` | `feed_toggle` | Activer / désactiver un flux (réinitialise le compteur d'échecs) | `id`* (integer) | ManageGuild |
| `/feed pricewatch add` | `pricewatch_add` | Alerte quand le prix d'un jeu passe sous un seuil (CheapShark) | `game`* (string), `target_price`* (number), `channel`* (channel), `store` (choice), `role` (role) | ManageGuild |
| `/feed pricewatch list` | `pricewatch_list` | Lister les alertes de prix | — | ManageGuild |
| `/feed pricewatch remove` | `pricewatch_remove` | Supprimer une alerte de prix | `id`* (integer) | ManageGuild |
| `/feed stream add` | `stream_add` | Annoncer les lives d'une chaîne Twitch | `login`* (string), `channel`* (channel), `platform` (choice), `game` (string), `message` (text), `role` (role) | ManageGuild |
| `/feed stream list` | `stream_list` | Lister les chaînes Twitch suivies | — | ManageGuild |
| `/feed stream remove` | `stream_remove` | Ne plus suivre une chaîne Twitch | `id`* (integer) | ManageGuild |
| `/feed stream check` | `stream_check` | Vérifier maintenant l'état des chaînes Twitch suivies | — | ManageGuild |

**Vues du panel** : Flux, Lives Twitch, Alertes de prix


## 🔗 Intégrations <a id="integrations"></a>

`integrations` — ForgeArchive (archives de salons), ForgeHook (relais d'évènements), webhooks entrants/sortants (GitHub, GitLab, Stripe, PayPal, Trello, Jira…), Trello/Jira et /fetch. 

**Paramètres (23)** : `logChannel` (channel) — Salon des logs d'intégration · `forgeArchiveUrl` (string) — URL ForgeArchive (surcharge) · `forgeArchiveKey` (string) — Clé API ForgeArchive (surcharge) · `archivePath` (string, défaut `/api/archives`) — Chemin d'envoi des archives · `listPath` (string, défaut `/api/archives`) — Chemin de liste des archives · `statusPath` (string, défaut `/api/health`) — Chemin de santé (ping) · `forgeArchiveMode` (choice, défaut `multipart`) — Format d'envoi · `autoArchiveTickets` (boolean, défaut `true`) — Archiver automatiquement les tickets fermés · `autoArchiveBackups` (boolean, défaut `true`) — Envoyer automatiquement les sauvegardes · `forgeHookEnabled` (boolean, défaut `true`) — Relayer les évènements vers ForgeHook · `forgeHookUrl` (string) — URL ForgeHook (surcharge) · `forgeHookKey` (string) — Clé API ForgeHook (surcharge) · `forgeHookSecret` (string) — Secret HMAC ForgeHook (surcharge) · `forgeHookPath` (string, défaut `/api/events`) — Chemin de réception ForgeHook · `forgeHookEvents` (list) — Évènements relayés · `trelloKey` (string) — Clé API Trello · `trelloToken` (string) — Jeton Trello · `trelloDefaultList` (string) — ID de liste Trello par défaut · `jiraUrl` (string) — URL Jira · `jiraEmail` (string) — E-mail du compte Jira · `jiraToken` (string) — Jeton API Jira · `jiraDefaultProject` (string) — Clé de projet Jira par défaut · `jiraDefaultType` (string, défaut `Task`) — Type de ticket Jira par défaut

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/integration fetch get` | `fetch` | Récupérer une URL (JSON/XML/texte) et extraire une valeur | `url`* (string), `chemin` (string), `format` (choice) | Tous |
| `/hooks create` | `hooks_create` | Créer un webhook entrant (GitHub, Stripe, générique…) qui publie dans un salon | `nom`* (string), `salon`* (channel), `format` (choice), `secret` (string) | ManageGuild |
| `/hooks list` | `hooks_list` | Lister les webhooks entrants | — | ManageGuild |
| `/hooks delete` | `hooks_delete` | Supprimer un webhook entrant | `id`* (string) | ManageGuild |
| `/hooks toggle` | `hooks_toggle` | Activer / désactiver un webhook entrant | `id`* (string), `actif` (boolean) | ManageGuild |
| `/hooks test` | `hooks_test` | Envoyer un exemple de message du webhook dans son salon | `id`* (string) | ManageGuild |
| `/hooks regenerate` | `hooks_regenerate` | Régénérer le secret (et optionnellement l'URL) d'un webhook entrant | `id`* (string), `secret` (string), `nouvelle_url` (boolean) | ManageGuild |
| `/hooks template` | `hooks_template` | Définir le modèle d'un webhook générique ({payload.a.b}, {headers.x}, {query.y}) | `id`* (string), `modele` (text) | ManageGuild |
| `/hooks deliveries` | `hooks_deliveries` | Dernières livraisons sortantes (ForgeHook et webhooks sortants) | `limite` (integer), `statut` (choice) | ManageGuild |
| `/hooks redeliver` | `hooks_redeliver` | Relivrer une livraison sortante | `id`* (integer) | ManageGuild |
| `/hooks outgoing add` | `outgoing_add` | Ajouter un webhook sortant (évènements du bot → votre URL) | `url`* (string), `evenements`* (list), `secret` (string), `nom` (string) | ManageGuild |
| `/hooks outgoing list` | `outgoing_list` | Lister les webhooks sortants | — | ManageGuild |
| `/hooks outgoing remove` | `outgoing_remove` | Supprimer un webhook sortant | `id`* (integer) | ManageGuild |
| `/hooks outgoing test` | `outgoing_test` | Envoyer un évènement de test à un webhook sortant | `id`* (integer) | ManageGuild |
| `/integration archive channel` | `archive_channel` | Archiver un salon (JSON + HTML) et l'envoyer à ForgeArchive | `salon` (channel), `limite` (integer), `depuis` (date), `format` (choice), `envoyer` (boolean) | ManageGuild |
| `/integration archive list` | `archive_list` | Lister les archives présentes sur ForgeArchive | — | ManageGuild |
| `/integration archive status` | `archive_status` | Tester la connexion à ForgeArchive | — | ManageGuild |
| `/integration trello card` | `trello_card` | Créer une carte Trello | `titre`* (string), `liste_id` (string), `description` (text) | ManageMessages |
| `/integration trello lists` | `trello_lists` | Lister les listes d'un tableau Trello | `board_id`* (string) | ManageMessages |
| `/integration jira issue` | `jira_issue` | Créer un ticket Jira | `titre`* (string), `projet` (string), `type` (string), `description` (text) | ManageMessages |
| `/integration fetch watch` | `watch_add` | Surveiller une valeur d'API et alerter au changement | `url`* (string), `salon`* (channel), `chemin` (string), `intervalle` (duration), `format` (choice), `nom` (string) | ManageGuild |
| `/integration fetch unwatch` | `watch_remove` | Supprimer une surveillance | `id`* (integer) | ManageGuild |
| `/integration fetch list` | `watch_list` | Lister les surveillances d'API | — | ManageGuild |
| `/integration fetch check` | `watch_check` | Vérifier immédiatement une surveillance | `id`* (integer) | ManageGuild |
| `/integration status` | `integration_status` | État de ForgeArchive, ForgeHook et des webhooks | — | ManageGuild |
| `/integration forgehook test` | `forgehook_test` | Envoyer un évènement de test à ForgeHook | — | ManageGuild |
| `/integration emit` | `emit` | Publier un évènement « custom » (relayé à ForgeHook / webhooks sortants) | `nom`* (string), `donnees` (json) | ManageGuild |

**Menus contextuels** : « Créer une carte Trello », « Créer un ticket Jira »

**Vues du panel** : Webhooks entrants, Webhooks sortants, Livraisons, Surveillances d'API, Archives


# Gaming

## 🎮 Gaming <a id="gaming"></a>

`gaming` — Minecraft (RCON, statut, moniteur), FiveM, statistiques de joueurs (Tracker, Riot, Valorant, Steam), recherche de groupe (LFG), mods et bons plans. *(désactivé par défaut)*

**Paramètres (16)** : `mcHost` (string) — Adresse du serveur Minecraft par défaut · `mcPort` (integer, défaut `25565`) — Port de jeu · `mcRconHost` (string) — Hôte RCON (défaut : adresse du serveur) · `mcRconPort` (integer, défaut `25575`) — Port RCON · `mcRconPassword` (string) — Mot de passe RCON · `mcAllowedCommands` (list) — Commandes RCON autorisées · `fivemDefault` (string) — Serveur FiveM par défaut · `trackerApiKey` (string) — Clé Tracker Network (TRN) · `riotApiKey` (string) — Clé API Riot · `henrikKey` (string) — Clé API henrikdev (Valorant) · `steamApiKey` (string) — Clé API Steam · `nexusApiKey` (string) — Clé API Nexus Mods · `curseforgeKey` (string) — Clé API CurseForge · `lfgChannel` (channel) — Salon des annonces LFG · `lfgGames` (json) — Jeux LFG et rôles requis · `lfgDefaultDuration` (string, défaut `2h`) — Durée par défaut d'un groupe

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/mc status` | `mc_status` | Statut d'un serveur Minecraft (Server List Ping) | `serveur` (string) | Tous |
| `/mc players` | `mc_players` | Joueurs connectés sur un serveur Minecraft | `serveur` (string) | Tous |
| `/mc rcon` | `mc_rcon` | Exécuter une commande RCON sur un serveur Minecraft | `commande`* (string), `serveur` (string) | Administrator |
| `/mc say` | `mc_say` | Envoyer un message dans le chat du serveur Minecraft | `message`* (string), `serveur` (string) | Administrator |
| `/mc whitelist add` | `mc_whitelist_add` | Ajouter un joueur à la liste blanche | `pseudo`* (string), `serveur` (string) | Administrator |
| `/mc whitelist remove` | `mc_whitelist_remove` | Retirer un joueur de la liste blanche | `pseudo`* (string), `serveur` (string) | Administrator |
| `/mc whitelist list` | `mc_whitelist_list` | Afficher la liste blanche | `serveur` (string) | Administrator |
| `/mc add` | `mc_add` | Enregistrer un serveur Minecraft | `nom`* (string), `adresse`* (string), `rcon_port` (integer), `rcon_password` (string) | ManageGuild |
| `/mc remove` | `mc_remove` | Supprimer un serveur Minecraft enregistré | `nom`* (string) | ManageGuild |
| `/mc list` | `mc_list` | Lister les serveurs Minecraft enregistrés | — | Tous |
| `/mc monitor` | `mc_monitor` | Afficher un statut Minecraft mis à jour toutes les 2 minutes | `salon`* (channel), `serveur`* (string) | ManageGuild |
| `/mc unmonitor` | `mc_unmonitor` | Supprimer un moniteur Minecraft | `id`* (integer) | ManageGuild |
| `/gaming fivem status` | `fivem_status` | Statut d'un serveur FiveM | `serveur` (string) | Tous |
| `/gaming fivem players` | `fivem_players` | Joueurs connectés sur un serveur FiveM | `serveur` (string) | Tous |
| `/gaming fivem monitor` | `fivem_monitor` | Afficher un statut FiveM mis à jour toutes les 2 minutes | `salon`* (channel), `serveur` (string) | ManageGuild |
| `/gaming fivem unmonitor` | `fivem_unmonitor` | Supprimer un moniteur FiveM | `id`* (integer) | ManageGuild |
| `/gaming stats` | `stats` | Statistiques d'un joueur (Tracker Network : Apex, CS:GO, Division 2, Splitgate) | `jeu`* (choice), `plateforme`* (choice), `pseudo`* (string) | Tous |
| `/gaming lol` | `lol` | Profil et rangs League of Legends | `region`* (choice), `riot_id`* (string) | Tous |
| `/gaming valorant` | `valorant` | Profil et rang Valorant (API henrikdev) | `riot_id`* (string) | Tous |
| `/gaming cod` | `cod` | Statistiques Call of Duty (information) | `pseudo` (string) | Tous |
| `/gaming steam` | `steam` | Profil Steam (et jeux les plus joués avec une clé API) | `profil`* (string) | Tous |
| `/gaming mods modrinth` | `mods_modrinth` | Rechercher des mods sur Modrinth | `recherche`* (string), `loader` (choice), `version` (string), `type` (choice) | Tous |
| `/gaming mods nexus` | `mods_nexus` | Rechercher des mods sur Nexus Mods (parmi les tendances et nouveautés) | `jeu`* (string), `recherche` (string) | Tous |
| `/gaming mods curseforge` | `mods_curseforge` | Rechercher des mods sur CurseForge | `jeu`* (string), `recherche`* (string) | Tous |
| `/gaming deals` | `deals` | Meilleurs prix d'un jeu PC (CheapShark) | `jeu`* (string) | Tous |
| `/gaming epicfree` | `epicfree` | Jeux gratuits actuels et à venir sur l'Epic Games Store | — | Tous |
| `/gaming steamprice` | `steamprice` | Prix d'un jeu sur le Steam Store (France) | `jeu`* (string) | Tous |
| `/gaming monitors` | `monitors` | Lister les moniteurs de serveurs de jeu | — | ManageGuild |
| `/gaming lfg create` | `lfg_create` | Créer une recherche de groupe (LFG) | `jeu`* (string), `places`* (integer), `description` (string), `role` (role), `duree` (duration), `salon` (channel) | Tous |
| `/gaming lfg join` | `lfg_join` | Rejoindre un groupe LFG | `id`* (integer) | Tous |
| `/gaming lfg leave` | `lfg_leave` | Quitter un groupe LFG | `id`* (integer) | Tous |
| `/gaming lfg list` | `lfg_list` | Groupes LFG ouverts | `jeu` (string) | Tous |
| `/gaming lfg close` | `lfg_close` | Fermer un groupe LFG (organisateur ou modérateur) | `id`* (integer) | Tous |
| `/gaming lfg kick` | `lfg_kick` | Retirer un membre d'un groupe LFG | `id`* (integer), `membre`* (user) | Tous |

**Vues du panel** : Serveurs Minecraft, Moniteurs, Groupes LFG


# Modération

## 📜 Journalisation <a id="logs"></a>

`logs` — Journal complet du serveur : messages, membres, sanctions, salons, rôles, vocal, invitations, emojis, fils, webhooks… 

**Paramètres (7)** : `defaultChannel` (channel) — Salon de logs par défaut · `channels` (json) — Salons par évènement · `enabledEvents` (list) — Évènements activés · `ignoredChannels` (list) — Salons ignorés · `ignoredUsers` (list) — Utilisateurs ignorés · `ignoreBots` (boolean, défaut `true`) — Ignorer les bots · `fetchExecutor` (boolean, défaut `true`) — Rechercher l'auteur dans le journal d'audit

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/logs set` | `logs_set` | Définir le salon de logs d'un évènement, d'une catégorie ou de tout (all) | `event`* (string), `channel` (channel) | ManageGuild |
| `/logs enable` | `logs_enable` | Activer un évènement, une catégorie ou tous les évènements (all) | `event`* (string) | ManageGuild |
| `/logs disable` | `logs_disable` | Désactiver un évènement, une catégorie ou tous les évènements (all) | `event`* (string) | ManageGuild |
| `/logs list` | `logs_list` | État de chaque évènement journalisé (activé, salon, compteur) | — | ManageGuild |
| `/logs setall` | `logs_setall` | Envoyer tous les évènements dans un même salon (réinitialise les affectations) | `channel`* (channel), `enable_all` (boolean) | ManageGuild |
| `/logs test` | `logs_test` | Envoyer un log de test (pour un évènement ou dans chaque salon configuré) | `event` (string) | ManageGuild |
| `/logs ignore` | `logs_ignore` | Ajouter / retirer un salon ou un utilisateur des exclusions | `mode`* (choice), `channel` (channel), `user` (user) | ManageGuild |
| `/logs resetstats` | `logs_resetstats` | Remettre à zéro les compteurs de logs | — | ManageGuild |

**Vues du panel** : Évènements journalisés


## 🛡️ Modération <a id="moderation"></a>

`moderation` — Ban, kick, timeout, avertissements, purge, verrouillage, cas de modération avec historique. 

**Paramètres (8)** : `logChannel` (channel) — Salon des logs de modération · `dmOnAction` (boolean, défaut `true`) — Prévenir le membre par MP · `dmTemplate` (text, défaut `Vous avez reçu une sanction sur **{serve`) — Modèle du MP · `warnThresholds` (json) — Seuils d'avertissements · `defaultReason` (string, défaut `Aucune raison fournie`) — Raison par défaut · `deleteMessageDays` (integer, défaut `0`) — Jours de messages supprimés lors d'un ban · `requireReason` (boolean, défaut `false`) — Raison obligatoire · `muteRole` (role) — Rôle mute (optionnel)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/ban` | `ban` | Bannir un membre (durée optionnelle) | `user`* (user), `reason` (string), `duration` (duration), `delete_days` (integer) | BanMembers |
| `/unban` | `unban` | Débannir un utilisateur | `user`* (user), `reason` (string) | BanMembers |
| `/mod softban` | `softban` | Softban : ban puis unban pour purger les messages | `user`* (user), `reason` (string), `delete_days` (integer) | BanMembers |
| `/kick` | `kick` | Expulser un membre | `user`* (user), `reason` (string) | KickMembers |
| `/timeout` | `timeout` | Mettre un membre en timeout (mute) | `user`* (user), `duration`* (duration), `reason` (string) | ModerateMembers |
| `/mod mute` | `mute` | Alias de timeout | `user`* (user), `duration` (duration), `reason` (string) | ModerateMembers |
| `/mod untimeout` | `untimeout` | Retirer le timeout d'un membre | `user`* (user), `reason` (string) | ModerateMembers |
| `/mod unmute` | `unmute` | Alias de untimeout | `user`* (user), `reason` (string) | ModerateMembers |
| `/warn add` | `warn_add` | Avertir un membre | `user`* (user), `reason`* (string) | ModerateMembers |
| `/warn list` | `warn_list` | Voir les avertissements d'un membre | `user`* (user) | ModerateMembers |
| `/warn remove` | `warn_remove` | Retirer un avertissement (par numéro de cas) | `case_number`* (integer), `reason` (string) | ModerateMembers |
| `/warn clear` | `warn_clear` | Effacer tous les avertissements d'un membre | `user`* (user) | ManageGuild |
| `/mod note` | `note` | Ajouter une note interne sur un membre | `user`* (user), `note`* (string) | ModerateMembers |
| `/case view` | `case_view` | Voir un cas de modération | `case_number`* (integer) | ModerateMembers |
| `/case list` | `case_list` | Lister les cas de modération (optionnellement d'un membre) | `user` (user), `type` (choice), `limit` (integer) | ModerateMembers |
| `/case reason` | `case_reason` | Modifier la raison d'un cas | `case_number`* (integer), `reason`* (string) | ModerateMembers |
| `/case delete` | `case_delete` | Supprimer un cas | `case_number`* (integer) | ManageGuild |
| `/purge` | `purge` | Supprimer des messages en masse | `count`* (integer), `user` (user), `contains` (string), `bots` (boolean), `attachments` (boolean), `channel` (channel) | ManageMessages |
| `/mod lock` | `lock` | Verrouiller un salon (empêche @everyone d'écrire) | `channel` (channel), `reason` (string) | ManageChannels |
| `/mod unlock` | `unlock` | Déverrouiller un salon | `channel` (channel), `reason` (string) | ManageChannels |
| `/mod lockdown` | `lockdown` | Verrouiller / déverrouiller TOUS les salons textuels | `enable`* (boolean), `reason` (string) | Administrator |
| `/mod slowmode` | `slowmode` | Définir le mode lent d'un salon | `seconds`* (integer), `channel` (channel) | ManageChannels |
| `/mod nick` | `nick` | Changer le pseudo d'un membre | `user`* (user), `nickname` (string) | ManageNicknames |
| `/role add` | `role_add` | Ajouter un rôle à un membre | `user`* (user), `role`* (role), `reason` (string) | ManageRoles |
| `/role remove` | `role_remove` | Retirer un rôle à un membre | `user`* (user), `role`* (role), `reason` (string) | ManageRoles |
| `/role all` | `role_all` | Ajouter ou retirer un rôle à tous les membres (ou tous les humains/bots) | `role`* (role), `mode`* (choice), `target` (choice) | Administrator |
| `/mod massban` | `massban` | Bannir plusieurs utilisateurs par ID | `users`* (list), `reason` (string) | Administrator |
| `/mod banlist` | `banlist` | Lister les utilisateurs bannis | `search` (string) | BanMembers |
| `/mod stats` | `modstats` | Statistiques de modération | `moderator` (user) | ModerateMembers |

**Vues du panel** : Cas de modération, Bannis


## 🧰 Outils de modération <a id="modtools"></a>

`modtools` — Signalements, modmail, appels de ban, watchlist, strikes, dehoist, filtre de pseudos, synchronisation des bans, actions de masse, classement du staff et verrouillage planifié. 

**Paramètres (36)** : `logChannel` (channel) — Salon de logs modtools · `staffRoles` (list) — Rôles staff supplémentaires · `reportChannel` (channel) — Salon des signalements · `reportPingRole` (role) — Rôle mentionné à chaque signalement · `reportCooldown` (integer, défaut `60`) — Délai entre deux signalements (secondes) · `reportDailyLimit` (integer, défaut `10`) — Signalements max par membre et par 24 h (0 = illimité) · `reportNotifyReporter` (boolean, défaut `true`) — Prévenir le rapporteur en MP lors du traitement · `reportBlockedUsers` (list) — Utilisateurs interdits de signalement · `modmailEnabled` (boolean, défaut `false`) — Activer le modmail · `modmailChannel` (channel) — Salon des fils de modmail · `modmailCategory` (channel) — Catégorie des salons de modmail · `modmailRelayMode` (choice, défaut `all`) — Messages du staff relayés · `modmailReplyPrefix` (string, défaut `=`) — Préfixe de réponse (en plus de !r) · `modmailNotePrefix` (string, défaut `//`) — Préfixe des notes internes (mode « Tous ») · `modmailAnonymous` (boolean, défaut `false`) — Réponses anonymes (« Staff de … ») · `modmailPingRole` (role) — Rôle mentionné à l'ouverture · `modmailGreeting` (text, défaut `Merci pour votre message ! L'équipe de *`) — Message d'accueil (MP) · `modmailCloseMessage` (text, défaut `Votre conversation avec le staff de **{s`) — Message de fermeture (MP) · `modmailTranscriptChannel` (channel) — Salon des transcripts · `modmailDeleteOnClose` (boolean, défaut `true`) — Supprimer le salon à la fermeture (mode catégorie) · `appealsEnabled` (boolean, défaut `true`) — Accepter les appels de ban en ligne · `appealChannel` (channel) — Salon des appels de ban · `appealIntro` (text, défaut `Expliquez honnêtement pourquoi votre ban`) — Texte d'introduction du formulaire · `appealCooldownDays` (integer, défaut `7`) — Délai avant un nouvel appel après un refus (jours) · `watchChannel` (channel) — Salon de la watchlist · `strikeThresholds` (json) — Seuils de points · `strikeDefaultExpiry` (duration, défaut `30d`) — Expiration par défaut des strikes · `strikeDm` (boolean, défaut `true`) — Prévenir le membre en MP · `dehoist` (boolean, défaut `false`) — Dehoist automatique · `dehoistPrefix` (string, défaut ``) — Préfixe ajouté au pseudo corrigé · `dehoistFallback` (string, défaut `Pseudo modéré`) — Pseudo de repli (si rien ne reste) · `nameBlacklist` (list) — Mots interdits dans les pseudos · `nameReplacement` (string, défaut `Pseudo modéré`) — Pseudo de remplacement (filtre) · `banSyncEnabled` (boolean, défaut `true`) — Synchroniser les bans avec les partenaires · `banSyncUnbans` (boolean, défaut `true`) — Synchroniser aussi les débannissements · `lockdownTimezone` (string, défaut `Europe/Paris`) — Fuseau horaire du verrouillage planifié

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/report user` | `report_user` | Signaler un utilisateur au staff | `user`* (user), `reason`* (string) | Tous |
| `/report message` | `report_message` | Signaler un message au staff | `message_id`* (string), `reason`* (string), `channel` (channel) | Tous |
| `/modtools reports list` | `reports_list` | Lister les signalements | `status` (choice), `user` (user), `limit` (integer) | ModerateMembers |
| `/modtools reports resolve` | `reports_resolve` | Résoudre ou rejeter un signalement | `id`* (integer), `status` (choice), `note` (string) | ModerateMembers |
| `/modtools reports stats` | `reports_stats` | Statistiques des signalements | `period` (duration) | ModerateMembers |
| `/modtools modmail open` | `modmail_open` | Ouvrir une conversation modmail avec un membre | `user`* (user), `message` (text) | ModerateMembers |
| `/modtools modmail close` | `modmail_close` | Fermer une conversation modmail | `user` (user), `reason` (string) | ModerateMembers |
| `/modtools modmail reply` | `modmail_reply` | Répondre à une conversation modmail | `message`* (text), `user` (user) | ModerateMembers |
| `/modtools modmail block` | `modmail_block` | Bloquer un utilisateur du modmail | `user`* (user), `reason` (string) | ModerateMembers |
| `/modtools modmail unblock` | `modmail_unblock` | Débloquer un utilisateur du modmail | `user`* (user) | ModerateMembers |
| `/modtools modmail list` | `modmail_list` | Conversations modmail ouvertes et bloqués | `status` (choice) | ModerateMembers |
| `/modtools appeals list` | `appeals_list` | Lister les appels de ban | `status` (choice) | BanMembers |
| `/modtools appeals accept` | `appeals_accept` | Accepter un appel (débannit) | `id`* (integer), `response` (string) | BanMembers |
| `/modtools appeals deny` | `appeals_deny` | Refuser un appel | `id`* (integer), `response` (string) | BanMembers |
| `/modtools appeals link` | `appeals_link` | Lien du formulaire d'appel à communiquer | — | BanMembers |
| `/modtools watch add` | `watch_add` | Surveiller un utilisateur | `user`* (user), `reason`* (string) | ModerateMembers |
| `/modtools watch remove` | `watch_remove` | Retirer un utilisateur de la surveillance | `user`* (user) | ModerateMembers |
| `/modtools watch list` | `watch_list` | Liste des utilisateurs surveillés | — | ModerateMembers |
| `/modtools dehoist all` | `dehoist_all` | Dehoister tous les membres | `dry_run` (boolean) | ManageNicknames |
| `/modtools dehoist user` | `dehoist_user` | Dehoister un membre | `user`* (user) | ManageNicknames |
| `/modtools namefilter add` | `namefilter_add` | Ajouter un mot interdit dans les pseudos | `term`* (string) | ManageNicknames |
| `/modtools namefilter remove` | `namefilter_remove` | Retirer un mot interdit | `term`* (string) | ManageNicknames |
| `/modtools namefilter list` | `namefilter_list` | Liste des mots interdits dans les pseudos | — | ManageNicknames |
| `/modtools namefilter scan` | `namefilter_scan` | Vérifier tous les pseudos du serveur | `dry_run` (boolean) | ManageNicknames |
| `/modtools strike add` | `strike_add` | Ajouter des points de strike | `user`* (user), `points`* (integer), `reason`* (string), `expires` (duration) | ModerateMembers |
| `/modtools strike remove` | `strike_remove` | Retirer un strike (par numéro) | `id`* (integer), `reason` (string) | ModerateMembers |
| `/modtools strike list` | `strike_list` | Strikes d'un membre | `user`* (user), `all` (boolean) | ModerateMembers |
| `/modtools strike clear` | `strike_clear` | Effacer tous les strikes d'un membre | `user`* (user) | ManageGuild |
| `/modtools bansync add` | `bansync_add` | Ajouter un serveur partenaire de bans | `guild_id`* (string) | Administrator |
| `/modtools bansync remove` | `bansync_remove` | Retirer un serveur partenaire | `guild_id`* (string) | Administrator |
| `/modtools bansync list` | `bansync_list` | Serveurs partenaires de bans | — | BanMembers |
| `/modtools masstimeout` | `masstimeout` | Timeout de plusieurs membres | `users`* (list), `duration`* (duration), `reason` (string) | ModerateMembers |
| `/modtools massunban` | `massunban` | Débannir plusieurs utilisateurs | `users`* (list), `reason` (string) | BanMembers |
| `/modtools tempban-list` | `tempban_list` | Bans temporaires en cours | — | BanMembers |
| `/modtools leaderboard` | `leaderboard` | Classement d'activité des modérateurs | `period` (duration), `include_bot` (boolean) | ModerateMembers |
| `/modtools activity` | `activity` | Activité de modération d'un membre du staff | `user`* (user), `period` (duration) | ModerateMembers |
| `/modtools lockdown schedule` | `lockdown_schedule` | Planifier un verrouillage quotidien | `start`* (string), `end`* (string), `timezone` (string), `apply_now` (boolean) | Administrator |
| `/modtools lockdown unschedule` | `lockdown_unschedule` | Annuler le verrouillage planifié | — | Administrator |
| `/modtools lockdown status` | `lockdown_status` | Voir le verrouillage planifié | — | ManageChannels |

**Menus contextuels** : « Signaler ce message », « Signaler cet utilisateur »

**Vues du panel** : Signalements, Appels de ban, Watchlist, Strikes, Modmail


## ⚖️ Sanctions avancées <a id="sanctions"></a>

`sanctions` — Expiration des avertissements, prison (jail), shadowban et tribunal communautaire en complément du module de modération. 

**Paramètres (14)** : `logChannel` (channel) — Salon des logs · `warnDecayDays` (integer, défaut `0`) — Expiration des avertissements (jours) · `jailRole` (role) — Rôle prison · `jailTextChannel` (channel) — Salon texte de la prison · `jailVoiceChannel` (channel) — Salon vocal de la prison · `jailMessage` (text, défaut `{user.mention}, vous avez été placé en p`) — Message posté dans la prison · `jailDm` (boolean, défaut `true`) — Prévenir le membre par MP · `shadowbanLog` (boolean, défaut `true`) — Journaliser les messages supprimés par shadowban · `tribunalChannel` (channel) — Salon des tribunaux · `tribunalMinVotes` (integer, défaut `5`) — Votes minimum · `tribunalPercent` (integer, défaut `60`) — % de votes « pour » requis · `tribunalVoterRoles` (list) — Rôles autorisés à voter · `tribunalAnonymous` (boolean, défaut `false`) — Masquer le décompte pendant le vote · `tribunalPingRole` (role) — Rôle à mentionner à l'ouverture

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| — | `jail` | Placer un membre en prison (rôle + salons réservés) | `user`* (user), `reason` (string), `duration` (duration) | ModerateMembers |
| `/sanction jail` | `sanction_jail` | Placer un membre en prison (alias de /jail) | `user`* (user), `reason` (string), `duration` (duration) | ModerateMembers |
| `/sanction unjail` | `unjail` | Libérer un membre de la prison (restaure ses rôles) | `user`* (user), `reason` (string) | ModerateMembers |
| `/sanction jaillist` | `jaillist` | Lister les membres en prison | — | ModerateMembers |
| `/sanction jailsetup` | `jail_setup` | Créer / vérifier le rôle et les salons de la prison | — | Administrator |
| `/sanction shadowban add` | `shadowban_add` | Shadowban : supprimer silencieusement tous les messages d'un membre | `user`* (user), `reason` (string) | ManageMessages |
| `/sanction shadowban remove` | `shadowban_remove` | Retirer un shadowban | `user`* (user) | ManageMessages |
| `/sanction shadowban list` | `shadowban_list` | Lister les membres shadowban | — | ManageMessages |
| `/sanction decay` | `decay` | Configurer / lancer l'expiration automatique des avertissements | `days` (integer), `run_now` (boolean) | ManageGuild |
| `/sanction tribunal start` | `tribunal_start` | Ouvrir un tribunal : la communauté vote une sanction | `user`* (user), `reason`* (string), `duration` (duration), `sanction` (choice), `sanction_duration` (duration), `min_votes` (integer), `percent` (integer), `channel` (channel) | ModerateMembers |
| `/sanction tribunal cancel` | `tribunal_cancel` | Annuler un tribunal en cours | `id`* (integer), `reason` (string) | ModerateMembers |
| `/sanction tribunal list` | `tribunal_list` | Lister les tribunaux (en cours ou récents) | `all` (boolean), `limit` (integer) | ModerateMembers |
| `/sanction tribunal info` | `tribunal_info` | Détails d'un tribunal | `id`* (integer) | ModerateMembers |
| `/sanction tribunal end` | `tribunal_end` | Clore un tribunal immédiatement et appliquer le verdict | `id`* (integer) | ModerateMembers |

**Vues du panel** : Prison, Shadowbans, Tribunaux


# Musique & médias

## 🎧 Média <a id="media"></a>

`media` — Paroles, soundboard, synthèse vocale (TTS), sons d'arrivée, playlists personnelles, recherche YouTube, Spotify, GIF, outils image/vidéo/audio. *(désactivé par défaut)*

**Paramètres (14)** : `soundVolume` (integer, défaut `100`) — Volume des sons (%) · `soundMaxSeconds` (integer, défaut `30`) — Durée max. d'un son (secondes) · `maxSounds` (integer, défaut `50`) — Nombre max. de sons · `allowMembersAddSounds` (boolean, défaut `false`) — Les membres peuvent ajouter des sons · `leaveAfter` (integer, défaut `30`) — Quitter le vocal après (secondes d'inactivité) · `joinSoundsEnabled` (boolean, défaut `true`) — Sons d'arrivée activés · `joinSoundInterruptMusic` (boolean, défaut `false`) — Les sons d'arrivée interrompent la musique · `joinSounds` (json) — Sons d'arrivée · `ttsLanguage` (choice, défaut `fr`) — Langue TTS par défaut · `ttsEngine` (choice, défaut `auto`) — Moteur TTS · `ttsMaxLength` (integer, défaut `500`) — Longueur max. du texte TTS · `tenorKey` (string) — Clé API Tenor · `giphyKey` (string) — Clé API Giphy · `maxConvertMb` (integer, défaut `20`) — Taille max. d'entrée pour la conversion (Mo)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/media lyrics` | `lyrics` | Paroles d'une chanson | `titre`* (string), `artiste` (string) | Tous |
| `/media sound add` | `sound_add` | Ajouter un son (mp3/ogg/wav, 5 Mo max) | `nom`* (string), `url` (string), `fichier` (attachment) | Tous |
| `/media sound list` | `sound_list` | Lister les sons du serveur | — | Tous |
| `/media sound remove` | `sound_remove` | Supprimer un son (le vôtre, ou tous avec Gérer le serveur) | `nom`* (string) | Tous |
| `/media sound play` | `sound_play` | Jouer un son dans votre salon vocal | `nom`* (string), `salon` (channel) | Tous |
| `/media sound stop` | `sound_stop` | Arrêter les sons en cours et vider la file | — | Tous |
| `/media sound board` | `sound_board` | Afficher un panneau de boutons (25 sons max) | `page` (integer), `salon` (channel) | Tous |
| `/media joinsound set` | `joinsound_set` | Définir le son joué à votre arrivée en vocal | `nom`* (string), `membre` (user) | Tous |
| `/media joinsound remove` | `joinsound_remove` | Retirer votre son d'arrivée | `membre` (user) | Tous |
| `/media tts` | `tts` | Synthèse vocale : lire un texte en vocal (ou recevoir le mp3) | `texte`* (string), `langue` (choice), `voix` (choice), `fichier` (boolean), `salon` (channel) | Tous |
| `/media playlist create` | `playlist_create` | Créer une playlist personnelle | `nom`* (string), `publique` (boolean) | Tous |
| `/media playlist add` | `playlist_add` | Ajouter un titre (URL ou recherche) à une playlist | `nom`* (string), `element`* (string), `titre` (string) | Tous |
| `/media playlist remove` | `playlist_remove` | Retirer un titre d'une playlist (par position) | `nom`* (string), `position`* (integer) | Tous |
| `/media playlist delete` | `playlist_delete` | Supprimer une playlist | `nom`* (string), `membre` (user) | Tous |
| `/media playlist list` | `playlist_list` | Lister les playlists (les vôtres ou celles d'un membre) | `membre` (user) | Tous |
| `/media playlist show` | `playlist_show` | Afficher le contenu d'une playlist | `nom`* (string), `membre` (user) | Tous |
| `/media playlist play` | `playlist_play` | Jouer une playlist via le module musique | `nom`* (string), `membre` (user), `melanger` (boolean), `salon` (channel) | Tous |
| `/media youtube` | `youtube` | Rechercher des vidéos YouTube (yt-dlp) | `recherche`* (string) | Tous |
| `/media spotify` | `spotify` | Infos d'un lien Spotify (titre, album, playlist…) | `lien`* (string) | Tous |
| `/media imageinfo` | `imageinfo` | Dimensions, format et couleur moyenne d'une image | `url` (string), `fichier` (attachment) | Tous |
| `/media gif search` | `gif_search` | Rechercher un GIF (Tenor ou Giphy) | `recherche`* (string), `aleatoire` (boolean) | Tous |
| `/media avatar-frame` | `avatar_frame` | Avatar dans un cadre décoratif | `membre` (user), `style` (choice), `serveur` (boolean) | Tous |
| `/media video info` | `video_info` | Infos d'une vidéo (durée, vues, auteur) via yt-dlp | `url`* (string) | Tous |
| `/media convert audio` | `convert_audio` | Convertir un fichier audio/vidéo en mp3/ogg/wav… | `format`* (choice), `url` (string), `fichier` (attachment), `debit` (integer) | Tous |

**Vues du panel** : Soundboard, Playlists


## 🎵 Musique <a id="music"></a>

`music` — Lecteur musical (YouTube, SoundCloud, Bandcamp, liens directs), radios, filtres audio, enregistreur vocal et blind test. *(désactivé par défaut)*

**Paramètres (20)** : `djRole` (role) — Rôle DJ · `voteSkip` (boolean, défaut `true`) — Vote pour passer · `announceTracks` (boolean, défaut `true`) — Annoncer chaque titre · `announceChannel` (channel) — Salon des annonces · `defaultVolume` (integer, défaut `80`) — Volume (mémorisé) · `leaveTimeout` (integer, défaut `300`) — Déconnexion après inactivité (s) · `stay247` (boolean, défaut `false`) — Mode 24/7 · `autoplay` (boolean, défaut `false`) — Lecture automatique par défaut · `searchMode` (choice, défaut `select`) — Recherche via /play · `searchSource` (choice, défaut `ytsearch`) — Source de recherche · `maxQueue` (integer, défaut `200`) — Taille max de la file · `maxPlaylist` (integer, défaut `100`) — Titres max importés d'une playlist · `maxTrackMinutes` (integer, défaut `0`) — Durée max d'un titre (min) · `customRadios` (json) — Radios personnalisées · `blindtestRounds` (integer, défaut `10`) — Manches par défaut · `blindtestRoundTime` (integer, défaut `30`) — Durée d'une manche (s) · `blindtestTheme` (string, défaut `tubes français`) — Thème par défaut · `blindtestDeleteGuesses` (boolean, défaut `true`) — Supprimer les bonnes réponses · `recordMaxMinutes` (integer, défaut `60`) — Durée max d'un enregistrement (min) · `recordRetentionDays` (integer, défaut `30`) — Conservation des enregistrements (jours)

| Commande | Action | Description | Paramètres | Permissions |
|---|---|---|---|---|
| `/play` | `play` | Jouer un titre (recherche, URL YouTube/SoundCloud/Bandcamp/directe ou playlist) | `query`* (string), `next` (boolean), `channel` (channel) | Tous |
| `/skip` | `skip` | Passer le titre en cours (vote si vous n'êtes pas DJ) | — | Tous |
| `/stop` | `stop` | Arrêter la lecture et vider la file d'attente | — | Tous |
| `/music pause` | `pause` | Mettre la lecture en pause | — | Tous |
| `/music resume` | `resume` | Reprendre la lecture | — | Tous |
| `/queue` | `queue` | Afficher la file d'attente | `page` (integer) | Tous |
| `/music nowplaying` | `nowplaying` | Afficher le titre en cours avec les contrôles | — | Tous |
| `/music volume` | `volume` | Afficher ou régler le volume (0-200, mémorisé) | `value` (integer) | Tous |
| `/music loop` | `loop` | Mode de boucle : désactivée, piste ou file (sans valeur : suivant) | `mode` (choice) | Tous |
| `/music shuffle` | `shuffle` | Mélanger la file d'attente | — | Tous |
| `/music search` | `search` | Rechercher un titre et choisir parmi les résultats | `query`* (string), `source` (choice), `channel` (channel) | Tous |
| `/music remove` | `remove` | Retirer un titre de la file | `position`* (integer) | Tous |
| `/music move` | `move` | Déplacer un titre dans la file | `from`* (integer), `to`* (integer) | Tous |
| `/music jump` | `jump` | Aller directement à un titre de la file | `position`* (integer) | Tous |
| `/music seek` | `seek` | Se déplacer dans le titre (ex : 1:30, 90, 2m10s) | `position`* (string) | Tous |
| `/music clear` | `clear` | Vider la file d'attente (le titre en cours continue) | — | Tous |
| `/music autoplay` | `autoplay` | Activer / désactiver la lecture automatique de titres similaires | `enabled` (boolean) | Tous |
| `/music history` | `history` | Derniers titres joués | `limit` (integer) | Tous |
| `/music previous` | `previous` | Rejouer le titre précédent | — | Tous |
| `/music join` | `join` | Faire venir le bot dans votre salon vocal | `channel` (channel) | Tous |
| `/music leave` | `leave` | Déconnecter le bot du salon vocal | — | Tous |
| `/music 247` | `stay247` | Activer / désactiver le mode 24/7 | `enabled` (boolean) | ManageGuild |
| `/music save` | `save` | Recevoir le titre en cours (ou d'une position) en message privé | `position` (integer) | Tous |
| `/music radio play` | `radio_play` | Écouter une radio (nom d'une radio intégrée/personnalisée ou URL de flux) | `station`* (string), `channel` (channel) | Tous |
| `/music radio list` | `radio_list` | Liste des radios disponibles | — | Tous |
| `/music filter set` | `filter_set` | Activer / désactiver un filtre audio (appliqué en direct) | `filter`* (choice), `value` (number) | Tous |
| `/music filter list` | `filter_list` | Liste des filtres audio et filtres actifs | — | Tous |
| `/music record start` | `record_start` | Démarrer l'enregistrement du salon vocal (consentement requis) | `duree_max` (duration), `channel` (channel) | ManageGuild |
| `/music record stop` | `record_stop` | Arrêter l'enregistrement et obtenir le fichier MP3 | — | ManageGuild |
| `/music record list` | `record_list` | Lister les enregistrements du serveur | `limit` (integer) | ManageGuild |
| `/music record delete` | `record_delete` | Supprimer un enregistrement | `id`* (integer) | ManageGuild |
| `/music blindtest start` | `blindtest_start` | Lancer un blind test (playlist ou thème) | `source` (string), `manches` (integer), `duree` (integer), `channel` (channel), `text_channel` (channel) | Tous |
| `/music blindtest stop` | `blindtest_stop` | Arrêter le blind test en cours | — | Tous |
| `/music blindtest skip` | `blindtest_skip` | Passer la manche en cours (révèle la réponse) | — | Tous |
| `/music blindtest scores` | `blindtest_scores` | Classement cumulé du blind test sur ce serveur | `limit` (integer) | Tous |

**Vues du panel** : File d'attente, Enregistrements, Historique, Blind test

