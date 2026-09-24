/**
 * Client HTTP minimal pour l'API REST du panel HeiphaisBot (Authorization: Bearer hb_…).
 */
import { CliError, EXIT } from './errors.js';
import { cliVersion } from './config.js';

const DEFAULT_TIMEOUT = 30000;

const stripMarkdown = (s) => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1');

export class ApiClient {
  constructor({ url, token, timeoutMs = DEFAULT_TIMEOUT }) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {string} method
   * @param {string} pathname chemin sous /api (ex: /status)
   * @param {object} [opts] { body, query, timeoutMs, signal, auth }
   */
  async request(method, pathname, { body, query, timeoutMs, signal, auth = true } = {}) {
    if (auth && !this.token) {
      throw new CliError('Aucun jeton API configuré.', {
        exitCode: EXIT.AUTH,
        hint: [
          'Enregistrez un jeton : heiphais config set-token hb_…',
          'ou créez-en un directement sur le VPS : heiphais token create cli --local --save',
          'ou définissez la variable HEIPHAIS_API_TOKEN / l\'option --token.',
        ],
      });
    }
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString() : '';
    const target = `${this.url}/api${pathname}${qs ? `?${qs}` : ''}`;
    const headers = { accept: 'application/json', 'user-agent': `heiphais-cli/${cliVersion()}` };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    let payload;
    const upper = method.toUpperCase();
    if (body !== undefined || upper === 'POST' || upper === 'PUT' || upper === 'PATCH') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
    }
    const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const finalSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res;
    try {
      res = await fetch(target, { method: upper, headers, body: payload, signal: finalSignal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw networkError(err, this.url, timeoutMs ?? this.timeoutMs);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    if (!res.ok) throw httpError(res.status, data, text, upper, pathname);
    if (data === null) {
      throw new CliError(`Réponse inattendue (non JSON) sur ${upper} ${pathname}`, {
        exitCode: EXIT.SERVER,
        hint: `L'URL ${this.url} pointe-t-elle bien vers le panel HeiphaisBot ? (heiphais config show)`,
      });
    }
    return data;
  }

  get(p, opts) { return this.request('GET', p, opts); }
  post(p, body, opts) { return this.request('POST', p, { ...opts, body }); }
  put(p, body, opts) { return this.request('PUT', p, { ...opts, body }); }
  delete(p, opts) { return this.request('DELETE', p, opts); }
}

function networkError(err, baseUrl, timeoutMs) {
  const code = err?.cause?.code || err?.code || '';
  const name = err?.name || '';
  const envHint = 'Sur le VPS, vérifiez PANEL_ENABLED, PANEL_HOST et PANEL_PORT dans .env, et que le bot tourne (systemctl/pm2/docker).';
  const urlHint = `URL utilisée : ${baseUrl} — modifiez-la avec heiphais config set-url <url> ou --url.`;
  if (name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return new CliError(`Le panel ne répond pas (délai de ${Math.round(timeoutMs / 1000)} s dépassé) : ${baseUrl}`, { exitCode: EXIT.NETWORK, hint: [urlHint, envHint] });
  }
  if (code === 'ECONNREFUSED') {
    return new CliError(`Connexion refusée : aucun panel n'écoute sur ${baseUrl}`, { exitCode: EXIT.NETWORK, hint: ['Le bot est-il démarré ?', envHint, urlHint] });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new CliError(`Hôte introuvable : ${baseUrl}`, { exitCode: EXIT.NETWORK, hint: [urlHint, 'Vérifiez le nom de domaine / la résolution DNS.'] });
  }
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(err?.cause?.message || '')) {
    return new CliError(`Erreur TLS en contactant ${baseUrl} : ${err.cause?.message || err.message}`, { exitCode: EXIT.NETWORK, hint: 'Certificat HTTPS invalide ? Essayez l\'URL locale http://127.0.0.1:<PANEL_PORT> sur le VPS.' });
  }
  return new CliError(`Panel injoignable (${baseUrl}) : ${err?.cause?.message || err?.message || err}`, { exitCode: EXIT.NETWORK, hint: [urlHint, envHint] });
}

function httpError(status, data, text, method, pathname) {
  const apiMsg = stripMarkdown(data?.error || data?.message || (text && !data ? text.slice(0, 200) : '') || `HTTP ${status}`);
  const code = data?.code || null;
  const base = { status, code };
  if (status === 401) {
    return new CliError(`Jeton invalide ou expiré (${apiMsg})`, {
      ...base,
      exitCode: EXIT.AUTH,
      hint: [
        'Enregistrez un jeton valide : heiphais config set-token hb_…',
        'ou créez-en un sur le VPS : heiphais token create cli --local --save',
      ],
    });
  }
  if (status === 403) {
    let hint = null;
    if (code === 'MODULE_DISABLED') hint = 'Activez le module : heiphais module enable <nom> --guild <id>';
    else if (/propriétaire/i.test(apiMsg)) hint = 'Cette commande nécessite un jeton de portée « admin » (propriétaire du bot).';
    else if (/serveur/i.test(apiMsg)) hint = 'Ce jeton (portée « guild ») n\'inclut pas ce serveur : recréez-le avec --guilds <id,…> ou utilisez un jeton admin.';
    else if (code === 'BOT_MISSING_PERMS') hint = 'Donnez les permissions nécessaires au rôle du bot sur Discord.';
    return new CliError(`Accès refusé : ${apiMsg}`, { ...base, exitCode: EXIT.AUTH, hint });
  }
  if (status === 404) {
    let hint = null;
    if (/Route introuvable/i.test(apiMsg)) hint = `Endpoint ${method} /api${pathname} absent : version du bot différente ou module non chargé.`;
    else if (/Serveur introuvable|pas présent/i.test(apiMsg)) hint = 'Vérifiez l\'ID du serveur (heiphais guilds) : le bot doit être connecté à Discord et présent sur ce serveur.';
    else if (/Action inconnue/i.test(apiMsg)) hint = 'Listez les actions disponibles : heiphais actions <module>';
    else if (/Module inconnu/i.test(apiMsg)) hint = 'Listez les modules : heiphais modules';
    return new CliError(`Introuvable : ${apiMsg}`, { ...base, exitCode: EXIT.NOT_FOUND, hint });
  }
  if (status === 429) return new CliError('Trop de requêtes : limite de débit du panel atteinte, réessayez dans une minute.', { ...base, exitCode: EXIT.ERROR });
  if (status >= 500) {
    return new CliError(`Erreur du bot (HTTP ${status}) : ${apiMsg}`, { ...base, exitCode: EXIT.SERVER, hint: 'Consultez les journaux : heiphais logs --level error' });
  }
  return new CliError(apiMsg, { ...base, exitCode: EXIT.ERROR });
}
