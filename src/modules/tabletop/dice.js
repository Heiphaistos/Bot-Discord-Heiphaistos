/**
 * Parseur / évaluateur de dés maison.
 * Syntaxe : 2d6+3, 4d6kh3, 4d6dl1, 2d20kl1, d%, 4dF, 3d6!, 3d6!>5, 4d6r1, 4d6ro<2, 6d10>=7 (succès),
 * d20+5 >= 15 (comparaison), (1d8+2)*2, adv / dis (avantage / désavantage), x3 ou 3x (répétitions), # libellé.
 */

export class DiceError extends Error {
  constructor(message) { super(message); this.userFacing = true; this.code = 'DICE_ERROR'; this.status = 400; }
}

export const LIMITS = { maxLength: 200, maxCount: 200, maxSides: 10000, maxTotalDice: 1000, maxExplosions: 100, maxRepeat: 20 };

const CMP_RE = /^(>=|<=|!=|==|=|>|<)/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^\d+(\.\d+)?/))) { tokens.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if ((m = rest.match(CMP_RE))) { tokens.push({ t: 'cmp', v: m[0] === '==' ? '=' : m[0] }); i += m[0].length; continue; }
    if ('+-*/()'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
    if (c === '×') { tokens.push({ t: 'op', v: '*' }); i++; continue; }
    if (c === '÷') { tokens.push({ t: 'op', v: '/' }); i++; continue; }
    if (c === '!') { tokens.push({ t: 'bang' }); i++; continue; }
    if (c === '%') { tokens.push({ t: 'pct' }); i++; continue; }
    if ((m = rest.match(/^[a-z]+/))) { tokens.push({ t: 'word', v: m[0] }); i += m[0].length; continue; }
    throw new DiceError(`Caractère inattendu « ${c} » dans l'expression`);
  }
  return tokens;
}

