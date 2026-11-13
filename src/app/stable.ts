// The SDK kit repaints a control from scratch on every `update`. Before shared-ui 0.2.0 its `useKit` called `update` after every render.
// A list that is rebuilt under a resting mouse loses its hover for a moment, which reads as a blink. These two helpers let
// `kit.tsx` update a control only when its data changed, and keep every callback pointing at the latest render.

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/** What a control would draw: the props as JSON, with each function standing for "a function is here". */
export const signatureOf = (props: unknown): string => JSON.stringify(props, (_key, value) => (typeof value === 'function' ? '[fn]' : (value as unknown)));

type Path = Array<string | number>;

const at = (root: unknown, path: Path): unknown => {
  let node: unknown = root;
  for (const part of path) {
    if (node === null || node === undefined) return undefined;
    node = (node as Record<string | number, unknown>)[part];
  }
  return node;
};

/**
 * A copy of the props where every function (at any depth in plain objects and arrays) calls the function at the same path in
 * `latest.current`. The control keeps one copy for as long as the data is the same, yet a click still runs the newest closure.
 */
export const proxyFunctions = <P>(props: P, latest: { current: P }): P => {
  const walk = (value: unknown, path: Path): unknown => {
    if (typeof value === 'function') {
      return (...args: unknown[]): unknown => {
        const fn = at(latest.current, path);
        return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
      };
    }
    if (Array.isArray(value)) return value.map((entry, index) => walk(entry, [...path, index]));
    if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry, [...path, key])]));
    return value;
  };
  return walk(props, []) as P;
};
