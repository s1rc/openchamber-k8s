import { describe, expect, test } from 'bun:test';
import { diffCount, diffLines, diffManifests, withContext } from '../src/shared/diff.ts';

describe('diffLines', () => {
  test('keeps equal lines and marks one change', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc');
    expect(lines.map((line) => `${line.kind}:${line.text}`)).toEqual(['same:a', 'del:b', 'add:B', 'same:c']);
    expect(diffCount(lines)).toEqual({ added: 1, removed: 1 });
  });

  test('handles an added line at the end', () => {
    const lines = diffLines('a', 'a\nb');
    expect(lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });

  test('handles a removed line at the start', () => {
    const lines = diffLines('gone\na', 'a');
    expect(lines[0]).toEqual({ kind: 'del', text: 'gone' });
    expect(lines[1]).toEqual({ kind: 'same', text: 'a' });
  });

  test('identical text has no changes', () => {
    const lines = diffLines('a\nb', 'a\nb');
    expect(diffCount(lines)).toEqual({ added: 0, removed: 0 });
    expect(lines.length).toBe(2);
  });

  test('normalizes CRLF', () => {
    expect(diffCount(diffLines('a\r\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 });
  });

  test('a very long pair falls back to replace, without hanging', () => {
    const before = Array.from({ length: 1300 }, (_, at) => `line ${at}`).join('\n');
    const after = Array.from({ length: 1300 }, (_, at) => `other ${at}`).join('\n');
    const lines = diffLines(before, after);
    expect(lines.length).toBe(2600);
    expect(diffCount(lines)).toEqual({ added: 1300, removed: 1300 });
  });
});

describe('withContext', () => {
  test('keeps lines around a change and folds the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'LINE 10');
    const lines = withContext(diffLines(before, after), 2);
    expect(lines.map((line) => line.kind)).toEqual(['skip', 'same', 'same', 'del', 'add', 'same', 'same', 'skip']);
    expect(lines[0]!.text).toBe('8 unchanged lines');
  });

  test('a diff with no change is empty', () => {
    expect(withContext(diffLines('a\nb', 'a\nb'))).toEqual([{ kind: 'skip', text: '2 unchanged lines' }]);
  });
});

describe('diffManifests', () => {
  const doc = (kind: string, name: string, extra = ''): string => `---\n# Source: x/${name}.yaml\napiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n${extra}`;

  test('names added and removed documents and diffs changed ones', () => {
    const before = [doc('ConfigMap', 'a', 'data:\n  k: one\n'), doc('Service', 'gone'), doc('Deployment', 'same')].join('');
    const after = [doc('ConfigMap', 'a', 'data:\n  k: two\n'), doc('Deployment', 'same'), doc('Ingress', 'new')].join('');
    const result = diffManifests(before, after);
    expect(result.added).toEqual(['Ingress/new']);
    expect(result.removed).toEqual(['Service/gone']);
    expect(result.unchanged).toBe(1);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({ key: 'ConfigMap/a', added: 1, removed: 1 });
    expect(result.changed[0]!.lines.some((line) => line.kind === 'add' && line.text.includes('two'))).toBe(true);
  });

  test('ignores comments and the order of documents', () => {
    const one = doc('ConfigMap', 'a') + doc('Service', 'b');
    const two = doc('Service', 'b').replace('x/b.yaml', 'other/b.yaml') + doc('ConfigMap', 'a');
    const result = diffManifests(one, two);
    expect(result).toEqual({ added: [], removed: [], changed: [], unchanged: 2, truncated: false });
  });

  test('keeps the namespace in the name of a document', () => {
    const result = diffManifests('', doc('Service', 'b', '  namespace: prod\n'));
    expect(result.added).toEqual(['Service/b in prod']);
  });
});
