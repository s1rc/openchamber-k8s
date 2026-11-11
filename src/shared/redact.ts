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
