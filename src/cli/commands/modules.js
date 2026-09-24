/**
 * Commandes : modules, module info|enable|disable, settings get|set|reset, actions, action, run.
 */
import fs from 'node:fs';
import { c, kv, table, print, printJson, heading, success, info, warn, formatValue } from '../lib/output.js';
import { CliError, EXIT, usageError } from '../lib/errors.js';
import { resolveAction, splitAssignments, optionTokensToAssignments, coerceBySchema, paramsSummary, orderedParams, suggest, isAssignment } from '../lib/params.js';

const collect = (value, previous = []) => previous.concat([value]);

export function readParamsFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { throw usageError(`Impossible de lire ${file} : ${err.message}`); }
  let data;
  try { data = JSON.parse(raw); } catch (err) { throw usageError(`${file} n'est pas un JSON valide : ${err.message}`); }
  if (data && typeof data === 'object' && !Array.isArray(data) && data.params && typeof data.params === 'object') data = data.params;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw usageError(`${file} doit contenir un objet JSON { "param": valeur }`);
  return data;
}

/** Transforme les --param k=v en objet. */
export function paramsFromOptions(list = []) {
  const out = {};
  for (const item of list) {
    const { params, positional } = splitAssignments([item]);
    if (positional.length) throw usageError(`--param attend clé=valeur (reçu : ${item})`);
    Object.assign(out, params);
  }
  return out;
}

function describeParamLine([k, d]) {
  const extra = [];
  if (d.choices?.length) extra.push(`choix : ${d.choices.map((ch) => (typeof ch === 'object' ? ch.value : ch)).join(' | ')}`);
  if (d.min !== undefined && d.min !== null) extra.push(`min ${d.min}`);
  if (d.max !== undefined && d.max !== null) extra.push(`max ${d.max}`);
  return { name: k, type: d.type, required: !!d.required, default: d.default ?? null, description: [d.description || d.label || '', extra.join(', ')].filter(Boolean).join(' — ') };
}

function printActionDetails(a) {
  print(heading(`${a.module}.${a.name}`) + (a.hidden ? c.gray(' (masquée)') : ''));
  print(kv([
    ['Description', a.description],
    ['Commande slash', a.slash || c.gray('aucune')],
    ['Permissions', a.permissions === 'owner' ? c.red('propriétaire du bot') : Array.isArray(a.permissions) && a.permissions.length ? a.permissions.join(', ') : c.green('public')],
    ['Serveur requis', a.guildOnly ? 'oui' : 'non (sans --guild : POST /api/actions/…)'],
    ['Catégorie', a.category],
  ]));
  const params = orderedParams(a).map(describeParamLine);
  print(`\n${c.bold('Paramètres')}`);
  print(table(params, [
    { key: 'name', label: 'Nom', format: (v, r) => (r.required ? c.bold(`${v}*`) : v) },
    { key: 'type', label: 'Type' },
    { key: 'default', label: 'Défaut' },
    { key: 'description', label: 'Description' },
  ], { empty: 'Aucun paramètre.' }));
  const usage = orderedParams(a).map(([k, d]) => (d.required ? `${k}=<${d.type}>` : `[${k}=<${d.type}>]`)).join(' ');
  print(`\n${c.bold('Usage')}\n  heiphais run ${a.module} ${a.name} ${usage}`.trimEnd());
  print(`  heiphais ${a.module} ${a.name.replace(/_/g, ' ')} ${usage}`.trimEnd());
}

