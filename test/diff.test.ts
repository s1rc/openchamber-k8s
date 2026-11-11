import { describe, expect, test } from 'bun:test';
import { diffCount, diffLines } from '../src/app/detail/diff.ts';

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
