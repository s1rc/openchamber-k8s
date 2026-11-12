// The small part of JSONPath that a CRD's additionalPrinterColumns uses. Pure, so the table and the tests agree.
// Supported: .a.b, ['a.b'], [0], [-1], [*], .*, [?(@.type=="Ready")] and [?(@.type!="Ready")], an escaped dot (a\.b),
// and the optional $ or {} wrapper kubectl accepts. Anything else is "no value", never an error.

type Scalar = string | number | boolean;

type Token =
  | { type: 'key'; key: string }
  | { type: 'index'; index: number }
  | { type: 'all' }
  | { type: 'filter'; path: Token[]; op: '==' | '!=' | 'exists'; value: Scalar | null };

const readKeyName = (source: string, from: number): { key: string; end: number } => {
  let key = '';
  let at = from;
  while (at < source.length && source[at] !== '.' && source[at] !== '[') {
    if (source[at] === '\\' && at + 1 < source.length) {
      key += source[at + 1];
      at += 2;
    } else {
      key += source[at];
      at += 1;
    }
  }
  return { key, end: at };
};

const parseValue = (text: string): Scalar | null => {
  const trimmed = text.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  if (quoted) return quoted[2] ?? '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return null;
};

/** Reads a path into tokens. Null when the text is not a path this reader understands. */
export const parsePath = (path: string): Token[] | null => {
  let source = path.trim();
  if (source.startsWith('{') && source.endsWith('}')) source = source.slice(1, -1).trim();
  if (source.startsWith('$')) source = source.slice(1);
  if (source === '' || source === '.') return [];
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === '.') {
      const { key, end } = readKeyName(source, at + 1);
      if (key === '') return null;
      tokens.push(key === '*' ? { type: 'all' } : { type: 'key', key });
      at = end;
    } else if (char === '[') {
      let close = source.indexOf(']', at);
      // A filter holds quotes and may hold a closing bracket inside them; find the bracket after the closing parenthesis.
      if (source[at + 1] === '?') {
        const paren = source.indexOf(')', at);
        close = paren < 0 ? -1 : source.indexOf(']', paren);
      }
      if (close < 0) return null;
      const inner = source.slice(at + 1, close).trim();
      if (inner === '*') tokens.push({ type: 'all' });
      else if (/^-?\d+$/.test(inner)) tokens.push({ type: 'index', index: Number(inner) });
      else if (/^(['"]).*\1$/.test(inner)) tokens.push({ type: 'key', key: inner.slice(1, -1) });
      else {
        const filter = /^\?\(\s*@((?:\.[^=!\s)]+|\[[^\]]*\])*)\s*(?:(==|!=)\s*(.+?))?\s*\)$/.exec(inner);
        if (!filter) return null;
        const relative = parsePath(filter[1] ?? '');
        if (relative === null) return null;
        if (!filter[2]) tokens.push({ type: 'filter', path: relative, op: 'exists', value: null });
        else {
          const value = parseValue(filter[3] ?? '');
          if (value === null) return null;
          tokens.push({ type: 'filter', path: relative, op: filter[2] as '==' | '!=', value });
        }
      }
      at = close + 1;
    } else if (char === ' ') {
      at += 1;
    } else return null;
  }
  return tokens;
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const step = (nodes: unknown[], token: Token): unknown[] => {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (token.type === 'key') {
      if (isObject(node) && token.key in node && node[token.key] !== undefined) out.push(node[token.key]);
    } else if (token.type === 'index') {
      if (Array.isArray(node)) {
        const entry = node[token.index < 0 ? node.length + token.index : token.index];
        if (entry !== undefined) out.push(entry);
      }
    } else if (token.type === 'all') {
      if (Array.isArray(node)) out.push(...node);
      else if (isObject(node)) out.push(...Object.values(node));
    } else if (Array.isArray(node)) {
      for (const entry of node) {
        const found = evaluate(entry, token.path);
        if (token.op === 'exists') {
          if (found.length > 0) out.push(entry);
        } else if (found.length > 0) {
          const same = found.some((value) => String(value) === String(token.value));
          if (token.op === '==' ? same : !same) out.push(entry);
        } else if (token.op === '!=') out.push(entry);
      }
    }
  }
  return out;
};

const evaluate = (object: unknown, tokens: Token[]): unknown[] => tokens.reduce<unknown[]>((nodes, token) => step(nodes, token), [object]);

/** Every value a path matches. */
export const evalPath = (object: unknown, path: string): unknown[] => {
  const tokens = parsePath(path);
  return tokens === null ? [] : evaluate(object, tokens);
};

const show = (value: unknown): string | number | boolean => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
};

/**
 * The cell a printer column shows: the first match as it is, several matches joined with a comma,
 * an object or array as JSON, and null when nothing matches.
 */
export const printerValue = (object: unknown, path: string): string | number | boolean | null => {
  if (path.trim() === '') return null;
  const found = evalPath(object, path).filter((value) => value !== null && value !== undefined);
  if (found.length === 0) return null;
  if (found.length === 1) return show(found[0]);
  return found.map((value) => String(show(value))).join(',');
};