export function registerModuleCommands(program, rt) {
  // ---- modules ----
  const listModules = async (o = {}) => {
    const cat = await rt.catalog({ refresh: true });
    const gid = await rt.guild(null, { optional: true });
    let states = null;
    if (gid) states = (await rt.api().get(`/guilds/${gid}/modules`)).modules || {};
    let mods = [...cat.modules].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    if (o.category) mods = mods.filter((m) => m.category === String(o.category).toLowerCase());
    if (rt.json) return printJson({ ok: true, guildId: gid, modules: mods.map((m) => ({ ...m, enabled: states ? !!states[m.name]?.enabled : undefined })) });
    const cols = [
      { key: 'name', label: 'Module' },
      { key: 'label', label: 'Libellé' },
      { key: 'category', label: 'Catégorie' },
      { key: 'actions', label: 'Actions', align: 'right', format: (v) => String(v?.length || 0) },
      { key: 'settings', label: 'Réglages', align: 'right', format: (v) => String(Object.keys(v || {}).length) },
      { key: 'core', label: 'Type', format: (v, m) => (v ? c.magenta('cœur') : m.defaultEnabled ? 'défaut : actif' : c.gray('défaut : inactif')) },
    ];
    if (states) cols.push({ key: 'name', label: 'État', get: (m) => m.name, format: (v) => (states[v]?.enabled ? c.green('activé') : c.red('désactivé')) });
    print(table(mods, cols, { empty: 'Aucun module.' }));
    info(c.gray(states ? `\nÉtat pour le serveur ${gid}.` : '\nAstuce : --guild <id> (ou config set-guild) pour voir l\'état sur un serveur.'));
  };
  program.command('modules').description('Catalogue des modules (+ état activé/désactivé si un serveur est défini)').option('--category <cat>', 'Filtrer par catégorie').action(listModules);

  const module = program.command('module').description('Informations et activation d\'un module');
  module.command('list').description('Catalogue des modules (identique à « modules »)').option('--category <cat>', 'Filtrer par catégorie').action(listModules);
  module.command('info <nom>').description('Détails d\'un module : réglages (schéma) et actions').action(async (name) => {
    const mod = await rt.findModule(name);
    if (rt.json) return printJson({ ok: true, module: mod });
    print(heading(`${mod.icon || ''} ${mod.label} (${mod.name})`.trim()));
    print(kv([
      ['Description', mod.description || c.gray('-')],
      ['Catégorie', mod.category],
      ['Type', mod.core ? 'module cœur (non désactivable)' : mod.defaultEnabled ? 'activé par défaut' : 'désactivé par défaut'],
    ]));
    print(`\n${c.bold('Réglages')}`);
    print(table(Object.entries(mod.settings || {}).map(([k, d]) => ({ key: k, ...d })), [
      { key: 'key', label: 'Clé' }, { key: 'type', label: 'Type' }, { key: 'default', label: 'Défaut' },
      { key: 'label', label: 'Libellé', get: (r) => [r.label, r.description].filter(Boolean).join(' — ') },
    ], { empty: 'Aucun réglage.' }));
    print(`\n${c.bold('Actions')}`);
    print(table(mod.actions || [], [
      { key: 'name', label: 'Action' }, { key: 'slash', label: 'Slash' },
      { key: 'params', label: 'Paramètres', get: (a) => paramsSummary(a) },
      { key: 'description', label: 'Description' },
    ], { empty: 'Aucune action.' }));
    info(c.gray(`\nRéglages actuels : heiphais settings get ${mod.name} · Détail d'une action : heiphais action ${mod.name} <action>`));
  });

  const toggle = (enabled) => async (name) => {
    const mod = await rt.findModule(name);
    if (mod.core && !enabled) throw new CliError(`Le module ${mod.name} est un module cœur : il ne peut pas être désactivé.`, { exitCode: EXIT.USAGE });
    const gid = await rt.guild();
    const res = await rt.api().put(`/guilds/${gid}/modules/${encodeURIComponent(mod.name)}`, { enabled });
    rt.output(res, () => success(`Module ${c.bold(mod.name)} ${res.enabled ? c.green('activé') : c.red('désactivé')} sur le serveur ${gid}`));
  };
  module.command('enable <nom>').description('Activer un module sur le serveur').action(toggle(true));
  module.command('disable <nom>').description('Désactiver un module sur le serveur').action(toggle(false));

  // ---- settings ----
  const settings = program.command('settings').description('Réglages d\'un module sur un serveur');
  settings.addHelpText('after', `
Valeurs : JSON automatique selon le schéma (true/false, nombres, [..], {..}) ; « null » vide la valeur ;
les listes acceptent « a,b,c » ou un tableau JSON.
Exemples :
  $ heiphais settings get moderation
  $ heiphais settings set moderation logChannel=123456789012345678 dmOnAction=true
  $ heiphais settings set welcome message "Bienvenue {user.mention} !"`);

  settings.command('get <module> [cle]').description('Afficher les réglages (ou une seule clé)').option('--reveal', 'Afficher les valeurs secrètes').action(async (name, key, o) => {
    const gid = await rt.guild();
    const res = await rt.api().get(`/guilds/${gid}/modules/${encodeURIComponent(name)}/settings`);
    const schema = res.schema || {};
    const values = { ...res.settings };
    if (!o.reveal) for (const [k, d] of Object.entries(schema)) if (d.secret && values[k]) values[k] = '••••••••';
    if (key) {
      if (!(key in values) && !(key in schema)) throw new CliError(`Réglage inconnu : ${name}.${key}`, { exitCode: EXIT.NOT_FOUND, hint: `Clés : ${Object.keys(schema).join(', ')}` });
      return rt.json ? printJson({ ok: true, key, value: values[key] ?? null }) : print(typeof values[key] === 'object' && values[key] !== null ? JSON.stringify(values[key], null, 2) : String(values[key] ?? ''));
    }
    if (rt.json) return printJson({ ok: true, settings: values, schema });
    const keys = [...new Set([...Object.keys(schema), ...Object.keys(values)])];
    print(table(keys.map((k) => ({ key: k, value: values[k], type: schema[k]?.type || '?', label: schema[k]?.label || '', def: schema[k]?.default })), [
      { key: 'key', label: 'Clé' },
      { key: 'value', label: 'Valeur', format: (v, r) => (JSON.stringify(v) === JSON.stringify(r.def) ? c.gray(formatValue(v, r.key)) : formatValue(v, r.key)) },
      { key: 'type', label: 'Type' },
      { key: 'label', label: 'Libellé' },
    ], { empty: 'Ce module n\'a aucun réglage.' }));
    info(c.gray('\nValeurs grisées = valeur par défaut.'));
  });

  settings.command('set <module> <valeurs...>').description('Modifier des réglages : clé=valeur [clé=valeur…] (ou « clé valeur »)').action(async (name, pairs) => {
    const gid = await rt.guild();
    const api = rt.api();
    let assignments = pairs;
    if (pairs.length >= 2 && !isAssignment(pairs[0])) assignments = [`${pairs[0]}=${pairs.slice(1).join(' ')}`];
    const { params, positional } = splitAssignments(assignments);
    if (positional.length) throw usageError(`Format attendu : clé=valeur (reçu : ${positional.join(' ')})`);
    const current = await api.get(`/guilds/${gid}/modules/${encodeURIComponent(name)}/settings`);
    const schema = current.schema || {};
    const patch = {};
    for (const [k, v] of Object.entries(params)) {
      const realKey = Object.keys(schema).find((s) => s.toLowerCase() === k.toLowerCase()) || k;
      if (!schema[realKey]) {
        const s = suggest(k, Object.keys(schema));
        warn(`Réglage inconnu : ${realKey}${s.length ? ` (vouliez-vous dire ${s.join(', ')} ?)` : ''} — envoyé tel quel`);
      }
      patch[realKey] = coerceBySchema(schema[realKey], v);
    }
    const res = await api.put(`/guilds/${gid}/modules/${encodeURIComponent(name)}/settings`, { settings: patch });
    rt.output(res, () => {
      success(`Réglages de ${c.bold(name)} mis à jour sur le serveur ${gid}`);
      print(kv(Object.keys(patch).map((k) => [k, formatValue(res.settings?.[k], k)])));
    });
  });

  settings.command('reset <module>').description('Réinitialiser les réglages d\'un module (valeurs par défaut)').action(async (name) => {
    const gid = await rt.guild();
    if (!(await rt.confirm(`Réinitialiser tous les réglages du module ${name} sur le serveur ${gid} ?`))) return;
    const res = await rt.api().delete(`/guilds/${gid}/modules/${encodeURIComponent(name)}/settings`);
    rt.output(res, () => success(`Réglages de ${c.bold(name)} réinitialisés`));
  });

  // ---- actions ----
  program.command('actions [module]').description('Lister les actions (paramètres, commande slash, permissions)')
    .option('--all', 'Inclure les actions masquées')
    .option('--search <texte>', 'Filtrer par nom ou description')
    .action(async (moduleName, o) => {
      const cat = await rt.catalog();
      let list = cat.actions;
      if (moduleName) {
        const mod = await rt.findModule(moduleName);
        list = list.filter((a) => a.module === mod.name);
      }
      if (!o.all) list = list.filter((a) => !a.hidden);
      if (o.search) {
        const q = String(o.search).toLowerCase();
        list = list.filter((a) => `${a.module}.${a.name} ${a.description} ${a.slash || ''}`.toLowerCase().includes(q));
      }
      rt.output({ ok: true, actions: list }, () => {
        print(table(list, [
          { key: 'name', label: 'Action', get: (a) => (moduleName ? a.name : `${a.module}.${a.name}`) },
          { key: 'slash', label: 'Slash' },
          { key: 'params', label: 'Paramètres (* requis)', get: (a) => paramsSummary(a) },
          { key: 'permissions', label: 'Permissions', format: (v) => (v === 'owner' ? c.red('owner') : Array.isArray(v) && v.length ? v.join(',') : c.green('public')) },
          { key: 'description', label: 'Description' },
        ], { empty: 'Aucune action.' }));
        info(c.gray(`\n${list.length} action(s). Détail : heiphais action <module> <action> · Exécution : heiphais run <module> <action> k=v`));
      });
    });

  program.command('action <module> <action...>').description('Détail d\'une action (paramètres, types, usage)').action(async (moduleName, words) => {
    const mod = await rt.findModule(moduleName);
    const cat = await rt.catalog();
    const found = resolveAction(cat.actions, mod.name, words);
    if (!found) {
      const s = suggest(words.join('_'), mod.actions.map((a) => a.name));
      throw new CliError(`Action inconnue : ${mod.name}.${words.join('_')}`, { exitCode: EXIT.NOT_FOUND, hint: [s.length ? `Vouliez-vous dire : ${s.join(', ')} ?` : null, `heiphais actions ${mod.name}`].filter(Boolean) });
    }
    if (rt.json) return printJson({ ok: true, action: found.action });
    printActionDetails(found.action);
  });

  // ---- run ----
  const run = program.command('run [args...]')
    .description('Exécuter n\'importe quelle action : run [guildId] <module> <action> [clé=valeur…]')
    .option('-p, --param <clé=valeur>', 'Paramètre (répétable)', collect, [])
    .option('-f, --file <params.json>', 'Paramètres depuis un fichier JSON')
    .option('--channel <id>', 'Salon d\'origine (channelId) ; sert aussi de paramètre « channel » si l\'action en a un')
    .option('--dry-run', 'Afficher la requête sans l\'envoyer')
    .allowUnknownOption()
    .action(async (args, o) => {
      const tokens = optionTokensToAssignments(args);
      let guild = null;
      if (tokens.length >= 3 && /^\d{15,}$/.test(tokens[0])) guild = tokens.shift();
      const [moduleName, ...rest] = tokens;
      if (!moduleName) throw usageError('Usage : heiphais run <module> <action> [clé=valeur…]', 'Liste des actions : heiphais actions');
      if (!rest.filter((t) => !isAssignment(t)).length) throw usageError(`Précisez l'action du module ${moduleName}.`, `heiphais actions ${moduleName}`);
      await rt.runAction({
        module: moduleName, tokens: rest, params: paramsFromOptions(o.param), fileParams: o.file ? readParamsFile(o.file) : {}, guild, channel: o.channel, dryRun: o.dryRun,
      });
    });
  run.addHelpText('after', `
Les valeurs sont converties selon le schéma de l'action (JSON automatique : true, 42, [..], {..} ; « null » = vide).
Les valeurs sans « clé= » remplissent les paramètres dans l'ordre (requis d'abord) ; un texte final absorbe le reste.
Les options inconnues --clé valeur sont aussi acceptées comme paramètres.
Le nom d'action accepte warn_add, « warn add » ou le chemin slash (/warn add).
Exemples :
  $ heiphais run admin ping --guild 123456789012345678
  $ heiphais run moderation ban user=123456789012345678 reason="spam" duration=7d
  $ heiphais run moderation warn add 123456789012345678 Langage inapproprié
  $ heiphais run 123456789012345678 moderation purge count=50 --channel 234567890123456789
  $ heiphais run backup create --file params.json`);
}
