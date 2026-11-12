import { parseDocument, stringify } from 'yaml';
import type { Obj } from './types.ts';

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

const base64Bytes = (value: string): number => {
  const clean = value.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Removes server bookkeeping the UI never shows. Returns a shallow copy. */
export const stripNoise = (object: Obj): Obj => {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== 'object' || !('managedFields' in metadata)) return object;
  const { managedFields: _managedFields, ...rest } = metadata as Obj;
  return { ...object, metadata: rest };
};

/**
 * Replaces every Secret value with `<redacted, N bytes>` and drops the last-applied annotation, which holds the values.
 * With `reveal` the values stay: only the panel's reveal click may ask for that.
 */
export const redactSecret = (object: Obj, reveal = false): Obj => {
  if (reveal) return object;
  const out: Obj = { ...object };
  if (out.data && typeof out.data === 'object') {
    out.data = Object.fromEntries(Object.entries(out.data as Obj).map(([key, value]) => [key, `<redacted, ${base64Bytes(String(value))} bytes>`]));
  }
  if (out.stringData && typeof out.stringData === 'object') {
    out.stringData = Object.fromEntries(Object.entries(out.stringData as Obj).map(([key, value]) => [key, `<redacted, ${utf8Bytes(String(value))} bytes>`]));
  }
  const annotations = out.metadata?.annotations;
  if (annotations && typeof annotations === 'object' && LAST_APPLIED in annotations) {
    const { [LAST_APPLIED]: _dropped, ...rest } = annotations as Obj;
    out.metadata = { ...out.metadata, annotations: rest };
  }
  return out;
};

/** What the panel gets for any object: noise stripped, Secret values hidden. */
export const forPanel = (isSecretKind: boolean, object: Obj, reveal = false): Obj => {
  const stripped = stripNoise(object);
  return isSecretKind ? redactSecret(stripped, reveal) : stripped;
};

// ---------------------------------------------------------------------------------------------------------------
// Helm: release values and manifests can hold secrets

/** What a hidden value reads as. The upgrade route turns it back into the real value (see `restoreRedacted`). */
export const REDACTED = '<redacted>';

/** A key that probably holds a secret. The plan's rule, in one place. */
const SENSITIVE_KEY = /(password|secret|token|key|credential)/i;
export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

// A secret can also sit inside text: a ConfigMap that holds a config file, an environment variable, a string in the values.
// `maskLooseSecrets` finds `password: abc`, `API_TOKEN="abc"` and `"apiKey": "abc"` in any text and hides the value.
const LOOSE_WORDS = 'password|passwd|passphrase|token|api[_-]?key|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?';
const LOOSE = new RegExp(`((?:^|[\\s'"{,\\\\])[\\w.-]*?(?:${LOOSE_WORDS})[\\w.-]*)(["']?\\s*[:=]\\s*)('[^']*'|"[^"]*"|[^\\s'",}\\\\]+)`, 'gi');
// A key that names where a secret lives, not the secret itself.
const LOOSE_NOT_A_VALUE_KEY = /(name|ref|file|path|from|checksum|hash|enabled|ttl|expir\w*|type|url|namespace|selector|length|size|rotation|policy|version|mode|interval|period|id)$/i;
const LOOSE_NOT_A_SECRET_VALUE = /^(true|false|null|none|nil|~|\[\]|\{\})$/i;

const unquote = (value: string): { inner: string; open: string; close: string } => {
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.length >= 2 && value.endsWith(quote)) return { inner: value.slice(1, -1), open: quote, close: quote };
  return { inner: value, open: '', close: '' };
};

/** Whether a value is worth hiding: not a placeholder, a boolean, a path or a reference. */
const worthHiding = (value: string): boolean =>
  value.length >= 4 && !LOOSE_NOT_A_SECRET_VALUE.test(value) && !value.startsWith('<redacted') && !value.startsWith('{{') && !value.startsWith('$') && !/^[./~]/.test(value);

