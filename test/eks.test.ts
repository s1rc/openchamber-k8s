import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aliasProblem,
  contextFor,
  isAlias,
  isClusterName,
  isProfileName,
  isRegion,
  signInPlan,
  signInText,
  signInUrl,
  suggestAlias,
  updateKubeconfigCommand,
  type AwsProfile,
} from '../src/shared/eks.ts';
import { addToKubeconfig, classifyAwsFailure, createDiscovery, FAILED_MS, FRESH_MS, kubeconfigTarget, planDiscovery, type DiscoverDeps } from '../src/service/eks.ts';
import type { RunResult } from '../src/service/exec.ts';
import { K8sError } from '../src/service/errors.ts';
import type { ContextInfo } from '../src/shared/types.ts';

const sso = (accountId: string, region: string | null = 'us-east-1'): AwsProfile => ({ accountId, region, auth: 'sso' });
const keys = (region: string | null = 'us-east-1'): AwsProfile => ({ accountId: null, region, auth: 'keys' });

describe('names that reach a command line', () => {
  test('profiles', () => {
    for (const ok of ['default', 'nw-management-poweruser', 'compliance_development', 'a.b@c', 'p1']) expect(isProfileName(ok)).toBe(true);
    for (const bad of ['', '-x', '--profile', 'a b', 'a;b', 'a$(x)', 'a\nb', "a'b", 'a/b', 'x'.repeat(200), 1, null]) expect(isProfileName(bad)).toBe(false);
  });
  test('regions', () => {
    for (const ok of ['us-east-1', 'ap-southeast-2', 'eu-central-1', 'us-gov-west-1', 'cn-north-1']) expect(isRegion(ok)).toBe(true);
    for (const bad of ['', '-us-east-1', 'us-east', 'US-EAST-1', 'us-east-1;ls', 'us east 1', '--region']) expect(isRegion(bad)).toBe(false);
  });
  test('cluster names and aliases', () => {
    for (const ok of ['initech-staging', 'a', 'prod_1']) expect(isClusterName(ok)).toBe(true);
    for (const bad of ['', '-x', 'a b', 'a.b', 'a/b', 'a'.repeat(101)]) expect(isClusterName(bad)).toBe(false);
    for (const ok of ['initech-staging-us-east-1', 'a.b_c@d', 'x']) expect(isAlias(ok)).toBe(true);
    for (const bad of ['', '-x', '--alias', 'a b', 'a;b', 'a`b`', 'a$b', 'a/b', 'a:b']) expect(isAlias(bad)).toBe(false);
  });
});

describe('updateKubeconfigCommand', () => {
  const good = { name: 'initech-staging', region: 'us-east-1', profile: 'default', alias: 'initech-staging-us-east-1' };

  test('builds the exact command from the plan', () => {
    const command = updateKubeconfigCommand(good);
    expect(command).toEqual({
      ok: true,
      args: ['eks', 'update-kubeconfig', '--name', 'initech-staging', '--region', 'us-east-1', '--profile', 'default', '--alias', 'initech-staging-us-east-1'],
      text: 'aws eks update-kubeconfig --name initech-staging --region us-east-1 --profile default --alias initech-staging-us-east-1',
    });
  });

  test('adds a kubeconfig path, quoted in the text and raw in the arguments', () => {
    const command = updateKubeconfigCommand({ ...good, kubeconfig: '/Users/a b/kube config' });
    expect(command.ok && command.args.slice(-2)).toEqual(['--kubeconfig', '/Users/a b/kube config']);
    expect(command.ok && command.text.endsWith("--kubeconfig '/Users/a b/kube config'")).toBe(true);
  });

  test.each([
    ['name', { name: '--version' }],
    ['name', { name: 'a b' }],
    ['region', { region: 'us-east-1 --profile x' }],
    ['region', { region: '-r' }],
    ['profile', { profile: '--endpoint-url=https://evil.example' }],
    ['profile', { profile: 'p;rm -rf' }],
    ['alias', { alias: '--role-arn' }],
    ['alias', { alias: 'a b' }],
    ['alias', { alias: '' }],
    ['kubeconfig', { kubeconfig: '-o' }],
    ['kubeconfig', { kubeconfig: '' }],
    ['kubeconfig', { kubeconfig: '/a\nb' }],
  ])('refuses a bad %s', (_what, change) => {
    expect(updateKubeconfigCommand({ ...good, ...change }).ok).toBe(false);
  });

  test('a missing field is refused, never turned into "undefined"', () => {
    expect(updateKubeconfigCommand({ ...good, profile: undefined }).ok).toBe(false);
    expect(updateKubeconfigCommand({}).ok).toBe(false);
  });
});

