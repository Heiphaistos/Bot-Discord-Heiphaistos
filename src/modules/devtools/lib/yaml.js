/** Minimal YAML <-> JSON conversion for simple structures (maps, lists, scalars, block/flow collections). */
export class YamlError extends Error {}

// ---------- JSON -> YAML ----------
const NEEDS_QUOTE = /^$|^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|yes|no|on|off|null|~|y|n)$|^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$|^0x[0-9a-f]+$|^0o[0-7]+$|[\x00-\x1f]/i;
function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? '.nan' : (v > 0 ? '.inf' : '-.inf'));
  const s = String(v);
  return NEEDS_QUOTE.test(s) ? JSON.stringify(s) : s;
}
export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map((item) => {
      if (item && typeof item === 'object' && Object.keys(item).length) {
        const inner = toYaml(item, indent + 2);
        return `${pad}- ${inner.slice(indent + 2)}`;
      }
      return `${pad}- ${inlineValue(item, indent + 2)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return `${pad}{}`;
    return keys.map((k) => {
      const v = value[k]; const key = scalar(k);
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${key}:\n${toYaml(v, Array.isArray(v) ? indent : indent + 2)}`;
      return `${pad}${key}: ${inlineValue(v, indent + 2)}`;
    }).join('\n');
  }
  return pad + inlineValue(value, indent);
}
function inlineValue(v, indent) {
  if (Array.isArray(v) && !v.length) return '[]';
  if (v && typeof v === 'object' && !Object.keys(v).length) return '{}';
  if (typeof v === 'string' && v.includes('\n')) return `|${v.endsWith('\n') ? '' : '-'}\n${v.replace(/\n$/, '').split('\n').map((l) => ' '.repeat(indent) + l).join('\n')}`;
  return scalar(v);
}

// ---------- YAML -> JSON ----------
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[{,-]/.test(line[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line.replace(/\s+$/, '');
}

export function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  if (s.startsWith('"')) { if (!s.endsWith('"') || s.length < 2) throw new YamlError(`Chaîne non terminée : ${s}`); try { return JSON.parse(s); } catch { throw new YamlError(`Chaîne invalide : ${s}`); } }
  if (s.startsWith("'")) { if (!s.endsWith("'") || s.length < 2) throw new YamlError(`Chaîne non terminée : ${s}`); return s.slice(1, -1).replace(/''/g, "'"); }
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s);
  if (/^[&*!]/.test(s)) throw new YamlError('Les ancres, alias et tags YAML ne sont pas supportés');
  return s;
}

function parseFlow(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const value = () => {
    ws();
    if (src[i] === '[') { i++; const arr = []; ws(); if (src[i] === ']') { i++; return arr; } for (;;) { arr.push(value()); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === ']') { i++; return arr; } throw new YamlError(`Séquence flow invalide près de « ${src.slice(i, i + 10)} »`); } }
    if (src[i] === '{') { i++; const obj = {}; ws(); if (src[i] === '}') { i++; return obj; } for (;;) { ws(); const k = token(true); ws(); if (src[i] !== ':') throw new YamlError('« : » attendu dans une map flow'); i++; obj[String(k)] = value(); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === '}') { i++; return obj; } throw new YamlError(`Map flow invalide près de « ${src.slice(i, i + 10)} »`); } }
    return token(false);
  };
  const token = (isKey) => {
    ws();
    if (src[i] === '"' || src[i] === "'") { const q = src[i]; let j = i + 1; while (j < src.length && src[j] !== q) { if (src[j] === '\\' && q === '"') j++; j++; } const raw = src.slice(i, j + 1); i = j + 1; return parseScalar(raw); }
    let j = i; while (j < src.length && !(isKey ? /[:,}\]]/ : /[,}\]]/).test(src[j])) j++;
    const raw = src.slice(i, j); i = j; return parseScalar(raw);
  };
  const v = value(); ws();
  if (i < src.length) throw new YamlError(`Contenu inattendu après la collection : « ${src.slice(i, i + 20)} »`);
  return v;
}

