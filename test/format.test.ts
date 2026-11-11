import { describe, expect, test } from 'bun:test';
import { ageText, bytesText, clipText, coresText, parseQuantity } from '../src/shared/format.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ago = (seconds: number): number => NOW - seconds * 1000;

describe('ageText', () => {
  test('uses kubectl style units', () => {
    expect(ageText(ago(0), NOW)).toBe('0s');
    expect(ageText(ago(45), NOW)).toBe('45s');
    expect(ageText(ago(119), NOW)).toBe('119s');
    expect(ageText(ago(5 * 60 + 12), NOW)).toBe('5m12s');
    expect(ageText(ago(90 * 60), NOW)).toBe('90m');
    expect(ageText(ago(3 * 3600 + 20 * 60), NOW)).toBe('3h20m');
    expect(ageText(ago(20 * 3600), NOW)).toBe('20h');
    expect(ageText(ago(3 * 86400 + 4 * 3600), NOW)).toBe('3d4h');
    expect(ageText(ago(54 * 86400), NOW)).toBe('54d');
    expect(ageText(ago(400 * 86400), NOW)).toBe('1y35d');
    expect(ageText(ago(2 * 86400), NOW)).toBe('2d');
    expect(ageText(ago(4 * 3600), NOW)).toBe('4h');
    expect(ageText(ago(5 * 60), NOW)).toBe('5m');
    expect(ageText(ago(365 * 86400), NOW)).toBe('1y');
  });

  test('a time in the future reads as zero, a missing time as nothing', () => {
    expect(ageText(NOW + 5000, NOW)).toBe('0s');
    expect(ageText(null, NOW)).toBe('');
    expect(ageText(undefined, NOW)).toBe('');
  });
});

describe('quantities', () => {
  test('parses CPU, bytes and plain numbers', () => {
    expect(parseQuantity('500m')).toBe(0.5);
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('1930m')).toBeCloseTo(1.93);
    expect(parseQuantity('1Gi')).toBe(1024 ** 3);
    expect(parseQuantity('128974848')).toBe(128974848);
    expect(parseQuantity('129e6')).toBe(129e6);
    expect(parseQuantity('5G')).toBe(5e9);
  });

  test('refuses what is not a quantity', () => {
    expect(parseQuantity('lots')).toBeNull();
    expect(parseQuantity(undefined)).toBeNull();
    expect(parseQuantity('')).toBeNull();
  });

  test('formats bytes and cores', () => {
    expect(bytesText(0)).toBe('0 B');
    expect(bytesText(1536)).toBe('1.5 KiB');
    expect(bytesText(16 * 1024 ** 3)).toBe('16 GiB');
    expect(bytesText(null)).toBe('');
    expect(coresText(15.8899)).toBe('15.89');
    expect(coresText(4)).toBe('4');
  });

  test('clipText keeps short text and cuts long text', () => {
    expect(clipText('abc', 10)).toBe('abc');
    expect(clipText('abcdefghij', 6)).toBe('abc...');
  });
});
