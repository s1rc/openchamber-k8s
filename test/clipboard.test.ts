import { describe, expect, test } from 'bun:test';
import { CLIPBOARD_MAX, splitForClipboard } from '../src/shared/clipboard.ts';

const doc = (name: string, lines = 40): string => `---\n# Source: x/${name}.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\ndata:\n${Array.from({ length: lines }, (_, i) => `  key${i}: value-${name}-${i}`).join('\n')}`;

describe('splitForClipboard', () => {
  test('text that fits is one part, unchanged', () => {
    expect(splitForClipboard('a\nb')).toEqual(['a\nb']);
    expect(splitForClipboard('')).toEqual(['']);
  });

  test('every part fits the host limit and nothing is lost or reordered', () => {
    const text = Array.from({ length: 60 }, (_, i) => doc(`d${i}`, 60)).join('\n');
    expect(text.length).toBeGreaterThan(CLIPBOARD_MAX * 2);
    const parts = splitForClipboard(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(CLIPBOARD_MAX);
    expect(parts.join('\n')).toBe(text);
  });

  test('parts break between documents, so each starts with ---', () => {
    const text = Array.from({ length: 40 }, (_, i) => doc(`d${i}`, 60)).join('\n');
    const parts = splitForClipboard(text);
    for (const part of parts) expect(part.startsWith('---')).toBe(true);
  });

  test('one document longer than the limit is cut between lines', () => {
    const text = doc('big', 3000);
    const parts = splitForClipboard(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(CLIPBOARD_MAX);
    expect(parts.join('\n')).toBe(text);
  });

  test('a single line longer than the limit is cut to fit rather than failing', () => {
    const parts = splitForClipboard(`a: ${'x'.repeat(70_000)}`);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(CLIPBOARD_MAX);
  });
});