export function fromYaml(text) {
  const rawLines = String(text).replace(/\t/g, '  ').split(/\r?\n/);
  const lines = [];
  for (let n = 0; n < rawLines.length; n++) {
    const raw = rawLines[n];
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) { if (lines.length && raw.trim() === '---') break; continue; }
    if (/^\s*%/.test(raw)) continue;
    lines.push({ n: n + 1, raw, indent: raw.match(/^ */)[0].length, content: stripComment(raw).trim() });
  }
  let pos = 0;
  const skipBlank = () => { while (pos < lines.length && !lines[pos].content) pos++; };

  function parseBlock(indent) {
    skipBlank();
    if (pos >= lines.length) return null;
    const line = lines[pos];
    if (line.indent < indent) return null;
    if (/^-( |$)/.test(line.content)) return parseSeq(line.indent);
    if (isMapLine(line.content)) return parseMap(line.indent);
    pos++;
    return parseScalar(line.content);
  }
  function isMapLine(c) { return /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#[{][^:]*?)\s*:(\s|$)/.test(c); }
  function splitKey(c) {
    const m = c.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+?)\s*:(?:\s+(.*))?$/);
    return { key: String(parseScalar(m[1])), rest: (m[2] ?? '').trim() };
  }
  function blockScalar(indicator, parentIndent) {
    const folded = indicator.startsWith('>'); const chomp = indicator.includes('-') ? 'strip' : indicator.includes('+') ? 'keep' : 'clip';
    const collected = []; let blockIndent = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.raw.trim() === '') { collected.push(''); pos++; continue; }
      if (l.indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = l.indent;
      collected.push(l.raw.slice(blockIndent)); pos++;
    }
    let trailing = 0; while (collected.length && collected[collected.length - 1] === '') { collected.pop(); trailing++; }
    let out = folded ? collected.reduce((acc, l, i) => (i === 0 ? l : acc + (l === '' || collected[i - 1] === '' ? '\n' : ' ') + l), '') : collected.join('\n');
    if (chomp === 'clip' && collected.length) out += '\n';
    if (chomp === 'keep') out += '\n'.repeat(trailing + 1);
    return out;
  }
  function valueAfterKey(rest, indent) {
    if (rest && /^[|>][-+]?\d*$/.test(rest)) { pos++; return blockScalar(rest, indent); }
    pos++;
    if (rest) {
      if (/^[&*!]/.test(rest)) throw new YamlError(`Ligne ${lines[pos - 1].n} : ancres/alias/tags non supportés`);
      if ((rest.startsWith('[') && !rest.endsWith(']')) || (rest.startsWith('{') && !rest.endsWith('}'))) {
        let acc = rest; while (pos < lines.length && !balanced(acc)) acc += ` ${lines[pos++].content}`;
        return parseScalar(acc);
      }
      return parseScalar(rest);
    }
    skipBlank();
    if (pos >= lines.length) return null;
    const next = lines[pos];
    if (next.indent > indent) return parseBlock(next.indent);
    if (next.indent === indent && /^-( |$)/.test(next.content)) return parseSeq(indent);
    return null;
  }
  function balanced(s) { let d = 0; for (const c of s) { if (c === '[' || c === '{') d++; if (c === ']' || c === '}') d--; } return d <= 0; }
  function parseMap(indent) {
    const obj = {};
    for (;;) {
      skipBlank();
      if (pos >= lines.length) break;
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(`Ligne ${line.n} : indentation inattendue`);
      if (!isMapLine(line.content)) { if (/^-( |$)/.test(line.content)) break; throw new YamlError(`Ligne ${line.n} : « clé: valeur » attendu`); }
      const { key, rest } = splitKey(line.content);
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`Ligne ${line.n} : clé dupliquée « ${key} »`);
      obj[key] = valueAfterKey(rest, indent);
    }
    return obj;
  }
  function parseSeq(indent) {
    const arr = [];
    for (;;) {
      skipBlank();
      if (pos >= lines.length) break;
      const line = lines[pos];
      if (line.indent !== indent || !/^-( |$)/.test(line.content)) { if (line.indent > indent) throw new YamlError(`Ligne ${line.n} : indentation inattendue`); break; }
      const rest = line.content.replace(/^-\s*/, '');
      if (!rest) { pos++; skipBlank(); arr.push(pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null); continue; }
      const offset = line.raw.indexOf(rest, line.indent + 1);
      if (/^-( |$)/.test(rest) || isMapLine(rest)) {
        lines[pos] = { ...line, indent: offset, content: rest, raw: ' '.repeat(offset) + rest };
        arr.push(parseBlock(offset));
      } else if (/^[|>][-+]?\d*$/.test(rest)) { pos++; arr.push(blockScalar(rest, indent)); }
      else { pos++; arr.push(parseScalar(rest)); }
    }
    return arr;
  }
  skipBlank();
  if (pos >= lines.length) return null;
  const first = lines[pos];
  const result = parseBlock(first.indent);
  skipBlank();
  if (pos < lines.length) throw new YamlError(`Ligne ${lines[pos].n} : contenu inattendu (indentation incohérente ?)`);
  return result;
}
