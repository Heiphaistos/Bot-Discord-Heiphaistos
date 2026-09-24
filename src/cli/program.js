/**
 * Construction du programme commander de la CLI heiphais (réutilisé par le REPL).
 */
import { Command, Help } from 'commander';
import { cliVersion, configPath } from './lib/config.js';
import { createRuntime } from './lib/runtime.js';
import { CliError, EXIT, usageError } from './lib/errors.js';
import { c, print, table, info, printJson } from './lib/output.js';
import { optionTokensToAssignments, isAssignment, suggest, paramsSummary } from './lib/params.js';
import { buildCompletion } from './lib/completion.js';
import { startShell } from './lib/shell.js';
import { registerConfigCommands } from './commands/config.js';
import { registerInfoCommands } from './commands/info.js';
import { registerModuleCommands, readParamsFile } from './commands/modules.js';
import { registerShortcutCommands, GROUPS } from './commands/shortcuts.js';
import { registerGuildCommands } from './commands/guild.js';
import { registerSystemCommands } from './commands/system.js';

const TITLES = { 'Usage:': 'Utilisation :', 'Options:': 'Options :', 'Commands:': 'Commandes :', 'Arguments:': 'Arguments :', 'Global Options:': 'Options globales :' };

const HELP_GROUPS = [
  ['Configuration et accès :', ['config', 'token', 'tokens', 'completion', 'interactive', 'help']],
  ['Informations :', ['status', 'me', 'guilds', 'guild', 'channels', 'roles', 'members', 'member', 'emojis']],
  ['Modules, réglages et actions :', ['modules', 'module', 'settings', 'actions', 'action', 'run']],
  ['Modération (raccourcis) :', ['ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn', 'warns', 'unwarn', 'purge', 'lock', 'unlock', 'slowmode', 'case', 'cases', 'role']],
  ['Messages :', ['say', 'dm', 'embed', 'announce']],
  ['Serveur :', ['audit', 'jobs', 'job', 'export', 'import', 'prefix']],
  ['Modules (raccourcis génériques → run <module> <action>) :', GROUPS.map((g) => g.name).filter((n) => n !== 'announce')],
  ['Système (jeton admin / propriétaire) :', ['logs', 'system', 'deploy-commands', 'restart', 'presence']],
];

/** Traduit les messages d'erreur standard de commander. */
function translateCommanderMessage(str) {
  return str
    .replace(/^error: missing required argument '(.+?)'/m, 'erreur : argument requis manquant « $1 »')
    .replace(/^error: unknown option '(.+?)'/m, 'erreur : option inconnue « $1 »')
    .replace(/^error: too many arguments(?: for '(.+?)')?\. Expected (\d+) arguments? but got (\d+)\./m, (_, cmd, e, g) => `erreur : trop d'arguments${cmd ? ` pour « ${cmd} »` : ''} (${e} attendu(s), ${g} reçu(s))`)
    .replace(/^error: option '(.+?)' argument missing/m, 'erreur : valeur manquante pour l\'option « $1 »')
    .replace(/^error: required option '(.+?)' not specified/m, 'erreur : option requise manquante « $1 »')
    .replace(/^error: unknown command '(.+?)'/m, 'erreur : commande inconnue « $1 »')
    .replace(/^error: option '(.+?)' argument '(.+?)' is invalid\./m, 'erreur : valeur « $2 » invalide pour l\'option « $1 ».')
    .replace(/\(Did you mean (.+?)\?\)/, '(Vouliez-vous dire $1 ?)')
    .replace(/^error:/m, 'erreur :');
}