/** Recursive-descent parser producing an AST. */
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;

  function parseComparison() {
    const left = parseExpr();
    if (peek()?.t === 'cmp') {
      const op = next().v;
      const right = parseExpr();
      return { type: 'compare', op, left, right };
    }
    return left;
  }
  function parseExpr() {
    let node = parseTerm();
    while (isOp('+') || isOp('-')) { const op = next().v; node = { type: 'bin', op, left: node, right: parseTerm() }; }
    return node;
  }
  function parseTerm() {
    let node = parseUnary();
    while (isOp('*') || isOp('/')) { const op = next().v; node = { type: 'bin', op, left: node, right: parseUnary() }; }
    return node;
  }
  function parseUnary() {
    if (isOp('-')) { next(); return { type: 'neg', expr: parseUnary() }; }
    if (isOp('+')) { next(); return parseUnary(); }
    return parsePrimary();
  }
  function readInt(def = null) {
    if (peek()?.t === 'num') { const v = next().v; if (!Number.isInteger(v)) throw new DiceError('Nombre entier attendu'); return v; }
    return def;
  }
  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new DiceError('Expression incomplète');
    if (tok.t === 'op' && tok.v === '(') {
      next();
      const inner = parseExpr();
      if (!isOp(')')) throw new DiceError('Parenthèse fermante manquante');
      next();
      return { type: 'group', expr: inner };
    }
    if (tok.t === 'num') {
      next();
      // "2d6" → num followed by word starting with d
      if (peek()?.t === 'word' && peek().v.startsWith('d')) return parseDice(tok.v);
      return { type: 'num', value: tok.v };
    }
    if (tok.t === 'word' && tok.v.startsWith('d')) return parseDice(1);
    throw new DiceError(`Élément inattendu : ${tok.v ?? tok.t}`);
  }
  function parseDice(count) {
    if (!Number.isInteger(count)) throw new DiceError('Le nombre de dés doit être entier');
    const word = next().v; // starts with d
    let sides; let fate = false;
    let tail = word.slice(1); // letters after 'd' (e.g. "f", "kh", "fkh")
    if (tail === '' || tail.startsWith('k') || tail.startsWith('r') || tail.startsWith('d') || tail.startsWith('m')) {
      if (peek()?.t === 'num' && tail === '') { sides = readInt(); }
      else if (peek()?.t === 'pct' && tail === '') { next(); sides = 100; }
      else if (tail === '') throw new DiceError('Nombre de faces manquant après « d »');
    }
    if (tail.startsWith('f')) { fate = true; sides = 3; tail = tail.slice(1); }
    if (sides === undefined && !fate) throw new DiceError(`Dé invalide : d${tail}`);
    const node = { type: 'dice', count, sides, fate, mods: [] };
    // Modifiers may be glued to the word (e.g. "d6kh" tokenized as word "d" then num... ) handle pending tail letters
    let pendingWord = tail || null;
    for (;;) {
      let w = pendingWord;
      pendingWord = null;
      if (!w) {
        const p = peek();
        if (p?.t === 'word' && /^(kh|kl|k|dh|dl|ro|r|min|max)$/.test(p.v)) { w = next().v; }
        else if (p?.t === 'bang') {
          next();
          const mod = { kind: 'explode', cmp: null, target: null };
          if (peek()?.t === 'cmp') { mod.cmp = next().v; mod.target = readInt(); if (mod.target === null) throw new DiceError('Valeur attendue après la condition d\'explosion'); }
          else if (peek()?.t === 'num') { mod.cmp = '='; mod.target = readInt(); }
          node.mods.push(mod);
          continue;
        } else if (p?.t === 'cmp' && tokens[pos + 1]?.t === 'num' && !node.mods.some((m) => m.kind === 'success')) {
          // success counting only when the comparison is the end of the expression or followed by an operator we don't own
          const op = next().v; const target = readInt();
          node.mods.push({ kind: 'success', cmp: op, target });
          continue;
        } else break;
      }
      if (!/^(kh|kl|k|dh|dl|ro|r|min|max)$/.test(w)) throw new DiceError(`Modificateur inconnu : ${w}`);
      if (w === 'r' || w === 'ro') {
        const mod = { kind: 'reroll', once: w === 'ro', cmp: '=', target: 1 };
        if (peek()?.t === 'cmp') { mod.cmp = next().v; mod.target = readInt(); if (mod.target === null) throw new DiceError('Valeur attendue après r'); }
        else mod.target = readInt(1);
        node.mods.push(mod);
      } else if (w === 'min' || w === 'max') {
        const v = readInt(); if (v === null) throw new DiceError(`Valeur attendue après ${w}`);
        node.mods.push({ kind: w, value: v });
      } else {
        const n = readInt(1);
        const kind = w === 'k' ? 'kh' : w;
        node.mods.push({ kind, value: n });
      }
    }
    if (count < 1 || count > LIMITS.maxCount) throw new DiceError(`Nombre de dés entre 1 et ${LIMITS.maxCount}`);
    if (!fate && (sides < 2 || sides > LIMITS.maxSides)) throw new DiceError(`Nombre de faces entre 2 et ${LIMITS.maxSides}`);
    return node;
  }

  const ast = parseComparison();
  if (pos < tokens.length) {
    const t = tokens[pos];
    throw new DiceError(`Élément inattendu : ${t.v ?? (t.t === 'bang' ? '!' : t.t)}`);
  }
  return ast;
}

function cmpTest(value, cmp, target) {
  switch (cmp) {
    case '>=': return value >= target;
    case '<=': return value <= target;
    case '>': return value > target;
    case '<': return value < target;
    case '!=': return value !== target;
    default: return value === target;
  }
}

function fmtNum(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100); }

