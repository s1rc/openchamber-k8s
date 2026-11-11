import { describe, expect, test } from 'bun:test';
import { emptyLocks, guessProtected, isLocked, isProtected, lock, normalizeLocks, setProtected, unlock, unlockedUntil, UNLOCK_MS } from '../src/shared/locks.ts';

const now = Date.parse('2026-11-11T10:00:00Z');
const prod = 'arn:aws:eks:us-east-1:987654321098:cluster/initech-production';

describe('production guess', () => {
  test('matches the name or the ARN, case-insensitive', () => {
    expect(guessProtected('initech-production-us-east-1')).toBe(true);
    expect(guessProtected('northwind-PROD-eks')).toBe(true);
    expect(guessProtected('alias', prod)).toBe(true);
    expect(guessProtected('initech-staging-us-east-1', 'arn:aws:eks:us-east-1:987654321098:cluster/initech-staging')).toBe(false);
  });
});

describe('lock state', () => {
  test('production is locked by default, staging is not', () => {
    expect(isLocked(emptyLocks(), 'initech-production-us-east-1', prod, now)).toBe(true);
    expect(isLocked(emptyLocks(), 'initech-staging-us-east-1', null, now)).toBe(false);
  });

  test('unlock lasts 30 minutes, then the lock returns', () => {
    const open = unlock(emptyLocks(), 'prod-a', now);
    expect(unlockedUntil(open, 'prod-a', now)).toBe(now + UNLOCK_MS);
    expect(isLocked(open, 'prod-a', null, now + UNLOCK_MS - 1)).toBe(false);
    expect(isLocked(open, 'prod-a', null, now + UNLOCK_MS)).toBe(true);
  });

  test('Lock now ends an unlock', () => {
    const open = unlock(emptyLocks(), 'prod-a', now);
    expect(isLocked(lock(open, 'prod-a'), 'prod-a', null, now + 1000)).toBe(true);
  });

  test('an unlock on one context does not open another', () => {
    const open = unlock(emptyLocks(), 'prod-a', now);
    expect(isLocked(open, 'prod-b', null, now)).toBe(true);
  });

  test('the user override beats the guess both ways', () => {
    expect(isProtected(setProtected(emptyLocks(), 'prod-a', false), 'prod-a')).toBe(false);
    expect(isProtected(setProtected(emptyLocks(), 'staging', true), 'staging')).toBe(true);
  });

  test('protecting a context with an unlock ends the unlock only when turned off', () => {
    const open = unlock(emptyLocks(), 'prod-a', now);
    expect(unlockedUntil(setProtected(open, 'prod-a', false), 'prod-a', now)).toBeNull();
  });

  test('a damaged file reads as empty', () => {
    expect(normalizeLocks('nope')).toEqual(emptyLocks());
    expect(normalizeLocks({ protected: 3, unlocked: null })).toEqual(emptyLocks());
  });
});
