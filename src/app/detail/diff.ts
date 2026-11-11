// A small line diff for the YAML editor. Enough to show what a change does, no dependency.

export type DiffKind = 'same' | 'add' | 'del';

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