/** Evaluate AST. state = { rng, detail, diceRolled } */
function evaluate(node, state) {
  switch (node.type) {
    case 'num': return { value: node.value, text: fmtNum(node.value) };
    case 'group': { const r = evaluate(node.expr, state); return { value: r.value, text: `(${r.text})`, successes: r.successes }; }
    case 'neg': { const r = evaluate(node.expr, state); return { value: -r.value, text: `-${r.text}` }; }
    case 'bin': {
      const a = evaluate(node.left, state); const b = evaluate(node.right, state);
      let value;
      if (node.op === '+') value = a.value + b.value;
      else if (node.op === '-') value = a.value - b.value;
      else if (node.op === '*') value = a.value * b.value;
      else { if (b.value === 0) throw new DiceError('Division par zéro'); value = Math.floor(a.value / b.value); }
      return { value, text: `${a.text} ${node.op === '*' ? '×' : node.op === '/' ? '÷' : node.op} ${b.text}` };
    }
    case 'compare': {
      const a = evaluate(node.left, state); const b = evaluate(node.right, state);
      const ok = cmpTest(a.value, node.op, b.value);
      return { value: ok ? 1 : 0, text: `${a.text} ${node.op} ${b.text}`, compare: { ok, left: a.value, right: b.value, op: node.op } };
    }
    case 'dice': return rollDice(node, state);
    default: throw new DiceError('Nœud inconnu');
  }
}

function rollOne(node, state) {
  state.diceRolled++;
  if (state.diceRolled > LIMITS.maxTotalDice) throw new DiceError(`Trop de dés lancés (max ${LIMITS.maxTotalDice})`);
  if (node.fate) return Math.floor(state.rng() * 3) - 1;
  return Math.floor(state.rng() * node.sides) + 1;
}

function rollDice(node, state) {
  const dice = []; // { v, dropped, exploded, rerolled: [old values] }
  const explode = node.mods.find((m) => m.kind === 'explode');
  const reroll = node.mods.find((m) => m.kind === 'reroll');
  const max = node.fate ? 1 : node.sides;
  if (explode && !node.fate) {
    const cmp = explode.cmp || '='; const target = explode.target ?? max;
    // prevent infinite explosion (e.g. d6!>=1)
    let always = true;
    for (let v = 1; v <= node.sides; v++) if (!cmpTest(v, cmp, target)) { always = false; break; }
    if (always) throw new DiceError('Condition d\'explosion toujours vraie');
  }
  let explosions = 0;
  for (let i = 0; i < node.count; i++) {
    let v = rollOne(node, state);
    const rer = [];
    if (reroll) {
      let guard = 0;
      while (cmpTest(v, reroll.cmp, reroll.target) && guard < 100) {
        rer.push(v); v = rollOne(node, state); guard++;
        if (reroll.once) break;
      }
    }
    dice.push({ v, rerolled: rer });
    if (explode && !node.fate) {
      const cmp = explode.cmp || '='; const target = explode.target ?? max;
      let last = v;
      while (cmpTest(last, cmp, target) && explosions < LIMITS.maxExplosions) {
        dice[dice.length - 1].exploded = true;
        last = rollOne(node, state); explosions++;
        dice.push({ v: last, rerolled: [], fromExplosion: true });
      }
    }
  }
  for (const m of node.mods) {
    if (m.kind === 'min') for (const d of dice) if (d.v < m.value) d.v = m.value;
    if (m.kind === 'max') for (const d of dice) if (d.v > m.value) d.v = m.value;
  }
  // keep / drop
  for (const m of node.mods) {
    if (!['kh', 'kl', 'dh', 'dl'].includes(m.kind)) continue;
    const active = dice.map((d, i) => ({ d, i })).filter((x) => !x.d.dropped);
    const sorted = [...active].sort((a, b) => a.d.v - b.d.v || a.i - b.i); // ascending
    const n = Math.max(0, Math.min(m.value, active.length));
    let toDrop = [];
    if (m.kind === 'kh') toDrop = sorted.slice(0, active.length - n);
    if (m.kind === 'kl') toDrop = sorted.slice(n);
    if (m.kind === 'dh') toDrop = sorted.slice(active.length - n);
    if (m.kind === 'dl') toDrop = sorted.slice(0, n);
    for (const x of toDrop) x.d.dropped = true;
  }
  const kept = dice.filter((d) => !d.dropped);
  const success = node.mods.find((m) => m.kind === 'success');
  let value; let successes = null;
  if (success) { successes = kept.filter((d) => cmpTest(d.v, success.cmp, success.target)).length; value = successes; }
  else value = kept.reduce((a, d) => a + d.v, 0);

  let text = null;
  if (state.detail) {
    const label = `${node.count}d${node.fate ? 'F' : node.sides}${node.mods.map(modLabel).join('')}`;
    const parts = dice.map((d) => {
      let s = node.fate ? (d.v > 0 ? '+' : d.v < 0 ? '−' : '0') : String(d.v);
      if (!node.fate && !d.dropped && (d.v === max)) s = `**${s}**`;
      if (!node.fate && !d.dropped && d.v === 1 && node.sides >= 4) s = `__${s}__`;
      if (d.exploded) s += '💥';
      if (success && !d.dropped && cmpTest(d.v, success.cmp, success.target)) s += '✓';
      if (d.dropped) s = `~~${s}~~`;
      if (d.rerolled.length) s = `${d.rerolled.map((r) => `~~${r}~~`).join(' ')}→${s}`;
      return s;
    });
    const shown = parts.length > 60 ? [...parts.slice(0, 60), `…(+${parts.length - 60})`] : parts;
    text = `${label} [${shown.join(', ')}]${success ? ` = ${successes} succès` : ''}`;
  }
  const naturals = node.count === 1 && !node.fate && dice.length >= 1 ? dice[0].v : null;
  return { value, text, successes, natural: node.sides === 20 && node.count <= 2 ? kept[0]?.v ?? naturals : null };
}

