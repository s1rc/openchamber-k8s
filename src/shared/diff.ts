// A small line diff for the YAML editor and the Helm checks. Enough to show what a change does.
import { parseDocument } from 'yaml';

/** `skip` stands for a run of unchanged lines left out of a short view; its text says how many. */
export type DiffKind = 'same' | 'add' | 'del' | 'skip';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Beyond this many lines on either side the diff is a plain replace, which keeps the table small. */
const MAX_LINES = 1200;

const split = (text: string): string[] => text.replace(/\r\n/g, '\n').split('\n');

/**
 * Line diff of two texts. The result is the before lines and after lines in order, each marked kept,
 * added or removed, the way a side-by-side reviewer expects to read it top to bottom.
 */
export const diffLines = (before: string, after: string): DiffLine[] => {
  const a = split(before);
  const b = split(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const removed = a.map((text): DiffLine => ({ kind: 'del', text }));
    const added = b.map((text): DiffLine => ({ kind: 'add', text }));
    return [...removed, ...added];
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: 'del', text: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: 'add', text: b[j]! });
    j += 1;
  }
  return out;
};

/** How many lines were added and removed, for the summary above the diff. */
export const diffCount = (lines: DiffLine[]): { added: number; removed: number } => ({
  added: lines.filter((line) => line.kind === 'add').length,
  removed: lines.filter((line) => line.kind === 'del').length,
});

/** The changed lines with `context` lines around each change; every longer run of unchanged lines becomes one `skip` line. */
export const withContext = (lines: DiffLine[], context = 3): DiffLine[] => {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let at = Math.max(0, index - context); at <= Math.min(lines.length - 1, index + context); at += 1) keep[at] = true;
  });
  const out: DiffLine[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (hidden > 0) out.push({ kind: 'skip', text: `${hidden} unchanged ${hidden === 1 ? 'line' : 'lines'}` });
      hidden = 0;
      out.push(line);
    } else hidden += 1;
  });
  if (hidden > 0) out.push({ kind: 'skip', text: `${hidden} unchanged ${hidden === 1 ? 'line' : 'lines'}` });
  return out;
};

export interface ManifestDoc {
  /** `Kind/name` and the namespace when it has one. Documents are matched on this. */
  key: string;
  text: string;
}

const SEPARATOR = /^---\s*(#.*)?$/;

/** A rendered manifest as its documents. Comments (such as `# Source:`) are left out: they say nothing about the cluster. */
export const manifestDocs = (manifest: string): ManifestDoc[] => {
  const chunks: string[][] = [[]];
  for (const line of manifest.replace(/\r\n/g, '\n').split('\n')) {
    if (SEPARATOR.test(line)) chunks.push([]);
    else chunks[chunks.length - 1]!.push(line);
  }
  const docs: ManifestDoc[] = [];
  chunks.forEach((lines, index) => {
    const text = lines.filter((line) => !line.trim().startsWith('#')).join('\n').trim();
    if (!text) return;
    let key = `Document ${index}`;
    const parsed = parseDocument(text);
    if (parsed.errors.length === 0) {
      const value = parsed.toJS() as { kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } } | null;
      if (value && typeof value.kind === 'string' && typeof value.metadata?.name === 'string') {
        key = `${value.kind}/${value.metadata.name}${typeof value.metadata.namespace === 'string' ? ` in ${value.metadata.namespace}` : ''}`;
      }
    }
    docs.push({ key, text });
  });
  return docs;
};

export interface ManifestChange {
  key: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface ManifestDiff {
  added: string[];
  removed: string[];
  changed: ManifestChange[];
  unchanged: number;
  /** Some changed documents were left out to keep the answer small. */
  truncated: boolean;
}

const MAX_CHANGED_DOCS = 60;
const MAX_CHANGE_LINES = 300;

/** What differs between two manifests, document by document: added and removed documents by name, changed ones as short line diffs. */
export const diffManifests = (before: string, after: string, context = 3): ManifestDiff => {
  const a = new Map(manifestDocs(before).map((doc) => [doc.key, doc.text]));
  const b = new Map(manifestDocs(after).map((doc) => [doc.key, doc.text]));
  const added = [...b.keys()].filter((key) => !a.has(key));
  const removed = [...a.keys()].filter((key) => !b.has(key));
  const changed: ManifestChange[] = [];
  let unchanged = 0;
  let truncated = false;
  for (const [key, text] of b) {
    const old = a.get(key);
    if (old === undefined) continue;
    if (old === text) {
      unchanged += 1;
      continue;
    }
    if (changed.length >= MAX_CHANGED_DOCS) {
      truncated = true;
      continue;
    }
    const lines = diffLines(old, text);
    const counts = diffCount(lines);
    const short = withContext(lines, context);
    if (short.length > MAX_CHANGE_LINES) truncated = true;
    changed.push({ key, ...counts, lines: short.slice(0, MAX_CHANGE_LINES) });
  }
  return { added, removed, changed, unchanged, truncated };
};
