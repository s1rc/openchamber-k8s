import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth, outcomeOf, type AuthView } from '../src/service/auth.ts';
import { scrub } from '../src/service/errors.ts';

let dir: string;
let counter = 0;
let announced: AuthView[];
let done: AuthView[];

/** A small shell script standing in for aws or kubectl: no browser, no network. */
const script = (body: string): string => {
  const file = join(dir, `s${counter++}.sh`);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

const make = (timeoutMs = 10_000) =>
  createAuth({
    now: Date.now,
    timeoutMs,
    announce: (view) => announced.push({ ...view }),
    onDone: (view) => done.push({ ...view }),
  });

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check() && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!check()) throw new Error('timed out waiting');
};

const request = (file: string, extra: Record<string, unknown> = {}) => ({
  kind: 'sso' as const,
  key: 'sso:p',
  profile: 'p',
  context: 'c1',
  contexts: ['c1', 'c2'],
  file,
  args: [],
  ...extra,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'k8s-auth-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  announced = [];
  done = [];
});

describe('outcomeOf', () => {
  test('exit 0 is a sign-in', () => {
    expect(outcomeOf('sso', 0, '')).toEqual({ ok: true });
    expect(outcomeOf('oidc', 0, '')).toEqual({ ok: true });
  });
  test('kubectl saying Forbidden means the login worked and the account just cannot list namespaces', () => {
    expect(outcomeOf('oidc', 1, 'Error from server (Forbidden): namespaces is forbidden: User "a@b" cannot list resource "namespaces"')).toEqual({ ok: true });
    expect(outcomeOf('sso', 1, 'forbidden')).toMatchObject({ ok: false });
  });
  test('an OIDC login that is still expired, an unreachable cluster, and a missing program say so', () => {
    expect(outcomeOf('oidc', 1, 'error: You must be logged in to the server (Unauthorized)')).toMatchObject({ ok: false, error: 'The sign-in did not finish. Try again.' });
    expect(outcomeOf('oidc', 1, 'Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout')).toMatchObject({ ok: false, error: expect.stringContaining('not reachable') });
    expect(outcomeOf('oidc', 1, 'getting credentials: exec: executable kubectl-oidc_login not found')).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
  });
  test('another failure shows a short scrubbed line', () => {
    const result = outcomeOf('sso', 1, 'Missing the following required SSO configuration: sso_start_url https://x.example/start AKIAABCDEFGHIJKLMNOP');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).not.toMatch(/AKIA|https/);
  });
});

describe('scrub', () => {
  test('hides keys, links and tokens', () => {
    const out = scrub('a eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl b AKIAABCDEFGHIJKLMNOP c https://x.example/p?q=1 d QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm');
    expect(out).not.toMatch(/eyJ|AKIA|https|QUJD/);
    expect(out).toContain('<token>');
    expect(out).toContain('<key id>');
  });
  test('leaves ordinary words alone', () => {
    expect(scrub('The SSO session associated with this profile has expired')).toBe('The SSO session associated with this profile has expired');
    expect(scrub('arn:aws:eks:us-east-1:987654321098:cluster/initech-staging')).toContain('initech-staging');
  });
});