function modLabel(m) {
  switch (m.kind) {
    case 'kh': case 'kl': case 'dh': case 'dl': return `${m.kind}${m.value}`;
    case 'explode': return `!${m.cmp && m.cmp !== '=' ? m.cmp + m.target : (m.target ?? '')}`;
    case 'reroll': return `${m.once ? 'ro' : 'r'}${m.cmp !== '=' ? m.cmp : ''}${m.target}`;
    case 'success': return `${m.cmp}${m.target}`;
    case 'min': case 'max': return `${m.kind}${m.value}`;
    default: return '';
  }
}

/** Pre-process: label, repetitions, advantage/disadvantage. */
export function preprocess(input) {
  let src = String(input ?? '').trim();
  if (!src) throw new DiceError('Expression vide');
  if (src.length > LIMITS.maxLength) throw new DiceError(`Expression trop longue (max ${LIMITS.maxLength} caractères)`);
  let label = null;
  const hash = src.indexOf('#');
  if (hash >= 0) { label = src.slice(hash + 1).trim() || null; src = src.slice(0, hash).trim(); }
  src = src.toLowerCase().replace(/,/g, '.');
  let repeat = 1;
  let m = src.match(/\s*(?:^|\s)x\s*(\d+)\s*$/) || src.match(/\s*x(\d+)\s*$/);
  if (m) { repeat = Number(m[1]); src = src.slice(0, m.index).trim(); }
  else if ((m = src.match(/^(\d+)\s*x\s+/))) { repeat = Number(m[1]); src = src.slice(m[0].length).trim(); }
  if (repeat < 1 || repeat > LIMITS.maxRepeat) throw new DiceError(`Répétitions entre 1 et ${LIMITS.maxRepeat}`);
  let mode = null;
  const advRe = /\b(adv|avantage|advantage|av)\b/; const disRe = /\b(dis|dés?avantage|desavantage|disadvantage|dv)\b/;
  if (advRe.test(src)) { mode = 'adv'; src = src.replace(advRe, ' ').trim(); } else if (disRe.test(src)) { mode = 'dis'; src = src.replace(disRe, ' ').trim(); }
  if (mode) {
    const k = mode === 'adv' ? 'kh1' : 'kl1';
    if (!src) src = `2d20${k}`;
    else if (/(^|[^\d])1?d20(?![\d])/.test(src)) src = src.replace(/(^|[^\d])1?d20(?![\d])/, `$12d20${k}`);
    else if (/^[+-]/.test(src)) src = `2d20${k}${src}`;
    else throw new DiceError('Avantage/désavantage : l\'expression doit contenir un d20');
  }
  return { src, label, repeat, mode };
}

