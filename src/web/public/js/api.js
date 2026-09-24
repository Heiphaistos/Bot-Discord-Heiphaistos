// Enveloppe fetch : JSON, cookie de session, gestion 401 → connexion, erreurs → toasts.
import { toast } from './components/toast.js';

export class ApiError extends Error {
  constructor(message, code = 'ERROR', status = 0, body = null) {
    super(message);
    this.error = message;
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }

function resolveUrl(path) {
  if (/^\/(auth|api)\//.test(path) || path === '/api') return path;
  return `/api${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * opts.silent : pas de toast en cas d'erreur
 * opts.allowFail : renvoie le corps même si ok:false (HTTP 2xx)
 * opts.noRedirect : ne pas rediriger vers la connexion sur 401
 */
async function request(method, path, body, opts = {}) {
  const url = resolveUrl(path);
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined || method === 'POST' || method === 'PUT' || method === 'PATCH') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    const e = new ApiError('Serveur injoignable — vérifiez que le bot est en ligne', 'NETWORK', 0);
    if (!opts.silent) toast.error(e.message);
    throw e;
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  else { const text = await res.text().catch(() => ''); data = text ? { ok: res.ok, error: text.slice(0, 300) } : null; }

  if (res.status === 401 && !url.startsWith('/auth/')) {
    const e = new ApiError(data?.error || 'Authentification requise', 'UNAUTHORIZED', 401, data);
    if (!opts.noRedirect && unauthorizedHandler) unauthorizedHandler(e);
    throw e;
  }
  if (!res.ok || (data && data.ok === false && !(opts.allowFail && res.ok))) {
    const e = new ApiError(data?.error || `Erreur HTTP ${res.status}`, data?.code || `HTTP_${res.status}`, res.status, data);
    if (!opts.silent) toast.error(e.message);
    throw e;
  }
  return data ?? { ok: true };
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  del: (path, body, opts) => request('DELETE', path, body, opts),
  request,
};
export default api;
