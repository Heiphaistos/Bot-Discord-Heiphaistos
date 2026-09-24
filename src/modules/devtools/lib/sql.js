/** Simple SQL formatter: uppercase keywords, one clause per line, indentation of lists / conditions / subqueries. */
const KEYWORDS = new Set(('select from where and or not in is null like ilike between exists as on using join inner left right full outer cross natural group by order having limit offset union all distinct insert into values update set delete create table alter drop add column primary key foreign references index unique default check constraint if with recursive returning case when then else end asc desc nulls first last true false count sum avg min max coalesce cast interval view trigger begin commit rollback transaction replace ignore conflict do nothing fetch next rows only over partition window filter lateral any some intersect except escape collate integer int text varchar char boolean real float double numeric decimal date timestamp time serial bigint smallint blob autoincrement explain analyze vacuum pragma truncate grant revoke to').split(' '));
const CLAUSES = ['select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'offset', 'union all', 'union', 'intersect', 'except', 'insert into', 'values', 'update', 'set', 'delete from', 'returning', 'with', 'window', 'on conflict', 'left outer join', 'right outer join', 'full outer join', 'left join', 'right join', 'full join', 'inner join', 'cross join', 'natural join', 'join', 'create table', 'alter table', 'drop table', 'fetch'];

export function tokenize(sql) {
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\])|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_$]*)|(<>|!=|<=|>=|\|\||::|[(),;.*=<>+\-/%])|(\S)/g;
  const out = []; let m;
  while ((m = re.exec(sql))) {
    if (m[1]) out.push({ t: 'comment', v: m[1] });
    else if (m[2]) out.push({ t: 'string', v: m[2] });
    else if (m[3]) out.push({ t: 'number', v: m[3] });
    else if (m[4]) out.push({ t: KEYWORDS.has(m[4].toLowerCase()) ? 'kw' : 'ident', v: m[4] });
    else out.push({ t: 'sym', v: m[5] || m[6] });
  }
  return out;
}

export function formatSql(sql, { indent = '  ', uppercase = true } = {}) {
  const toks = tokenize(sql);
  const lines = []; let cur = ''; let depth = 0; const stack = []; let clause = null; let caseDepth = 0;
  const push = () => { if (cur.trim()) lines.push(cur.replace(/\s+$/, '')); cur = ''; };
  const newline = (d) => { push(); cur = indent.repeat(Math.max(0, d)); };
  const FUNCS = new Set(['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'cast', 'replace', 'char', 'varchar', 'decimal', 'numeric', 'float', 'over', 'filter', 'exists']);
  let prev = null;
  const append = (s, noSpace = false) => { if (!noSpace && cur.trim() && !/[(.]$/.test(cur) && !/^[),.;]/.test(s)) cur += ' '; cur += s; };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const before = prev; prev = tk;
    const v = tk.t === 'kw' && uppercase ? tk.v.toUpperCase() : tk.v;
    if (tk.t === 'comment') { append(tk.v); if (tk.v.startsWith('--')) newline(depth + 1); continue; }
    if (tk.t === 'kw') {
      const lower = tk.v.toLowerCase();
      const multi = CLAUSES.find((c) => { const parts = c.split(' '); return parts.every((p, j) => toks[i + j]?.v?.toLowerCase() === p); });
      if (multi && caseDepth === 0) {
        const n = multi.split(' ').length;
        const text = toks.slice(i, i + n).map((t) => (uppercase ? t.v.toUpperCase() : t.v)).join(' ');
        const isJoin = multi.includes('join');
        newline(depth); append(text); clause = multi; i += n - 1;
        if (!isJoin && !['union', 'union all', 'intersect', 'except', 'limit', 'offset', 'fetch'].includes(multi)) newline(depth + 1);
        else if (['union', 'union all', 'intersect', 'except'].includes(multi)) newline(depth);
        continue;
      }
      const inPlainParen = stack.length && !stack[stack.length - 1].sub;
      if (((lower === 'and' || lower === 'or') && ['where', 'having'].includes(clause) || lower === 'on') && caseDepth === 0 && !inPlainParen) { newline(depth + 1); append(v); continue; }
      if (lower === 'case') caseDepth++;
      if (lower === 'end' && caseDepth) caseDepth--;
      append(v); continue;
    }
    if (tk.v === '(') {
      const nextKw = toks[i + 1]?.v?.toLowerCase();
      if (nextKw === 'select' || nextKw === 'with') { append('('); stack.push({ sub: true, clause }); depth += 2; continue; }
      const isCall = before && ((before.t === 'ident' && !['insert into', 'create table'].includes(clause)) || (before.t === 'kw' && FUNCS.has(before.v.toLowerCase())));
      append('(', isCall);
      const columns = clause === 'create table' && stack.length === 0;
      stack.push({ sub: false, columns });
      if (columns) newline(depth + 2);
      continue;
    }
    if (tk.v === ')') {
      const top = stack.pop();
      if (top?.sub) { depth -= 2; newline(depth + 1); cur += ')'; clause = top.clause; continue; }
      if (top?.columns) { newline(depth + 1); cur += ')'; continue; }
      cur += ')'; continue;
    }
    if (tk.v === ',') {
      cur += ',';
      const inParen = stack.length && !stack[stack.length - 1].sub;
      if (!inParen && ['select', 'group by', 'order by', 'set', 'returning', 'values'].includes(clause)) newline(depth + 1);
      if (inParen && stack[stack.length - 1].columns) newline(depth + 2);
      continue;
    }
    if (tk.v === ';') { cur += ';'; push(); lines.push(''); depth = 0; stack.length = 0; clause = null; continue; }
    if (tk.v === '.') { cur += '.'; continue; }
    append(v);
  }
  push();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