/**
 * Roll an expression. Returns { expression, label, mode, rolls: [{ total, text, compare, successes, crit }] }
 */
export function roll(input, { rng = Math.random } = {}) {
  const pre = preprocess(input);
  const ast = parse(tokenize(pre.src));
  const rolls = [];
  for (let i = 0; i < pre.repeat; i++) {
    const state = { rng, detail: true, diceRolled: 0 };
    const r = evaluate(ast, state);
    let crit = null;
    if (hasSingleD20(ast)) { const nat = findNatural(ast, r); if (nat === 20) crit = 'success'; else if (nat === 1) crit = 'fail'; }
    rolls.push({ total: r.value, text: r.text, compare: r.compare || null, successes: r.successes ?? null, crit });
  }
  return { expression: pre.src, label: pre.label, mode: pre.mode, repeat: pre.repeat, rolls };
}

function hasSingleD20(ast) {
  let n = 0; let ok = true;
  (function walk(node) {
    if (!node) return;
    if (node.type === 'dice') { n++; if (node.sides !== 20 || node.fate) ok = false; return; }
    for (const k of ['left', 'right', 'expr']) walk(node[k]);
  })(ast);
  return n === 1 && ok;
}
function findNatural(ast, r) {
  // natural value is the kept d20 of the single dice node: re-evaluate from text is fragile, so we parse from the text
  const m = r.text?.match(/d20[^[]*\[([^\]]*)\]/);
  if (!m) return null;
  const kept = m[1].split(',').map((s) => s.trim()).filter((s) => !s.startsWith('~~') && !s.includes('→~~')).map((s) => {
    const last = s.split('→').pop();
    return Number(last.replace(/[^\d]/g, ''));
  }).filter((v) => Number.isFinite(v));
  return kept.length === 1 ? kept[0] : null;
}

/** Monte-Carlo statistics of an expression. */
export function stats(input, { samples = 20000, rng = Math.random } = {}) {
  const pre = preprocess(input);
  const ast = parse(tokenize(pre.src));
  const counts = new Map();
  let sum = 0; let sum2 = 0; let min = Infinity; let max = -Infinity;
  const isCompare = ast.type === 'compare';
  for (let i = 0; i < samples; i++) {
    const state = { rng, detail: false, diceRolled: 0 };
    const v = evaluate(ast, state).value;
    counts.set(v, (counts.get(v) || 0) + 1);
    sum += v; sum2 += v * v;
    if (v < min) min = v; if (v > max) max = v;
  }
  const mean = sum / samples;
  const stdev = Math.sqrt(Math.max(0, sum2 / samples - mean * mean));
  const distribution = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([value, n]) => ({ value, probability: n / samples }));
  let acc = 0;
  let median = null;
  for (const d of distribution) { acc += d.probability; if (median === null && acc >= 0.5) median = d.value; }
  return { expression: pre.src, samples, mean, stdev, min, max, median, isCompare, successRate: isCompare ? (counts.get(1) || 0) / samples : null, distribution };
}

/** Deterministic PRNG (mulberry32) for tests / seeded rolls. */
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const FATE_LADDER = { 8: 'Légendaire', 7: 'Épique', 6: 'Fantastique', 5: 'Superbe', 4: 'Excellent', 3: 'Bon', 2: 'Correct', 1: 'Moyen', 0: 'Médiocre', '-1': 'Mauvais', '-2': 'Terrible', '-3': 'Catastrophique', '-4': 'Horrible' };
export function fateLadder(v) { return FATE_LADDER[Math.max(-4, Math.min(8, v))]; }