describe('signInPlan', () => {
  const profiles: Record<string, AwsProfile> = { sso1: sso('111111111111'), keys1: keys(), role1: { accountId: null, region: null, auth: 'role' }, default: keys() };

  test('OIDC contexts sign in through kubelogin', () => {
    expect(signInPlan({ auth: 'oidc', awsProfile: null }, profiles)).toEqual({ kind: 'oidc' });
  });
  test('an SSO profile can sign in', () => {
    expect(signInPlan({ auth: 'aws', awsProfile: 'sso1' }, profiles)).toEqual({ kind: 'sso', profile: 'sso1' });
  });
  test('a context with no profile uses AWS_PROFILE, then default', () => {
    expect(signInPlan({ auth: 'aws', awsProfile: null }, profiles, 'sso1')).toEqual({ kind: 'sso', profile: 'sso1' });
    expect(signInPlan({ auth: 'aws', awsProfile: null }, profiles)).toEqual({ kind: 'none', profile: 'default', reason: 'keys' });
  });
  test('keys, roles, a missing profile and other programs cannot sign in here', () => {
    expect(signInPlan({ auth: 'aws', awsProfile: 'keys1' }, profiles)).toEqual({ kind: 'none', profile: 'keys1', reason: 'keys' });
    expect(signInPlan({ auth: 'aws', awsProfile: 'role1' }, profiles)).toEqual({ kind: 'none', profile: 'role1', reason: 'other' });
    expect(signInPlan({ auth: 'aws', awsProfile: 'gone' }, profiles)).toEqual({ kind: 'none', profile: 'gone', reason: 'missing' });
    expect(signInPlan({ auth: 'other', awsProfile: null }, profiles)).toEqual({ kind: 'none', profile: null, reason: 'other' });
    expect(signInPlan({ auth: 'none', awsProfile: null }, profiles)).toEqual({ kind: 'none', profile: null, reason: 'other' });
  });
  test('a profile name that could not be a safe argument never gets a Sign in', () => {
    expect(signInPlan({ auth: 'aws', awsProfile: '--x' }, { '--x': sso('111111111111') }).kind).toBe('none');
  });
  test('the words never mention a terminal and hold no dash', () => {
    for (const plan of [null, { kind: 'sso', profile: 'p' }, { kind: 'oidc' }, { kind: 'none', profile: 'k', reason: 'keys' }, { kind: 'none', profile: 'k', reason: 'missing' }, { kind: 'none', profile: null, reason: 'other' }] as const) {
      const text = signInText(plan);
      expect(text).not.toMatch(/terminal|\u2014|\u2013/i);
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

describe('aliases', () => {
  test('default is cluster and region, then the account, then the same name so the check can say it is taken', () => {
    expect(suggestAlias('initech-staging', 'us-east-1', '987654321098', new Set())).toBe('initech-staging-us-east-1');
    expect(suggestAlias('initech-staging', 'us-east-1', '987654321098', new Set(['initech-staging-us-east-1']))).toBe('initech-staging-us-east-1-987654321098');
    expect(suggestAlias('x', 'us-east-1', null, new Set(['x-us-east-1']))).toBe('x-us-east-1');
  });
  test('a name that clashes with a context is a problem', () => {
    const taken = new Set(['a']);
    expect(aliasProblem('a', taken)).toMatch(/already/);
    expect(aliasProblem('b', taken)).toBeNull();
    expect(aliasProblem('', taken)).toMatch(/name/);
    expect(aliasProblem('--x', taken)).toMatch(/letters/);
  });
});

describe('contextFor', () => {
  const contexts = [
    { name: 'stg', clusterName: 'initech-staging', region: 'us-east-1', account: '987654321098' },
    { name: 'k', clusterName: 'kind', region: null, account: null },
  ];
  test('matches by name, region and account', () => {
    expect(contextFor({ name: 'initech-staging', region: 'us-east-1', accountId: '987654321098' }, contexts)).toBe('stg');
    expect(contextFor({ name: 'initech-staging', region: 'us-east-1', accountId: '111111111111' }, contexts)).toBeNull();
    expect(contextFor({ name: 'initech-staging', region: 'eu-west-1', accountId: '987654321098' }, contexts)).toBeNull();
  });
  test('an account that is not known does not block a match', () => {
    expect(contextFor({ name: 'initech-staging', region: 'us-east-1', accountId: null }, contexts)).toBe('stg');
  });
});

describe('signInUrl', () => {
  test('finds the AWS link the sign-in printed', () => {
    const out = 'Attempting to open your default browser.\nIf the browser does not open, open the following URL:\n\nhttps://oidc.us-east-1.amazonaws.com/authorize?response_type=code&state=abc\n';
    expect(signInUrl(out)).toBe('https://oidc.us-east-1.amazonaws.com/authorize?response_type=code&state=abc');
    expect(signInUrl('Open https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH.')).toBe('https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH');
    expect(signInUrl('go to https://mycorp.awsapps.com/start/#/device')).toBe('https://mycorp.awsapps.com/start/#/device');
  });
  test('ignores other hosts, plain http and look-alikes', () => {
    expect(signInUrl('https://evil.example/amazonaws.com')).toBeNull();
    expect(signInUrl('https://amazonaws.com.evil.example/x')).toBeNull();
    expect(signInUrl('http://oidc.us-east-1.amazonaws.com/x')).toBeNull();
    expect(signInUrl('no link here')).toBeNull();
  });
});

describe('classifyAwsFailure', () => {
  test.each([
    ['The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.', 'sso', 'signin'],
    ['Error loading SSO Token: Token for https://x.awsapps.com/start does not exist', 'sso', 'signin'],
    // Printed by aws-cli 2.40.1 for a profile whose SSO login does not exist (checked on this machine).
    ['aws: [ERROR]: Error loading SSO Token: Token for check does not exist', 'sso', 'signin'],
    ['Error when retrieving token from sso: Token has expired and refresh failed', 'sso', 'signin'],
    ['UnauthorizedSSOTokenError', 'sso', 'signin'],
    ['An error occurred (ExpiredToken) when calling the ListClusters operation: The security token included in the request is expired', 'keys', 'expired'],
    ['Unable to locate credentials. You can configure credentials by running "aws configure".', 'keys', 'expired'],
    ['An error occurred (AccessDeniedException) when calling the ListClusters operation: User: arn:aws:iam::1:user/x is not authorized to perform: eks:ListClusters', 'sso', 'denied'],
    ['An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid.', 'keys', 'error'],
    ['Could not connect to the endpoint URL: "https://eks.us-east-1.amazonaws.com/clusters"', 'sso', 'unreachable'],
    ['Connect timeout on endpoint URL', 'sso', 'unreachable'],
    ['something odd happened', 'sso', 'error'],
  ])('%s', (text, auth, status) => {
    expect(classifyAwsFailure(text, auth as AwsProfile['auth']).status).toBe(status as never);
  });

  test('says Sign in only for SSO, and never repeats a key id or a link', () => {
    expect(classifyAwsFailure('Token has expired', 'sso').status).toBe('signin');
    expect(classifyAwsFailure('Token has expired', 'keys').status).toBe('expired');
    const odd = classifyAwsFailure('weird failure AKIAABCDEFGHIJKLMNOP see https://x.example/secret?token=abc', 'keys');
    expect(odd.message).not.toMatch(/AKIA|https|secret/);
  });
});

describe('planDiscovery', () => {
  test('looks in the profile region and every kubeconfig region, and skips what has no credentials', () => {
    const { planned, skipped } = planDiscovery(
      { default: keys('us-east-1'), a: sso('111111111111', 'eu-west-1'), bare: { accountId: null, region: 'us-east-1', auth: 'none' }, '-bad': keys(), noregion: keys(null) },
      ['us-east-1', 'ap-southeast-2', 'not a region'],
    );
    expect(planned.map((item) => [item.name, item.regions])).toEqual([
      ['a', ['ap-southeast-2', 'eu-west-1', 'us-east-1']],
      ['default', ['ap-southeast-2', 'us-east-1']],
      ['noregion', ['ap-southeast-2', 'us-east-1']],
    ]);
    expect(skipped.map((item) => [item.profile, item.message])).toEqual([
      ['-bad', 'The name of this profile is not one this panel can use.'],
      ['bare', 'No credentials.'],
    ]);
  });
  test('a profile with no region and a kubeconfig with none has nothing to look in', () => {
    const { planned, skipped } = planDiscovery({ x: keys(null) }, []);
    expect(planned).toEqual([]);
    expect(skipped[0]?.message).toBe('No region to look in.');
  });
});

describe('discovery', () => {
  let dir: string;
  let clock = 1_000_000;
  let calls: string[][] = [];
  let answers: (args: string[]) => RunResult | Promise<RunResult>;
  let profiles: Record<string, AwsProfile>;
  let regions: string[];
  let events: Array<Record<string, unknown>>;
  let inFlight = 0;
  let peak = 0;

  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr: string): RunResult => ({ code: 255, stdout: '', stderr });
  const arg = (args: string[], flag: string): string => args[args.indexOf(flag) + 1] ?? '';

  const make = (extra: Partial<DiscoverDeps> = {}) =>
    createDiscovery(
      {
        aws: async (args) => {
          calls.push(args);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight -= 1;
          return answers(args);
        },
        profiles: () => profiles,
        kubeRegions: () => regions,
        now: () => clock,
        ...extra,
      },
      (event) => events.push(event),
    );

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'k8s-eks-'));
    process.env.OPENCHAMBER_SERVICE_DATA_DIR = dir;
  });
  afterAll(() => {
    delete process.env.OPENCHAMBER_SERVICE_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(join(dir, 'eks-discovery.json'), { force: true });
    clock = 1_000_000;
    calls = [];
    events = [];
    inFlight = 0;
    peak = 0;
    regions = ['us-east-1', 'ap-southeast-2'];
    profiles = { good: sso('111111111111'), expired: sso('222222222222'), keys1: keys(), bare: { accountId: null, region: 'us-east-1', auth: 'none' } };
    answers = (args) => {
      const profile = arg(args, '--profile');
      if (args[0] === 'sts') return ok('333333333333\n');
      if (profile === 'expired') return fail('The SSO session associated with this profile has expired or is otherwise invalid.');
      if (profile === 'keys1') return ok(JSON.stringify({ clusters: arg(args, '--region') === 'us-east-1' ? ['alpha'] : [] }));
      return ok(JSON.stringify({ clusters: [`${arg(args, '--region')}-one`.replace(/^/, 'c-'), 'bad name!'] }));
    };
  });

  test('asks each profile for each region, and one profile with an expired login for a Sign in, not a failure', async () => {
    const found = make();
    expect(found.start()).toEqual({ started: true });
    await found.idle();
    const state = found.state([], null, '/k');
    const byProfile = Object.fromEntries(state.profiles.map((view) => [view.profile, view]));
    expect(byProfile.good).toMatchObject({ status: 'ok', count: 2, accountId: '111111111111', signIn: false });
    expect(byProfile.expired).toMatchObject({ status: 'signin', signIn: true, count: 0 });
    expect(byProfile.keys1).toMatchObject({ status: 'ok', count: 1, accountId: '333333333333', signIn: false });
    expect(byProfile.bare).toMatchObject({ status: 'skipped', message: 'No credentials.' });
    expect(state.clusters.map((cluster) => `${cluster.profile}:${cluster.region}:${cluster.name}`)).toEqual(['good:ap-southeast-2:c-ap-southeast-2-one', 'good:us-east-1:c-us-east-1-one', 'keys1:us-east-1:alpha']);
    // The cluster found by the keys profile carries the account asked from STS.
    expect(state.clusters.find((cluster) => cluster.name === 'alpha')?.accountId).toBe('333333333333');
  });

  test('never asks for a profile without credentials, and stops asking regions once a login is expired', async () => {
    const found = make();
    found.start();
    await found.idle();
    expect(calls.some((args) => arg(args, '--profile') === 'bare')).toBe(false);
    expect(calls.filter((args) => arg(args, '--profile') === 'expired')).toHaveLength(1);
    expect(calls.filter((args) => arg(args, '--profile') === 'good')).toHaveLength(2);
  });

  test('every aws call is a read: list-clusters or get-caller-identity', async () => {
    const found = make();
    found.start();
    await found.idle();
    for (const args of calls) expect(['eks list-clusters', 'sts get-caller-identity']).toContain(`${args[0]} ${args[1]}`);
  });

  test('keeps the answer for an hour, then asks again', async () => {
    const found = make();
    found.start();
    await found.idle();
    const first = calls.length;
    expect(found.start()).toEqual({ started: false });
    clock += 30_000;
    expect(found.start()).toEqual({ started: false });
    expect(calls.length).toBe(first);
    clock += FRESH_MS;
    expect(found.start()).toEqual({ started: true });
    await found.idle();
    expect(calls.length).toBeGreaterThan(first);
  });

  test('a failed profile is tried again after a minute, and only that profile', async () => {
    const found = make();
    found.start();
    await found.idle();
    calls = [];
    clock += FAILED_MS + 1;
    answers = (args) => (arg(args, '--profile') === 'expired' ? ok(JSON.stringify({ clusters: ['signed-in'] })) : fail('should not be asked'));
    expect(found.start()).toEqual({ started: true });
    await found.idle();
    expect(new Set(calls.map((args) => arg(args, '--profile')))).toEqual(new Set(['expired']));
    const state = found.state([], null, '/k');
    expect(state.profiles.find((view) => view.profile === 'expired')?.status).toBe('ok');
    // The profiles that were not asked kept their answers.
    expect(state.clusters.some((cluster) => cluster.profile === 'good')).toBe(true);
    expect(state.clusters.some((cluster) => cluster.name === 'signed-in')).toBe(true);
  });

  test('refresh asks everything again; only asks one profile and keeps the rest', async () => {
    const found = make();
    found.start();
    await found.idle();
    calls = [];
    found.start({ refresh: true });
    await found.idle();
    expect(new Set(calls.map((args) => arg(args, '--profile')))).toEqual(new Set(['good', 'expired', 'keys1']));
    calls = [];
    found.start({ only: 'keys1' });
    await found.idle();
    expect(new Set(calls.map((args) => arg(args, '--profile')))).toEqual(new Set(['keys1']));
    expect(found.state([], null, '/k').clusters.some((cluster) => cluster.profile === 'good')).toBe(true);
  });

  test('a new region in the kubeconfig makes the kept answer stale', async () => {
    const found = make();
    found.start();
    await found.idle();
    expect(found.state([], null, '/k').fresh).toBe(true);
    clock += FAILED_MS + 1;
    expect(found.state([], null, '/k').fresh).toBe(false); // the expired login is asked again after a minute
    regions = [...regions, 'eu-west-1'];
    expect(found.state([], null, '/k').fresh).toBe(false);
    expect(found.start()).toEqual({ started: true });
  });

  test('a region that denies access still gives the other regions', async () => {
    answers = (args) => (arg(args, '--region') === 'ap-southeast-2' ? fail('An error occurred (AccessDeniedException): not authorized to perform: eks:ListClusters') : ok(JSON.stringify({ clusters: ['one'] })));
    profiles = { good: sso('111111111111') };
    const found = make();
    found.start();
    await found.idle();
    const view = found.state([], null, '/k').profiles[0]!;
    expect(view.status).toBe('ok');
    expect(view.message).toMatch(/1 of 2 regions could not be read/);
  });

  test('runs at most three profiles at once', async () => {
    profiles = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, sso(String(111111111111 + i))]));
    answers = () => ok(JSON.stringify({ clusters: [] }));
    const found = make();
    found.start();
    await found.idle();
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test('a second start while one runs starts nothing', async () => {
    const found = make();
    expect(found.start().started).toBe(true);
    expect(found.start().started).toBe(false);
    expect(found.isRunning()).toBe(true);
    await found.idle();
    expect(found.isRunning()).toBe(false);
  });

  test('announces progress and the end', async () => {
    const found = make();
    found.start();
    await found.idle();
    expect(events[0]).toEqual({ state: 'running', done: 0, total: 3 });
    expect(events.at(-1)).toMatchObject({ state: 'done' });
    expect(events.filter((event) => event.state === 'running').map((event) => event.done)).toEqual([0, 1, 2, 3]);
  });

  test('a throwing call becomes one profile failure, not a failed look', async () => {
    answers = (args) => {
      if (arg(args, '--profile') === 'good') throw new Error('boom');
      return ok(JSON.stringify({ clusters: [] }));
    };
    const found = make();
    found.start();
    await found.idle();
    const state = found.state([], null, '/k');
    expect(state.profiles.find((view) => view.profile === 'good')).toMatchObject({ status: 'error', message: 'boom' });
    expect(state.profiles.find((view) => view.profile === 'keys1')?.status).toBe('ok');
  });

  test('joins the kubeconfig: the cluster that is already there says so, and new ones get an alias that is free', async () => {
    profiles = { good: sso('111111111111') };
    answers = (args) => ok(JSON.stringify({ clusters: arg(args, '--region') === 'us-east-1' ? ['stg', 'other'] : [] }));
    regions = ['us-east-1'];
    const found = make();
    found.start();
    await found.idle();
    const contexts = [
      { name: 'my-stg', clusterName: 'stg', region: 'us-east-1', account: '111111111111' },
      { name: 'other-us-east-1', clusterName: 'something', region: 'us-east-1', account: '999999999999' },
    ] as ContextInfo[];
    const state = found.state(contexts, null, '/k');
    const stg = state.clusters.find((cluster) => cluster.name === 'stg')!;
    const other = state.clusters.find((cluster) => cluster.name === 'other')!;
    expect(stg.context).toBe('my-stg');
    expect(other.context).toBeNull();
    // `other-us-east-1` is taken by another cluster, so the offer carries the account.
    expect(other.alias).toBe('other-us-east-1-111111111111');
    expect(state.taken).toEqual(['my-stg', 'other-us-east-1']);
  });

  test('the same cluster seen through two profiles is listed once', async () => {
    profiles = { a: sso('111111111111'), b: sso('111111111111') };
    answers = () => ok(JSON.stringify({ clusters: ['shared'] }));
    regions = ['us-east-1'];
    const found = make();
    found.start();
    await found.idle();
    const state = found.state([], null, '/k');
    expect(state.clusters).toHaveLength(1);
    expect(state.clusters[0]?.profile).toBe('a');
  });

  test('the kept file holds names and numbers, never a key or a link', async () => {
    answers = (args) => (arg(args, '--profile') === 'expired' ? fail('Token has expired. AKIAABCDEFGHIJKLMNOP https://x.example/y') : ok(JSON.stringify({ clusters: ['a'] })));
    const found = make();
    found.start();
    await found.idle();
    const raw = readFileSync(join(dir, 'eks-discovery.json'), 'utf8');
    expect(raw).not.toMatch(/AKIA|https:/);
  });
});

