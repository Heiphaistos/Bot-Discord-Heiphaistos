import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function pasteId(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = ''; for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

const KEYWORDS = new Set('abstract async await break case catch class const continue def default del delete do elif else enum export extends false finally fn for from func function if impl import in instanceof interface is let match module mut new nil None not null or and package pass private protected pub public raise return self static struct super switch this throw throws true True False try type typeof undefined use var void while with yield lambda echo fi then esac done local select insert update delete where join values set create table drop alter into'.split(' '));

/**
 * Very small, language-agnostic highlighter: strings, comments, numbers, keywords.
 * Input is raw text; output is escaped HTML.
 */
export function highlight(code) {
  const re = /(\/\/[^\n]*|#[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b|\b0x[0-9a-fA-F]+\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  let out = ''; let last = 0; let m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    const [tok, comment, str, num, word] = m;
    if (comment) out += `<span class="c">${escapeHtml(tok)}</span>`;
    else if (str) out += `<span class="s">${escapeHtml(tok)}</span>`;
    else if (num) out += `<span class="n">${escapeHtml(tok)}</span>`;
    else if (word && KEYWORDS.has(word)) out += `<span class="k">${escapeHtml(tok)}</span>`;
    else out += escapeHtml(tok);
    last = m.index + tok.length;
  }
  return out + escapeHtml(code.slice(last));
}

export function renderPasteHtml(paste, { rawUrl, botName = 'HeiphaisBot' } = {}) {
  const title = escapeHtml(paste.title || `Paste ${paste.id}`);
  const lines = String(paste.content).split('\n');
  const body = highlight(String(paste.content));
  const gutter = lines.map((_, i) => i + 1).join('\n');
  const expires = paste.expires_at ? new Date(paste.expires_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : 'jamais';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} — ${escapeHtml(botName)}</title>
<style>
:root{--bg:#f6f7f9;--fg:#1f2328;--muted:#656d76;--panel:#fff;--border:#d0d7de;--k:#cf222e;--s:#0a3069;--n:#0550ae;--c:#6e7781}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--panel:#161b22;--border:#30363d;--k:#ff7b72;--s:#a5d6ff;--n:#79c0ff;--c:#8b949e}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline}
h1{font-size:16px;margin:0}small{color:var(--muted)}a{color:var(--n)}
.wrap{display:flex;overflow:auto;background:var(--panel);margin:16px;border:1px solid var(--border);border-radius:6px}
pre{margin:0;padding:12px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.g{color:var(--muted);text-align:right;user-select:none;border-right:1px solid var(--border)}
.k{color:var(--k)}.s{color:var(--s)}.n{color:var(--n)}.c{color:var(--c);font-style:italic}
</style></head><body>
<header><h1>${title}</h1><small>${lines.length} ligne(s) · ${paste.language ? escapeHtml(paste.language) + ' · ' : ''}expire : ${escapeHtml(expires)} · ${paste.views || 0} vue(s)</small>${rawUrl ? `<a href="${escapeHtml(rawUrl)}">Texte brut</a>` : ''}</header>
<div class="wrap"><pre class="g">${gutter}</pre><pre>${body}</pre></div>
</body></html>`;
}
