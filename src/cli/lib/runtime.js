/**
 * Contexte d'exécution partagé par toutes les commandes (et le REPL) :
 * configuration effective, client API, catalogue des modules, résolution du serveur,
 * exécution générique d'une action et rendu de son résultat.
 */
import readline from 'node:readline';
import { CommanderError } from 'commander';
import { ApiClient } from './api.js';
import { resolveConfig } from './config.js';
import { CliError, EXIT, usageError } from './errors.js';
import {
  c, print, printJson, info, warn, errorLine, renderEmbed, renderData, discordToText, outputState, setOutputOptions,
} from './output.js';
import { resolveAction, splitAssignments, assignPositionals, coerceBySchema, isAssignment, suggest, orderedParams, normKey } from './params.js';

const ACTION_TIMEOUT = 120000;

export function createRuntime(program) {
  let catalogCache = null; // { key, value }

  const rt = {
    program,
    rl: null, // interface readline du mode interactif
    abort: null, // AbortController de l'opération longue en cours (logs --follow)
    inShell: false,
    baseOpts: {}, // options globales passées au lancement du REPL

    /** Options globales effectives (REPL : options de lancement + options de la ligne). */
    get opts() {
      const current = Object.fromEntries(Object.entries(program.opts()).filter(([, v]) => v !== undefined));
      return { ...rt.baseOpts, ...current };
    },

    /** Applique --json / --quiet / --no-color. */
    applyOutputOptions() {
      const o = rt.opts;
      setOutputOptions({ json: o.json, quiet: o.quiet, color: o.color });
    },

    get json() { return outputState.json; },
    get quiet() { return outputState.quiet; },

    config() { return resolveConfig(rt.opts); },

    api(extra = {}) {
      const conf = rt.config();
      return new ApiClient({ url: conf.url, token: conf.token, ...extra });
    },

    /** Catalogue (GET /api/modules) mis en cache pour la durée du processus / de la session REPL. */
    async catalog({ refresh = false } = {}) {
      const conf = rt.config();
      const key = `${conf.url}|${conf.token}`;
      if (!refresh && catalogCache?.key === key) return catalogCache.value;
      const res = await rt.api().get('/modules');
      const modules = res.modules || [];
      const value = { modules, actions: modules.flatMap((m) => m.actions || []) };
      catalogCache = { key, value };
      return value;
    },
    cachedCatalog() { return catalogCache?.value || null; },

    /** Trouve un module du catalogue par nom (ou libellé), avec suggestions en cas d'échec. */
    async findModule(name) {
      const cat = await rt.catalog();
      const n = String(name).toLowerCase();
      const mod = cat.modules.find((m) => m.name === n) || cat.modules.find((m) => m.name === n.replace(/-/g, '_')) || cat.modules.find((m) => String(m.label).toLowerCase() === n);
      if (!mod) {
        const s = suggest(n, cat.modules.map((m) => m.name));
        throw new CliError(`Module inconnu : ${name}`, { exitCode: EXIT.NOT_FOUND, hint: [s.length ? `Vouliez-vous dire : ${s.join(', ')} ?` : null, 'Liste des modules : heiphais modules'].filter(Boolean) });
      }
      return mod;
    },

    /**
     * Résout l'ID du serveur : argument explicite > --guild > HEIPHAIS_GUILD > defaultGuild,
     * sinon sélection automatique s'il n'y a qu'un serveur accessible. Accepte aussi un nom de serveur.
     */
    async guild(explicit, { optional = false, nonGuildAction = false } = {}) {
      const conf = rt.config();
      const wanted = explicit ? String(explicit).trim() : conf.guild;
      if (wanted && /^\d+$/.test(wanted)) return wanted;
      if (!wanted && optional) return null;
      const { guilds = [] } = await rt.api().get('/guilds');
      if (wanted) {
        const low = wanted.toLowerCase();
        const exact = guilds.filter((g) => g.name.toLowerCase() === low);
        const partial = exact.length ? exact : guilds.filter((g) => g.name.toLowerCase().includes(low));
        if (partial.length === 1) return partial[0].id;
        if (partial.length > 1) throw usageError(`Nom de serveur ambigu : « ${wanted} »`, partial.map((g) => `${g.id}  ${g.name}`));
        throw new CliError(`Serveur introuvable : « ${wanted} »`, { exitCode: EXIT.NOT_FOUND, hint: guilds.length ? guilds.map((g) => `${g.id}  ${g.name}`) : 'Aucun serveur accessible avec ce jeton.' });
      }
      if (guilds.length === 1) {
        info(c.gray(`Serveur : ${guilds[0].name} (${guilds[0].id})`));
        return guilds[0].id;
      }
      if (!guilds.length) {
        throw new CliError(nonGuildAction
          ? 'Cette action ne dépend pas d\'un serveur, mais l\'API REST n\'expose que POST /api/guilds/:id/actions/… et aucun serveur n\'est accessible.'
          : 'Aucun serveur accessible avec ce jeton.', { exitCode: EXIT.NOT_FOUND, hint: 'Le bot est-il connecté à Discord et présent sur un serveur ? (heiphais status)' });
      }
      throw usageError(nonGuildAction
        ? 'Cette action ne dépend pas d\'un serveur, mais l\'API REST n\'expose que POST /api/guilds/:id/actions/… : précisez --guild <id>.'
        : 'Plusieurs serveurs accessibles : précisez --guild <id|nom>.', [
        ...guilds.slice(0, 15).map((g) => `${g.id}  ${g.name}`),
        'Serveur par défaut : heiphais config set-guild <id>',
      ]);
    },

    /** Question oui/non (stderr) ; --yes répond oui ; entrée non interactive → erreur explicite. */
    async confirm(question) {
      if (rt.opts.yes) return true;
      if (!process.stdin.isTTY) throw usageError('Confirmation requise mais l\'entrée n\'est pas interactive.', 'Relancez avec --yes.');
      const answer = await rt.ask(`${c.yellow('?')} ${question} ${c.gray('[o/N]')} `);
      const ok = /^(o|oui|y|yes)$/i.test(String(answer || '').trim());
      if (!ok) info(c.gray('Annulé.'));
      return ok;
    },

    /** Lit une ligne sur le terminal (réutilise le readline du REPL si actif). */
    ask(question) {
      if (rt.rl) return new Promise((resolve) => rt.rl.question(question, resolve));
      return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
        let done = false;
        rl.question(question, (ans) => { done = true; rl.close(); resolve(ans); });
        rl.on('close', () => { if (!done) resolve(''); });
      });
    },

    /** Affiche une réponse : JSON brut avec --json, sinon rendu humain. */
    output(res, human) {
      if (rt.json) return printJson(res);
      return human(res);
    },

    /** Rendu du résultat d'une action ({ ok, message, data, embed(s) }). */
    renderResult(res) {
      if (rt.json) { printJson(res); return; }
      const embeds = [res.embed, ...(res.embeds || [])].filter(Boolean);
      if (res.ok === false) {
        errorLine(discordToText(res.message || 'L\'action a échoué'));
        process.exitCode = EXIT.ERROR;
      } else if (!rt.quiet && res.message) {
        print(`${c.green('✔')} ${discordToText(res.message)}`);
      }
      if (!rt.quiet) for (const e of embeds) { print(renderEmbed(e)); }
      const hasData = res.data !== null && res.data !== undefined && !(typeof res.data === 'object' && !Array.isArray(res.data) && !Object.keys(res.data).length);
      if (hasData && (rt.quiet || !embeds.length)) print(renderData(res.data));
      else if (hasData && embeds.length) info(c.gray('(données structurées disponibles avec --json)'));
      if (!hasData && !embeds.length && !res.message && !rt.quiet && res.ok !== false) print(`${c.green('✔')} Action exécutée.`);
    },

    /**
     * Exécute une action : résout le module/l'action, fusionne les paramètres, vérifie les requis,
     * puis POST /api/guilds/:g/actions/:module/:action.
     * @param {object} o
     * @param {string} o.module nom du module
     * @param {string[]} [o.tokens] mots de l'action suivis de valeurs positionnelles / k=v
     * @param {object} [o.params] paramètres explicites (prioritaires)
     * @param {object} [o.fileParams] paramètres d'un fichier JSON (moins prioritaires)
     * @param {string} [o.action] nom exact de l'action (sinon déduit des tokens)
     * @param {string} [o.defaultAction] action utilisée si les tokens ne désignent pas d'action
     */
    async runAction({ module: moduleName, action: actionName = null, tokens = [], params = {}, fileParams = {}, guild = null, channel = null, dryRun = false, defaultAction = null, slashGroup = null }) {
      const cat = await rt.catalog();
      const mod = await rt.findModule(moduleName);
      let resolved = null;
      if (actionName) {
        const a = cat.actions.find((x) => x.module === mod.name && x.name === actionName);
        resolved = a ? { action: a, consumed: 0 } : null;
        if (!resolved) {
          throw new CliError(`Action inconnue : ${mod.name}.${actionName}`, {
            exitCode: EXIT.NOT_FOUND,
            hint: [`Le module ${mod.name} ne fournit pas cette action (module pas encore installé sur ce bot ?).`, `Actions disponibles : heiphais actions ${mod.name}`],
          });
        }
      } else {
        if (slashGroup) {
          // « heiphais docker ps » → chemin slash « /docker ps » ou action docker_ps.
          const r = resolveAction(cat.actions, mod.name, [slashGroup, ...tokens]);
          if (r && r.consumed >= 2) resolved = { action: r.action, consumed: r.consumed - 1 };
        }
        resolved ||= resolveAction(cat.actions, mod.name, tokens);
        if (!resolved && defaultAction) {
          const a = cat.actions.find((x) => x.module === mod.name && x.name === defaultAction);
          if (a) resolved = { action: a, consumed: 0 };
        }
      }
      if (!resolved) {
        const first = tokens.find((t) => !isAssignment(t));
        const names = mod.actions.map((a) => a.name);
        const s = first ? suggest(first, names) : [];
        throw new CliError(first ? `Action inconnue : ${mod.name}.${first}` : `Précisez une action du module ${mod.name}.`, {
          exitCode: first ? EXIT.NOT_FOUND : EXIT.USAGE,
          hint: [s.length ? `Vouliez-vous dire : ${s.join(', ')} ?` : null, `Actions : ${names.join(', ') || '(aucune)'}`, `Détails : heiphais actions ${mod.name}`].filter(Boolean),
        });
      }
      const def = resolved.action;
      const rest = tokens.slice(resolved.consumed);
      const split = splitAssignments(rest);
      const merged = { ...fileParams, ...split.params };
      for (const [k, v] of Object.entries(params)) if (v !== undefined) merged[normKey(k)] = v;
      assignPositionals(def, merged, split.positional);

      const schema = def.params || {};
      for (const [k, v] of Object.entries(merged)) {
        if (!schema[k]) warn(`Paramètre inconnu pour ${def.module}.${def.name} : ${k} (envoyé tel quel)`);
        merged[k] = coerceBySchema(schema[k], v);
      }
      const missing = orderedParams(def).filter(([k, d]) => d.required && (merged[k] === undefined || merged[k] === null || merged[k] === '') && d.default === undefined);
      if (missing.length) {
        throw usageError(`Paramètre(s) requis manquant(s) pour ${def.module}.${def.name} : ${missing.map(([k, d]) => `${k} (${d.type})`).join(', ')}`,
          `Usage : heiphais run ${def.module} ${def.name} ${orderedParams(def).map(([k, d]) => (d.required ? `${k}=<${d.type}>` : `[${k}=<${d.type}>]`)).join(' ')}`);
      }
      if (channel && schema.channel && merged.channel === undefined) merged.channel = String(channel);

      // Action sans serveur (guildOnly:false) et aucun serveur explicite/par défaut → POST /api/actions/:module/:action.
      const guildId = def.guildOnly === false ? await rt.guild(guild, { optional: true }) : await rt.guild(guild);
      const body = { params: merged };
      if (channel && guildId) body.channelId = String(channel);
      const actionPath = `/actions/${encodeURIComponent(def.module)}/${encodeURIComponent(def.name)}`;
      const path = guildId ? `/guilds/${guildId}${actionPath}` : actionPath;
      if (dryRun) {
        printJson({ method: 'POST', url: `${rt.config().url}/api${path}`, body });
        return null;
      }
      const res = await rt.api().post(path, body, { timeoutMs: ACTION_TIMEOUT });
      rt.renderResult(res);
      return res;
    },

    /** Affiche une erreur et retourne le code de sortie correspondant. */
    reportError(err) {
      if (err instanceof CommanderError) {
        if (['commander.helpDisplayed', 'commander.help', 'commander.version', 'commander.executeSubCommandAsync'].includes(err.code)) return EXIT.OK;
        return err.exitCode === 1 ? EXIT.USAGE : err.exitCode;
      }
      if (err?.name === 'AbortError') return EXIT.OK;
      if (err instanceof CliError) {
        if (rt.json) printJson({ ok: false, error: err.message, code: err.code || null, status: err.status || null });
        errorLine(err.message);
        const hints = Array.isArray(err.hint) ? err.hint : err.hint ? [err.hint] : [];
        for (const h of hints.filter(Boolean)) process.stderr.write(`  ${c.gray('→')} ${h}\n`);
        return err.exitCode ?? EXIT.ERROR;
      }
      errorLine(`Erreur inattendue : ${err?.message || err}`);
      if (process.env.HEIPHAIS_DEBUG) process.stderr.write(`${err?.stack}\n`);
      else process.stderr.write(`  ${c.gray('→')} Détails : HEIPHAIS_DEBUG=1 heiphais …\n`);
      return EXIT.ERROR;
    },
  };
  return rt;
}
