import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, readLocks, readPicks, stateDir, updateJson, writeJson, writeLocks, writePick } from '../src/service/state.ts';
import { emptyLocks, unlock } from '../src/shared/locks.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'k8s-state-'));
  process.env.K8S_STATE_DIR = join(dir, 'state');
});
afterAll(() => {
  delete process.env.K8S_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('state files', () => {
  test('the folder is 0700 and files are 0600', () => {
    writeJson('x.json', { a: 1 });
    expect(statSync(stateDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir(), 'x.json')).mode & 0o777).toBe(0o600);
  });

  test('a write leaves no temp file behind', () => {
    writeJson('y.json', { a: 1 });
    writeJson('y.json', { a: 2 });
    expect(readdirSync(stateDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a missing or damaged file reads as the fallback', () => {
    expect(readLocks()).toEqual(emptyLocks());
    writeJson('locks.json', 'garbage');
    expect(readLocks()).toEqual(emptyLocks());
  });

  test('locks round-trip', () => {
    const now = Date.now();
    writeLocks(unlock(emptyLocks(), 'prod-a', now));
    expect(readLocks().unlocked['prod-a']).toBeDefined();
  });

  test('picks are kept per project', () => {
    writePick('/a', { context: 'one', namespace: null, pickedAt: 't' });
    writePick('/b', { context: 'two', namespace: 'gm', pickedAt: 't' });
    expect(Object.keys(readPicks()).sort()).toEqual(['/a', '/b']);
  });

  test('updateJson changes what is there', () => {
    writeJson('n.json', { n: 1 });
    expect(updateJson('n.json', { n: 0 }, (c) => ({ n: c.n + 1 })).n).toBe(2);
  });

  test('the audit log is one JSON line per write, mode 0600, with no payload', () => {
    appendAudit({ project: '/a', context: 'stg', verb: 'scale to 2', target: 'Deployment/api in gm', source: 'panel' });
    appendAudit({ project: null, context: 'stg', verb: 'delete', target: 'Pod/x in gm', source: 'agent' });
    const file = join(stateDir(), 'audit.log');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(Object.keys(lines[0]!).sort()).toEqual(['context', 'project', 'source', 'target', 'time', 'verb']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