export function buildProgram() {
  const program = new Command();
  const rt = createRuntime(program);

  program
    .name('heiphais')
    .description('CLI de HeiphaisBot : pilotez tout le bot depuis le terminal via l\'API REST du panel.')
    .version(cliVersion(), '-V, --version', 'Afficher la version')
    .helpOption('-h, --help', 'Afficher l\'aide')
    .helpCommand('help [commande]', 'Afficher l\'aide d\'une commande')
    .configureHelp({
      sortSubcommands: false,
      styleTitle: (str) => TITLES[str] || str,
      optionDescription(option) {
        return Help.prototype.optionDescription.call(this, option).replace('(default:', '(défaut :').replace('(choices:', '(choix :');
      },
    })
    .configureOutput({ outputError: (str, write) => write(c.red(translateCommanderMessage(str))) })
    .showSuggestionAfterError(true)
    .showHelpAfterError(c.gray('(heiphais --help ou heiphais <commande> --help pour l\'aide)'))
    .exitOverride();

  program.optionsGroup('Options globales :');
  program
    .option('--url <url>', 'URL du panel (sinon HEIPHAIS_API_URL, ~/.heiphais.json, .env du projet)')
    .option('--token <jeton>', 'Jeton API hb_… (sinon HEIPHAIS_API_TOKEN ou ~/.heiphais.json)')
    .option('-g, --guild <id|nom>', 'Serveur cible (sinon HEIPHAIS_GUILD ou « config set-guild »)')
    .option('--json', 'Sortie JSON brute (scripts)')
    .option('-q, --quiet', 'Sortie minimale (pas de messages de confirmation)')
    .option('--no-color', 'Désactiver les couleurs')
    .option('-y, --yes', 'Répondre oui aux confirmations');

  program.hook('preAction', () => rt.applyOutputOptions());

  registerConfigCommands(program, rt);
  registerInfoCommands(program, rt);
  registerModuleCommands(program, rt);
  registerShortcutCommands(program, rt);
  registerGuildCommands(program, rt);
  registerSystemCommands(program, rt);

  program.command('completion <shell>').description('Script de complétion : bash ou zsh').action(async (shell) => {
    const sh = String(shell).toLowerCase();
    if (!['bash', 'zsh'].includes(sh)) throw usageError(`Shell non pris en charge : ${shell}`, 'Valeurs : bash, zsh');
    let catalog = null;
    try { catalog = await rt.catalog(); } catch { /* panel injoignable : modules lus depuis src/modules */ }
    process.stdout.write(buildCompletion(sh, program, catalog));
  });

  program.command('interactive').alias('shell').description('Mode interactif (REPL) : une commande par ligne, « exit » pour quitter').action(() => startShell(program, rt));

  // Catch-all : heiphais <module> <action> [k=v…] ou heiphais <commande-slash> …
  program
    .argument('[args...]', 'heiphais <module> <action> [clé=valeur…] pour toute action de tout module')
    .allowUnknownOption()
    .action(async (args) => {
      if (!args.length) { program.outputHelp(); return; }
      await catchAll(program, rt, args);
    });

  const byName = new Map(program.commands.map((cmd) => [cmd.name(), cmd]));
  for (const [group, names] of HELP_GROUPS) for (const n of names) byName.get(n)?.helpGroup(group);

  program.addHelpText('after', `
${c.bold('Commande universelle :')}
  heiphais <module> <action> [clé=valeur…]   exécute n'importe quelle action (liste : heiphais actions)
  L'action accepte warn_add, « warn add » ou le chemin slash ; ex. heiphais moderation warn add <id> Spam
  Les commandes slash marchent aussi : heiphais docker ps, heiphais xp add user=<id> amount=100

${c.bold('Démarrage rapide (sur le VPS) :')}
  $ heiphais token create cli --local --save     crée un jeton admin directement en base
  $ heiphais status                              vérifie la connexion
  $ heiphais config set-guild <id>               serveur par défaut

${c.bold('Configuration :')} ${configPath()} { url, token, defaultGuild } ou HEIPHAIS_API_URL / HEIPHAIS_API_TOKEN / HEIPHAIS_GUILD.
${c.bold('Codes de sortie :')} 0 succès · 1 erreur · 2 usage · 3 authentification/accès · 4 introuvable · 5 réseau · 6 erreur du bot`);

  return { program, rt };
}

async function catchAll(program, rt, args) {
  // Options propres à l'exécution (comme pour « run ») : --dry-run, --file <params.json>.
  let dryRun = false;
  let fileParams = {};
  const tokens = [];
  for (const t of optionTokensToAssignments(args)) {
    if (/^dry_run=(true|1)$/i.test(t)) dryRun = true;
    else if (/^file=.+\.json$/i.test(t)) fileParams = readParamsFile(t.slice(5));
    else tokens.push(t);
  }
  const [first, ...rest] = tokens;
  const commandNames = program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]);
  if (isAssignment(first)) throw usageError(`Commande attendue avant « ${first} »`, 'heiphais run <module> <action> clé=valeur');
  let cat;
  try {
    cat = await rt.catalog();
  } catch (err) {
    const s = suggest(first, commandNames);
    if (s.length) throw usageError(`Commande inconnue : ${first}`, `Vouliez-vous dire : ${s.join(', ')} ?`);
    if (err instanceof CliError) {
      throw new CliError(`« ${first} » n'est pas une commande de la CLI et le catalogue des modules est indisponible : ${err.message}`, { exitCode: err.exitCode, hint: err.hint, status: err.status, code: err.code });
    }
    throw err;
  }
  const low = first.toLowerCase();
  const mod = cat.modules.find((m) => m.name === low || m.name === low.replace(/-/g, '_'));
  if (mod) {
    if (!rest.length) {
      const list = cat.actions.filter((a) => a.module === mod.name && !a.hidden);
      if (rt.json) return printJson({ ok: true, module: mod.name, actions: list });
      print(table(list, [
        { key: 'name', label: 'Action' },
        { key: 'cli', label: 'Commande', get: (a) => `heiphais ${mod.name} ${a.name}` },
        { key: 'params', label: 'Paramètres (* requis)', get: (a) => paramsSummary(a) },
        { key: 'description', label: 'Description' },
      ], { empty: `Le module ${mod.name} n'expose aucune action.` }));
      info(c.gray(`\nDétail : heiphais action ${mod.name} <action>`));
      return;
    }
    await rt.runAction({ module: mod.name, tokens: rest, dryRun, fileParams });
    return;
  }
  // Nom (ou groupe) de commande slash : /warn add, /docker ps, /play…
  const slashModules = [...new Set(cat.actions.filter((a) => a.slash && a.slash.slice(1).split(' ')[0] === low).map((a) => a.module))];
  if (slashModules.length) {
    await rt.runAction({ module: slashModules[0], tokens, dryRun, fileParams });
    return;
  }
  const s = suggest(first, [...commandNames, ...cat.modules.map((m) => m.name)]);
  throw new CliError(`Commande, module ou commande slash inconnu : ${first}`, {
    exitCode: EXIT.USAGE,
    hint: [s.length ? `Vouliez-vous dire : ${s.join(', ')} ?` : null, 'Aide : heiphais --help · Modules : heiphais modules · Actions : heiphais actions'].filter(Boolean),
  });
}