export interface Masked {
  text: string;
  /** The values that were hidden, in order. The upgrade route uses them to put a value back. */
  values: string[];
}

/** Hides the value of every secret-looking `key: value` or `key=value` in a piece of text. */
export const maskLooseSecrets = (text: string): Masked => {
  const values: string[] = [];
  const masked = text.replace(LOOSE, (all, head: string, middle: string, raw: string) => {
    const key = head.replace(/^[\s'"{,\\]/, '');
    if (LOOSE_NOT_A_VALUE_KEY.test(key)) return all;
    const { inner, open, close } = unquote(raw);
    if (!worthHiding(inner)) return all;
    values.push(inner);
    return `${head}${middle}${open}${REDACTED}${close}`;
  });
  return { text: masked, values };
};

/** Whether a name looks like it holds a secret, for an environment variable written as `name: X` then `value: y`. */
const secretLikeName = (name: string): boolean => new RegExp(`(${LOOSE_WORDS})`, 'i').test(name) && !LOOSE_NOT_A_VALUE_KEY.test(name);

/** Masks the lines of one manifest document, including an env entry whose `name` looks secret and whose `value` follows it. */
const maskDocumentLines = (lines: string[]): { lines: string[]; masked: number } => {
  let masked = 0;
  const out = lines.map((line) => {
    const result = maskLooseSecrets(line);
    masked += result.values.length;
    return result.text;
  });
  for (let i = 0; i + 1 < out.length; i += 1) {
    const name = /^\s*-?\s*name:\s*["']?([\w.-]+)["']?\s*$/.exec(out[i]!);
    const value = name && secretLikeName(name[1]!) ? /^(\s*)value:\s*(.+?)\s*$/.exec(out[i + 1]!) : null;
    if (!value) continue;
    const { inner, open, close } = unquote(value[2]!);
    if (!worthHiding(inner)) continue;
    out[i + 1] = `${value[1]}value: ${open}${REDACTED}${close}`;
    masked += 1;
  }
  return { lines: out, masked };
};

/**
 * Release values with every secret-looking value hidden. A key that matches hides every text and number below it
 * (booleans, null and empty text stay, they hold nothing). An entry of the `{ name: DB_PASSWORD, value: x }` shape
 * hides its value too. Returns a copy.
 */
export const redactValues = (value: unknown, hide = false): unknown => {
  if (Array.isArray(value)) return value.map((entry) => redactValues(entry, hide));
  if (value && typeof value === 'object') {
    const source = value as Obj;
    const nameHides = typeof source.name === 'string' && isSensitiveKey(source.name);
    const out: Obj = {};
    for (const [key, entry] of Object.entries(source)) out[key] = redactValues(entry, hide || isSensitiveKey(key) || (nameHides && key === 'value'));
    return out;
  }
  if (hide && ((typeof value === 'string' && value !== '') || typeof value === 'number' || typeof value === 'bigint')) return REDACTED;
  if (typeof value === 'string') return maskLooseSecrets(value).text;
  return value;
};

const pathText = (path: Array<string | number>): string => path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${part}`)).join('').replace(/^\./, '') || '(root)';

/**
 * The reverse of `redactValues` for an edited document: every leaf still reading `<redacted>` gets the value it had
 * before. A leaf the user retyped keeps their text. `unresolved` lists the paths whose original cannot be found (a
 * moved entry), so the caller can refuse instead of writing the placeholder into the cluster.
 */
export const restoreRedacted = (edited: unknown, original: unknown): { value: unknown; unresolved: string[] } => {
  const unresolved: string[] = [];
  const walk = (node: unknown, before: unknown, path: Array<string | number>): unknown => {
    if (node === REDACTED) {
      if (before !== undefined && before !== null && typeof before !== 'object') return before;
      unresolved.push(pathText(path));
      return node;
    }
    if (typeof node === 'string' && node.includes(REDACTED) && typeof before === 'string') {
      // A string with a secret inside it: the hidden values come back in order, when the count matches what was hidden.
      const hidden = maskLooseSecrets(before).values;
      const parts = node.split(REDACTED);
      if (parts.length - 1 === hidden.length) return parts.reduce((text, part, index) => text + part + (index < hidden.length ? hidden[index]! : ''), '');
      unresolved.push(pathText(path));
      return node;
    }
    if (typeof node === 'string' && node.includes(REDACTED)) {
      unresolved.push(pathText(path));
      return node;
    }
    if (Array.isArray(node)) return node.map((entry, index) => walk(entry, Array.isArray(before) ? before[index] : undefined, [...path, index]));
    if (node && typeof node === 'object') {
      const previous = before && typeof before === 'object' && !Array.isArray(before) ? (before as Obj) : {};
      return Object.fromEntries(Object.entries(node as Obj).map(([key, entry]) => [key, walk(entry, previous[key], [...path, key])]));
    }
    return node;
  };
  return { value: walk(edited, original, []), unresolved };
};

const SEPARATOR = /^---\s*(#.*)?$/;
const SECRET_KIND = /^\s*kind:\s*['"]?Secret['"]?\s*(#.*)?$/m;

const hideSecretDocument = (value: Obj): Obj => redactSecret(value);

/** One manifest document: unchanged unless it is a Secret (or a List holding one). Returns the new text and how many Secrets it hid. */
const redactDocument = (lines: string[]): { lines: string[]; secrets: number } => {
  const text = lines.join('\n');
  if (!/Secret/.test(text)) return { lines, secrets: 0 };
  const parsed = parseDocument(text);
  if (parsed.errors.length > 0) {
    // A document that cannot be read but says it is a Secret is hidden whole: its values cannot be told apart.
    return SECRET_KIND.test(text) ? { lines: [...lines.filter((line) => line.trim().startsWith('#')), '# A Secret document that could not be read was hidden.'], secrets: 1 } : { lines, secrets: 0 };
  }
  const value = parsed.toJS() as unknown;
  if (!value || typeof value !== 'object') return { lines, secrets: 0 };
  const object = value as Obj;
  const comments = lines.filter((line) => line.trim().startsWith('#'));
  if (object.kind === 'Secret') {
    return { lines: [...comments, ...stringify(hideSecretDocument(object), { lineWidth: 0, indent: 2 }).trimEnd().split('\n')], secrets: 1 };
  }
  if (Array.isArray(object.items) && object.items.some((item: unknown) => (item as Obj | null)?.kind === 'Secret')) {
    let secrets = 0;
    const items = (object.items as unknown[]).map((item) => {
      if ((item as Obj | null)?.kind !== 'Secret') return item;
      secrets += 1;
      return hideSecretDocument(item as Obj);
    });
    return { lines: [...comments, ...stringify({ ...object, items }, { lineWidth: 0, indent: 2 }).trimEnd().split('\n')], secrets };
  }
  return { lines, secrets: 0 };
};

/**
 * A rendered Helm manifest with every `kind: Secret` document hidden: the keys stay, each value reads
 * `<redacted, N bytes>`. In every other document a value that looks like a secret (`password: x`, `API_TOKEN=x`, an env
 * entry named like one) reads `<redacted>`; the rest is kept as it was, comments included.
 */
export const redactManifest = (manifest: string): { text: string; secrets: number; masked: number } => {
  const out: string[] = [];
  let secrets = 0;
  let masked = 0;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const result = redactDocument(current);
    if (result.secrets > 0) out.push(...result.lines);
    else {
      // Not a Secret, but it may hold one in text (a ConfigMap with a config file, an env var).
      const loose = maskDocumentLines(result.lines);
      out.push(...loose.lines);
      masked += loose.masked;
    }
    secrets += result.secrets;
    current = [];
  };
  for (const line of manifest.replace(/\r\n/g, '\n').split('\n')) {
    if (SEPARATOR.test(line)) {
      flush();
      out.push(line);
    } else current.push(line);
  }
  flush();
  return { text: out.join('\n'), secrets, masked };
};
