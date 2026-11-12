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
 * `<redacted, N bytes>`. Every other document is kept as it was, comments included.
 */
export const redactManifest = (manifest: string): { text: string; secrets: number } => {
  const out: string[] = [];
  let secrets = 0;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const result = redactDocument(current);
    out.push(...result.lines);
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
  return { text: out.join('\n'), secrets };
};
