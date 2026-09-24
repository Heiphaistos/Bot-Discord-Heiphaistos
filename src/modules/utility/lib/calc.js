/**
 * Safe arithmetic evaluator (no eval): tokenizer + recursive-descent parser.
 * Grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary | <implicit *> unary)*
 *   unary   := ('+' | '-') unary | power
 *   power   := postfix ('^' unary)?          (right associative, -2^2 = -4)
 *   postfix := primary '!'*
 *   primary := number | ident '(' args ')' | ident | '(' expr ')' | '|' expr '|'
 */
export class CalcError extends Error { constructor(msg) { super(msg); this.userFacing = true; } }

const MAX_LEN = 300;
const MAX_DEPTH = 60;
const snap = (x) => (Math.abs(x) < 1e-15 ? 0 : Math.round(x * 1e15) / 1e15);

export const CONSTANTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, inf: Infinity, infinity: Infinity };

function factorial(n) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('La factorielle n\'est définie que pour les entiers positifs');
  if (n > 170) throw new CalcError('Factorielle trop grande (max 170!)');
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); if (!Number.isInteger(a) || !Number.isInteger(b)) throw new CalcError('pgcd/ppcm : entiers requis'); while (b) [a, b] = [b, a % b]; return a; }

function buildFunctions(angle) {
  const toRad = (x) => (angle === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (angle === 'deg' ? (x * 180) / Math.PI : x);
  // [minArgs, maxArgs, fn]
  return {
    sqrt: [1, 1, (x) => { if (x < 0) throw new CalcError('Racine carrée d\'un nombre négatif'); return Math.sqrt(x); }],
    cbrt: [1, 1, Math.cbrt], abs: [1, 1, Math.abs],
    sin: [1, 1, (x) => snap(Math.sin(toRad(x)))], cos: [1, 1, (x) => snap(Math.cos(toRad(x)))], tan: [1, 1, (x) => snap(Math.tan(toRad(x)))],
    asin: [1, 1, (x) => fromRad(Math.asin(x))], acos: [1, 1, (x) => fromRad(Math.acos(x))], atan: [1, 1, (x) => fromRad(Math.atan(x))], atan2: [2, 2, (y, x) => fromRad(Math.atan2(y, x))],
    sinh: [1, 1, Math.sinh], cosh: [1, 1, Math.cosh], tanh: [1, 1, Math.tanh], asinh: [1, 1, Math.asinh], acosh: [1, 1, Math.acosh], atanh: [1, 1, Math.atanh],
    ln: [1, 1, (x) => { if (x <= 0) throw new CalcError('Logarithme d\'un nombre ≤ 0'); return Math.log(x); }],
    log: [1, 2, (x, b) => { if (x <= 0) throw new CalcError('Logarithme d\'un nombre ≤ 0'); if (b === undefined) return Math.log10(x); if (b <= 0 || b === 1) throw new CalcError('Base de logarithme invalide'); return Math.log(x) / Math.log(b); }],
    log2: [1, 1, (x) => { if (x <= 0) throw new CalcError('Logarithme d\'un nombre ≤ 0'); return Math.log2(x); }],
    log10: [1, 1, (x) => { if (x <= 0) throw new CalcError('Logarithme d\'un nombre ≤ 0'); return Math.log10(x); }],
    exp: [1, 1, Math.exp], floor: [1, 1, Math.floor], ceil: [1, 1, Math.ceil], trunc: [1, 1, Math.trunc], sign: [1, 1, Math.sign],
    round: [1, 2, (x, d = 0) => { const f = 10 ** Math.max(0, Math.min(15, Math.trunc(d))); return Math.round(x * f) / f; }],
    min: [1, 100, Math.min], max: [1, 100, Math.max], hypot: [1, 100, Math.hypot],
    avg: [1, 100, (...a) => a.reduce((s, v) => s + v, 0) / a.length], mean: [1, 100, (...a) => a.reduce((s, v) => s + v, 0) / a.length],
    sum: [1, 100, (...a) => a.reduce((s, v) => s + v, 0)],
    pow: [2, 2, (a, b) => a ** b], mod: [2, 2, (a, b) => { if (b === 0) throw new CalcError('Modulo par zéro'); return ((a % b) + b) % b; }],
    fact: [1, 1, factorial], gcd: [2, 100, (...a) => a.reduce((x, y) => gcd(x, y))], pgcd: [2, 100, (...a) => a.reduce((x, y) => gcd(x, y))],
    lcm: [2, 100, (...a) => a.reduce((x, y) => (x && y ? Math.abs(x * y) / gcd(x, y) : 0))], ppcm: [2, 100, (...a) => a.reduce((x, y) => (x && y ? Math.abs(x * y) / gcd(x, y) : 0))],
    deg: [1, 1, (x) => (x * 180) / Math.PI], rad: [1, 1, (x) => (x * Math.PI) / 180],
  };
}

export function tokenize(src) {
  const s = String(src).replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/\*\*/g, '^').replace(/√/g, 'sqrt').replace(/²/g, '^2').replace(/³/g, '^3');
  const tokens = [];
  const parenStack = []; // 'call' | 'group'
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    // number: hex / bin / oct / decimal with optional exponent; ',' is a decimal separator outside function calls
    if (/[0-9.]/.test(c)) {
      const radix = s.slice(i, i + 2).toLowerCase();
      if (radix === '0x' || radix === '0b' || radix === '0o') {
        const re = radix === '0x' ? /^[0-9a-f]+/i : radix === '0b' ? /^[01]+/ : /^[0-7]+/;
        const m = s.slice(i + 2).match(re);
        if (!m) throw new CalcError(`Nombre invalide près de « ${s.slice(i, i + 6)} »`);
        tokens.push({ t: 'num', v: parseInt(m[0], radix === '0x' ? 16 : radix === '0b' ? 2 : 8), pos: i });
        i += 2 + m[0].length; continue;
      }
      let j = i; let str = '';
      const inCall = parenStack[parenStack.length - 1] === 'call';
      while (j < s.length) {
        const ch = s[j];
        if (/[0-9]/.test(ch)) { str += ch; j++; continue; }
        if (ch === '.' && !str.includes('.')) { str += '.'; j++; continue; }
        if (ch === ',' && !inCall && !str.includes('.') && /[0-9]/.test(s[j + 1] || '') && /[0-9]/.test(str.slice(-1))) { str += '.'; j++; continue; }
        break;
      }
      if (/^[eE]$/.test(s[j] || '') && /^[+-]?\d/.test(s.slice(j + 1))) {
        const m = s.slice(j + 1).match(/^[+-]?\d+/);
        str += `e${m[0]}`; j += 1 + m[0].length;
      }
      if (str === '.') throw new CalcError('Point décimal isolé');
      tokens.push({ t: 'num', v: parseFloat(str), pos: i });
      i = j; continue;
    }
    if (/[a-zA-Zπ_]/.test(c)) {
      const m = s.slice(i).match(/^(π|[a-zA-Z_][a-zA-Z0-9_]*)/);
      tokens.push({ t: 'id', v: m[0].toLowerCase(), pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^!,;|'.includes(c)) { tokens.push({ t: 'op', v: c === ';' ? ',' : c, pos: i }); i++; continue; }
    if (c === '(') { const prev = tokens[tokens.length - 1]; parenStack.push(prev?.t === 'id' ? 'call' : 'group'); tokens.push({ t: 'op', v: '(', pos: i }); i++; continue; }
    if (c === ')') { parenStack.pop(); tokens.push({ t: 'op', v: ')', pos: i }); i++; continue; }
    throw new CalcError(`Caractère non autorisé : « ${c} »`);
  }
  return tokens;
}

/** Evaluate an arithmetic expression. options.angle = 'rad' | 'deg'. */
export function evaluate(expression, { angle = 'rad', variables = {} } = {}) {
  const src = String(expression ?? '').trim();
  if (!src) throw new CalcError('Expression vide');
  if (src.length > MAX_LEN) throw new CalcError(`Expression trop longue (max ${MAX_LEN} caractères)`);
  const tokens = tokenize(src);
  const FUNCS = buildFunctions(angle);
  const vars = { ...CONSTANTS, ...variables };
  let pos = 0; let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new CalcError(`« ${v} » attendu${peek() ? ` près de la position ${peek().pos + 1}` : ' en fin d\'expression'}`); pos++; };
  const enter = () => { if (++depth > MAX_DEPTH) throw new CalcError('Expression trop imbriquée'); };

  function expr() {
    enter();
    let v = term();
    while (isOp('+') || isOp('-')) { const op = tokens[pos++].v; const r = term(); v = op === '+' ? v + r : v - r; }
    depth--; return v;
  }
  function term() {
    let v = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('%')) {
        const op = tokens[pos++].v; const r = unary();
        if (op === '*') v *= r;
        else if (op === '/') { if (r === 0) throw new CalcError('Division par zéro'); v /= r; } else { if (r === 0) throw new CalcError('Modulo par zéro'); v %= r; }
        continue;
      }
      const t = peek();
      if (t && (t.t === 'id' || (t.t === 'op' && t.v === '('))) { v *= power(); continue; } // implicit multiplication: 2pi, 3(4+1), (1+2)(3+4)
      return v;
    }
  }
  function unary() {
    enter();
    let v;
    if (isOp('-')) { pos++; v = -unary(); } else if (isOp('+')) { pos++; v = unary(); } else v = power();
    depth--; return v;
  }
  function power() {
    const base = postfix();
    if (isOp('^')) { pos++; const ex = unary(); const r = base ** ex; if (Number.isNaN(r)) throw new CalcError('Puissance indéfinie (base négative et exposant non entier ?)'); return r; }
    return base;
  }
  function postfix() {
    let v = primary();
    while (isOp('!')) { pos++; v = factorial(v); }
    return v;
  }
  function primary() {
    const t = peek();
    if (!t) throw new CalcError('Expression incomplète');
    if (t.t === 'num') { pos++; return t.v; }
    if (t.t === 'id') {
      pos++;
      if (isOp('(')) {
        const fn = FUNCS[t.v];
        if (!fn) throw new CalcError(`Fonction inconnue : ${t.v}`);
        pos++;
        const args = [];
        if (!isOp(')')) { args.push(expr()); while (isOp(',')) { pos++; args.push(expr()); } }
        expect(')');
        if (args.length < fn[0] || args.length > fn[1]) throw new CalcError(`${t.v}() attend ${fn[0] === fn[1] ? fn[0] : `${fn[0]} à ${fn[1]}`} argument(s)`);
        return fn[2](...args);
      }
      if (t.v in vars) return vars[t.v];
      if (FUNCS[t.v]) { // function without parentheses: sqrt 16, sin 30
        const arg = unary();
        if (FUNCS[t.v][0] > 1) throw new CalcError(`${t.v}() nécessite des parenthèses`);
        return FUNCS[t.v][2](arg);
      }
      throw new CalcError(`Variable ou constante inconnue : ${t.v}`);
    }
    if (t.v === '(') { pos++; const v = expr(); expect(')'); return v; }
    if (t.v === '|') { pos++; const v = expr(); expect('|'); return Math.abs(v); }
    throw new CalcError(`Symbole inattendu « ${t.v} » à la position ${t.pos + 1}`);
  }

  const result = expr();
  if (pos < tokens.length) throw new CalcError(`Symbole inattendu « ${tokens[pos].v} » à la position ${tokens[pos].pos + 1}`);
  if (Number.isNaN(result)) throw new CalcError('Résultat indéfini');
  return result;
}

export function formatNumber(n, precision = 12) {
  if (typeof n !== 'number') return String(n);
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toString();
  const p = Number(n.toPrecision(precision));
  if (p !== 0 && (Math.abs(p) >= 1e21 || Math.abs(p) < 1e-7)) return p.toExponential().replace(/\.?0+e/, 'e');
  return String(p);
}
