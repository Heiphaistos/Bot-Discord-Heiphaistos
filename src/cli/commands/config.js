/**
 * Commandes : config (fichier ~/.heiphais.json) et jetons API (token / tokens), y compris le mode --local.
 */
import { configPath, readConfigFile, updateConfigFile, clearConfigFile, normalizeUrl, maskToken, resolveConfig } from '../lib/config.js';
import { createLocalToken, listLocalTokens, deleteLocalToken } from '../lib/local.js';
import { c, kv, table, print, printJson, success, info, warn, formatDate } from '../lib/output.js';
import { usageError } from '../lib/errors.js';

export function registerConfigCommands(program, rt) {
  const config = program.command('config').description('Configuration de la CLI (~/.heiphais.json : url, token, serveur par défaut)');
  config.addHelpText('after', `
Priorité : options --url/--token/--guild > variables HEIPHAIS_API_URL / HEIPHAIS_API_TOKEN / HEIPHAIS_GUILD
           > ${configPath()} > .env du projet (PANEL_HOST/PANEL_PORT → http://127.0.0.1:PORT).
Chemin du fichier modifiable avec HEIPHAIS_CONFIG.`);

  config.command('show').description('Afficher la configuration effective et la source de chaque valeur').action(() => {
    const conf = rt.config();
    const payload = { ok: true, file: conf.file, url: conf.url, urlSource: conf.urlSource, token: maskToken(conf.token), tokenSource: conf.tokenSource, defaultGuild: conf.guild, guildSource: conf.guildSource };
    rt.output(payload, () => print(kv([
      ['Fichier', conf.file],
      ['URL', `${conf.url} ${c.gray(`(${conf.urlSource})`)}`],
      ['Jeton', conf.token ? `${maskToken(conf.token)} ${c.gray(`(${conf.tokenSource})`)}` : c.yellow('aucun — heiphais config set-token … ou heiphais token create cli --local --save')],
      ['Serveur par défaut', conf.guild ? `${conf.guild} ${c.gray(`(${conf.guildSource})`)}` : c.gray('aucun (heiphais config set-guild <id>)')],
    ])));
  });

  config.command('set-url <url>').description('Définir l\'URL du panel (ex : http://127.0.0.1:3000)').action((url) => {
    const normalized = normalizeUrl(url);
    const file = updateConfigFile({ url: normalized });
    rt.output({ ok: true, url: normalized, file }, () => success(`URL enregistrée : ${normalized} ${c.gray(`(${file})`)}`));
  });

  config.command('set-token <token>').description('Enregistrer le jeton API (hb_…)').action((token) => {
    const t = String(token).trim();
    if (!t.startsWith('hb_')) warn('Ce jeton ne commence pas par « hb_ » : est-ce bien un jeton API HeiphaisBot ?');
    const file = updateConfigFile({ token: t });
    rt.output({ ok: true, token: maskToken(t), file }, () => success(`Jeton enregistré (${maskToken(t)}) ${c.gray(`(${file})`)}`));
  });

  config.command('set-guild <id>').description('Définir le serveur par défaut (ID ; « none » pour l\'effacer)').action((id) => {
    const value = ['none', 'null', '-', ''].includes(String(id).toLowerCase()) ? null : String(id).trim();
    if (value && !/^\d+$/.test(value)) throw usageError('L\'ID de serveur doit être numérique.', 'Liste des serveurs : heiphais guilds');
    const file = updateConfigFile({ defaultGuild: value });
    rt.output({ ok: true, defaultGuild: value, file }, () => success(value ? `Serveur par défaut : ${value}` : 'Serveur par défaut effacé'));
  });

  config.command('clear [cle]').description('Supprimer le fichier de configuration, ou une seule clé (url | token | guild)').action((cle) => {
    if (cle) {
      const key = { url: 'url', token: 'token', guild: 'defaultGuild', defaultguild: 'defaultGuild' }[String(cle).toLowerCase()];
      if (!key) throw usageError(`Clé inconnue : ${cle}`, 'Clés : url, token, guild');
      const file = updateConfigFile({ [key]: null });
      return rt.output({ ok: true, removed: key, file }, () => success(`Clé « ${key} » supprimée de ${file}`));
    }
    const removed = clearConfigFile();
    rt.output({ ok: true, removed, file: configPath() }, () => (removed ? success(`Configuration supprimée (${configPath()})`) : info('Aucun fichier de configuration à supprimer.')));
  });

  // ---- Jetons ----
  const token = program.command('token').description('Jetons API : création (via l\'API ou --local), liste, suppression');
  token.addHelpText('after', `
Bootstrap sur le VPS (sans jeton existant, accès direct à la base SQLite) :
  $ heiphais token create cli --local --save
Via l'API (jeton admin requis) :
  $ heiphais token create moderation --scope guild --guilds 123456789012345678 --days 30`);

  token.command('create <nom>')
    .description('Créer un jeton API')
    .option('--scope <scope>', 'admin (propriétaire, tous les serveurs) ou guild (serveurs listés)', 'admin')
    .option('--guilds <ids>', 'IDs de serveurs séparés par des virgules (portée guild)')
    .option('--days <n>', 'Expiration en jours (défaut : jamais)')
    .option('--user <id>', 'ID Discord associé au jeton (mode --local)')
    .option('--local', 'Écrire directement dans la base SQLite du bot (sans passer par l\'API)')
    .option('--db <chemin>', 'Chemin de la base (mode --local ; défaut : DATABASE_PATH ou data/heiphaisbot.db)')
    .option('--save', 'Enregistrer le jeton dans ~/.heiphais.json')
    .action(async (name, o) => {
      const scope = String(o.scope || 'admin').toLowerCase();
      if (!['admin', 'guild'].includes(scope)) throw usageError(`Portée invalide : ${o.scope}`, 'Valeurs : admin, guild');
      const guildIds = o.guilds ? String(o.guilds).split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (guildIds.some((g) => !/^\d+$/.test(g))) throw usageError('--guilds attend des IDs numériques séparés par des virgules');
      if (scope === 'guild' && !guildIds.length) throw usageError('La portée « guild » nécessite --guilds <id,id>');
      const days = o.days !== undefined ? Number(o.days) : null;
      if (days !== null && (!Number.isFinite(days) || days <= 0)) throw usageError('--days doit être un nombre positif');

      let res;
      if (o.local) {
        res = await createLocalToken({ name, scope, guildIds, userId: o.user || null, expiresInDays: days, dbPath: o.db });
        if (res.createdDb) warn(`Base créée : ${res.dbFile} (le bot n'y a encore jamais écrit — vérifiez DATABASE_PATH)`);
      } else {
        if (o.user) warn('--user n\'est utilisé qu\'en mode --local (via l\'API, le jeton est associé à votre utilisateur).');
        const api = await rt.api().post('/tokens', { name, scope, guildIds, expiresInDays: days || undefined });
        res = { id: api.id, token: api.token, expiresAt: days ? Date.now() + days * 86400000 : null };
      }
      const payload = { ok: true, id: res.id, name, scope, guildIds, token: res.token, expiresAt: res.expiresAt, local: !!o.local, dbFile: res.dbFile };
      if (rt.json) printJson(payload);
      else {
        success(`Jeton « ${name} » créé (id ${res.id}, portée ${scope}${guildIds.length ? ` : ${guildIds.join(', ')}` : ''}, expiration : ${res.expiresAt ? formatDate(res.expiresAt) : 'jamais'})`);
        print(rt.quiet ? res.token : `\n  ${c.bold(res.token)}\n`);
        info(c.yellow('Conservez-le : il ne sera plus jamais affiché (seule son empreinte sha256 est stockée).'));
      }
      let save = !!o.save;
      if (!save && !rt.json && !rt.quiet && process.stdin.isTTY) {
        const ans = await rt.ask(`${c.yellow('?')} Enregistrer ce jeton dans ${configPath()} ? ${c.gray('[o/N]')} `);
        save = /^(o|oui|y|yes)$/i.test(String(ans || '').trim());
      }
      if (save) {
        const patch = { token: res.token };
        const file = readConfigFile();
        if (!file.url) patch.url = resolveConfig(rt.opts).url;
        const path = updateConfigFile(patch);
        if (!rt.json) success(`Jeton enregistré dans ${path}${patch.url ? ` (URL : ${patch.url})` : ''}`);
      } else if (!rt.json) {
        info(c.gray(`Pour l'utiliser : heiphais config set-token ${res.token.slice(0, 7)}…  ou  export HEIPHAIS_API_TOKEN=…`));
      }
    });

  const listTokens = async (o = {}) => {
    const tokens = o.local ? (await listLocalTokens(o.db)).tokens : (await rt.api().get('/tokens')).tokens || [];
    rt.output({ ok: true, tokens }, () => print(table(tokens, [
      { key: 'id', label: 'ID', align: 'right' },
      { key: 'name', label: 'Nom' },
      { key: 'scope', label: 'Portée' },
      { key: 'guild_ids', label: 'Serveurs', format: (v) => (v?.length ? v.join(', ') : c.gray('tous')) },
      { key: 'user_id', label: 'Utilisateur' },
      { key: 'created_at', label: 'Créé le' },
      { key: 'last_used_at', label: 'Dernière utilisation' },
      { key: 'expires_at', label: 'Expire', format: (v) => (!v ? c.gray('jamais') : v < Date.now() ? c.red(`expiré (${formatDate(v)})`) : formatDate(v)) },
    ], { empty: 'Aucun jeton.' })));
  };

  token.command('list').description('Lister les jetons API').option('--local', 'Lire directement la base SQLite').option('--db <chemin>', 'Chemin de la base (mode --local)').action(listTokens);

  token.command('delete <id>').alias('revoke').description('Révoquer un jeton API').option('--local', 'Supprimer directement dans la base SQLite').option('--db <chemin>', 'Chemin de la base (mode --local)')
    .action(async (id, o) => {
      if (!/^\d+$/.test(id)) throw usageError('L\'ID du jeton doit être numérique (voir heiphais token list)');
      if (!(await rt.confirm(`Révoquer le jeton n°${id} ?`))) return;
      const ok = o.local ? await deleteLocalToken(id, o.db) : (await rt.api().delete(`/tokens/${id}`)).ok;
      if (!ok) throw usageError(`Jeton n°${id} introuvable`);
      rt.output({ ok: true, id: Number(id) }, () => success(`Jeton n°${id} révoqué`));
    });

  program.command('tokens').description('Lister les jetons API (raccourci de « token list »)').option('--local', 'Lire directement la base SQLite').option('--db <chemin>', 'Chemin de la base (mode --local)').action(listTokens);
}