describe('addToKubeconfig', () => {
  const profiles: Record<string, AwsProfile> = { default: keys(), none: { accountId: null, region: null, auth: 'none' }, ssoP: sso('111111111111') };
  const request = { name: 'initech-staging', region: 'us-east-1', profile: 'default', alias: 'initech-staging-us-east-1' };
  const text = 'aws eks update-kubeconfig --name initech-staging --region us-east-1 --profile default --alias initech-staging-us-east-1';
  let ran: string[][] = [];
  const deps = (result: RunResult = { code: 0, stdout: 'Added new context arn:aws:eks:us-east-1:1:cluster/x to /tmp/k\n', stderr: '' }, existing: string[] = []) => ({
    aws: async (args: string[]) => {
      ran.push(args);
      return result;
    },
    contexts: async () => existing.map((name) => ({ name }) as ContextInfo),
    profiles: () => profiles,
  });
  beforeEach(() => {
    ran = [];
  });

  test('runs exactly the confirmed command', async () => {
    const done = await addToKubeconfig(deps(), request, text);
    expect(ran).toEqual([['eks', 'update-kubeconfig', '--name', 'initech-staging', '--region', 'us-east-1', '--profile', 'default', '--alias', 'initech-staging-us-east-1']]);
    expect(done.command).toBe(text);
  });

  test('refuses without the confirmed text, or when it differs', async () => {
    await expect(addToKubeconfig(deps(), request, undefined)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(addToKubeconfig(deps(), request, `${text} --alias other`)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ran).toEqual([]);
  });

  test('refuses an alias that is a context already, read fresh', async () => {
    await expect(addToKubeconfig(deps(undefined, ['initech-staging-us-east-1']), request, text)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('already have') });
    expect(ran).toEqual([]);
  });

  test('refuses bad arguments before any program runs', async () => {
    for (const bad of [{ name: '--x' }, { region: 'x' }, { profile: '-p' }, { alias: 'a b' }, { profile: undefined }]) {
      await expect(addToKubeconfig(deps(), { ...request, ...bad }, text)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(ran).toEqual([]);
  });

  test('refuses a profile that has no credentials or is not in the config', async () => {
    await expect(addToKubeconfig(deps(), { ...request, profile: 'none' }, text.replace('default', 'none'))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(addToKubeconfig(deps(), { ...request, profile: 'gone' }, text.replace('default', 'gone'))).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('not in your AWS config') });
    expect(ran).toEqual([]);
  });

  test('says Sign in for an expired SSO profile, and what is wrong otherwise', async () => {
    const sso1 = text.replace('default', 'ssoP');
    const expired = await addToKubeconfig(deps({ code: 255, stdout: '', stderr: 'The SSO session associated with this profile has expired' }), { ...request, profile: 'ssoP' }, sso1).catch((error: unknown) => error as K8sError);
    expect(expired).toMatchObject({ code: 'AUTH_EXPIRED', action: { kind: 'sign-in', profile: 'ssoP' } });
    const denied = await addToKubeconfig(deps({ code: 255, stdout: '', stderr: 'AccessDeniedException: not authorized' }), request, text).catch((error: unknown) => error as K8sError);
    expect(denied).toMatchObject({ code: 'FORBIDDEN' });
    const net = await addToKubeconfig(deps({ code: 255, stdout: '', stderr: 'Could not connect to the endpoint URL' }), request, text).catch((error: unknown) => error as K8sError);
    expect(net).toMatchObject({ code: 'UNREACHABLE' });
  });

  test('adds the project kubeconfig to the command and to the text that must be confirmed', async () => {
    const withFile = `${text} --kubeconfig /tmp/k`;
    await addToKubeconfig(deps(), { ...request, kubeconfig: '/tmp/k' }, withFile);
    expect(ran[0]?.slice(-2)).toEqual(['--kubeconfig', '/tmp/k']);
    await expect(addToKubeconfig(deps(), { ...request, kubeconfig: '/tmp/k' }, text)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('kubeconfigTarget', () => {
  test('the project file, else the first of KUBECONFIG, else the default', () => {
    const saved = process.env.KUBECONFIG;
    try {
      process.env.KUBECONFIG = '/a/one:/b/two';
      expect(kubeconfigTarget('/p/file')).toBe('/p/file');
      expect(kubeconfigTarget(null)).toBe('/a/one');
      delete process.env.KUBECONFIG;
      expect(kubeconfigTarget(null)).toMatch(/\.kube\/config$/);
    } finally {
      if (saved === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = saved;
    }
  });
});