describe('sign-in process', () => {
  test('a login that finishes is done, with the link it printed and the contexts that get their login back', async () => {
    const auth = make();
    const view = auth.start(request(script('echo "Open https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH"; sleep 0.2; exit 0')));
    expect(view).toMatchObject({ state: 'running', kind: 'sso', profile: 'p', context: 'c1', contexts: ['c1', 'c2'] });
    await until(() => done.length === 1);
    expect(done[0]).toMatchObject({ state: 'done', id: view.id, contexts: ['c1', 'c2'] });
    expect(done[0]?.url).toBe('https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH');
    expect(announced.map((entry) => entry.state)).toEqual(['running', 'running', 'done']);
    expect(auth.list()[0]?.state).toBe('done');
  });

  test('a login that fails says why, from the error lines and not from the greeting printed first', async () => {
    const auth = make();
    auth.start(request(script('echo "Attempting to automatically open the SSO authorization page in your default browser."; echo "Error: Missing the following required SSO configuration: sso_region" >&2; exit 253')));
    await until(() => announced.some((entry) => entry.state === 'failed'));
    const failed = announced.find((entry) => entry.state === 'failed')!;
    expect(failed.error).toContain('Missing the following required SSO configuration');
    expect(failed.error).not.toContain('Attempting');
    expect(done).toEqual([]);
  });

  test('with no error lines, the last lines of the output give the reason', async () => {
    const auth = make();
    auth.start(request(script('echo one; echo two; echo three; exit 1')));
    await until(() => announced.some((entry) => entry.state === 'failed'));
    expect(announced.find((entry) => entry.state === 'failed')?.error).toBe('two three');
  });

  test('two requests for the same profile run one program and share the sign-in', async () => {
    const auth = make();
    const marker = join(dir, `count-${counter}`);
    const file = script(`echo x >> "${marker}"; sleep 0.3`);
    const first = auth.start(request(file));
    const second = auth.start(request(file));
    expect(second.id).toBe(first.id);
    expect(second.joined).toBe(true);
    await until(() => done.length === 1);
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(done).toHaveLength(1);
  });

  test('different profiles sign in side by side', async () => {
    const auth = make();
    const a = auth.start(request(script('sleep 0.2'), { key: 'sso:a', profile: 'a' }));
    const b = auth.start(request(script('sleep 0.2'), { key: 'sso:b', profile: 'b' }));
    expect(a.id).not.toBe(b.id);
    await until(() => done.length === 2);
  });

  test('cancel stops the program and says cancelled, not failed', async () => {
    const auth = make();
    const pidFile = join(dir, `pid-${counter}`);
    const view = auth.start(request(script(`echo $$ > "${pidFile}"; sleep 30`)));
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const cancelled = auth.cancel(view.id);
    expect(cancelled?.state).toBe('cancelled');
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(done).toEqual([]);
    expect(announced.at(-1)?.state).toBe('cancelled');
  });

  test('a sign-in that waits too long is stopped and says so', async () => {
    const auth = make(250);
    auth.start(request(script('sleep 30')));
    await until(() => announced.some((entry) => entry.state === 'timeout'), 4000);
    expect(announced.find((entry) => entry.state === 'timeout')?.error).toMatch(/not finished in/);
  });

  test('after one ends the same profile can sign in again', async () => {
    const auth = make();
    const first = auth.start(request(script('exit 0')));
    await until(() => done.length === 1);
    const second = auth.start(request(script('exit 0')));
    expect(second.id).not.toBe(first.id);
    expect(second.joined).toBeUndefined();
    await until(() => done.length === 2);
  });

  test('a program that cannot start is a failed sign-in', async () => {
    const auth = make();
    auth.start(request(join(dir, 'no-such-program')));
    await until(() => announced.some((entry) => entry.state === 'failed'));
    expect(announced.find((entry) => entry.state === 'failed')?.error).toMatch(/not found/);
  });

  test('an OIDC check that ends in Forbidden counts as signed in', async () => {
    const auth = make();
    auth.start({ ...request(script('echo "Error from server (Forbidden): namespaces is forbidden" >&2; exit 1')), kind: 'oidc', key: 'oidc:x', profile: undefined });
    await until(() => done.length === 1);
    expect(done[0]?.kind).toBe('oidc');
  });

  test('cancel for an unknown id answers null, and a finished one is left as it was', async () => {
    const auth = make();
    expect(auth.cancel('nope')).toBeNull();
    const view = auth.start(request(script('exit 0')));
    await until(() => done.length === 1);
    expect(auth.cancel(view.id)?.state).toBe('done');
  });

  test('the view holds no program output', async () => {
    const auth = make();
    auth.start(request(script('echo "secret-looking-output"; exit 0')));
    await until(() => done.length === 1);
    expect(JSON.stringify(announced)).not.toContain('secret-looking-output');
  });
});
