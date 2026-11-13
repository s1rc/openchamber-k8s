import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  contextFor,
  isAccountId,
  isClusterName,
  isProfileName,
  isRegion,
  suggestAlias,
  updateKubeconfigCommand,
  type AddRequest,
  type AwsProfile,
  type EksClusterView,
  type EksProfileView,
  type EksState,
  type ProfileAuth,
  type ProfileStatus,
} from '../shared/eks.ts';
import type { ContextInfo } from '../shared/types.ts';
import { classifyText, clip, K8sError, scrub } from './errors.ts';
import type { RunResult } from './exec.ts';
import { ensureDir, stateDir } from './state.ts';

/** A good answer stays for an hour. A failed one is tried again after a minute, so a sign-in done elsewhere is noticed. */
export const FRESH_MS = 60 * 60 * 1000;
export const FAILED_MS = 60 * 1000;

const CACHE_FILE = 'eks-discovery.json';
const AWS_CALL_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;

export interface StoredCluster {
  name: string;
  region: string;
  profile: string;
  accountId: string | null;
}

interface Stored {
  version: 1;
  key: string;
  profiles: EksProfileView[];
  clusters: StoredCluster[];
}

export interface AwsFailure {
  status: ProfileStatus;
  message: string;
  /** The same in every region, so there is no point asking the others. */
  profileWide: boolean;
}

/** Reads the AWS program's error text and says what is wrong with the profile. */
export const classifyAwsFailure = (output: string, auth: ProfileAuth): AwsFailure => {
  if (/accessdenied|is not authorized to perform|unauthorizedoperation|not authorized/i.test(output)) {
    return { status: 'denied', message: 'This profile is not allowed to list EKS clusters here.', profileWide: false };
  }
  if (/invalidclienttokenid|signaturedoesnotmatch|security token included in the request is invalid|authfailure|invalidaccesskeyid/i.test(output)) {
    return { status: 'error', message: 'AWS does not accept the keys of this profile.', profileWide: true };
  }
  const code = classifyText(output);
  if (code === 'AUTH_EXPIRED') {
    return auth === 'sso'
      ? { status: 'signin', message: 'Your sign-in has expired.', profileWide: true }
      : { status: 'expired', message: 'The credentials of this profile are missing or have expired.', profileWide: true };
  }
  if (code === 'NO_KUBECTL') return { status: 'error', message: 'A program this profile needs was not found.', profileWide: true };
  if (code === 'UNREACHABLE' || /could not connect to the endpoint|connect timeout|read timeout|endpointconnectionerror|ssl validation failed/i.test(output)) {
    return { status: 'unreachable', message: 'AWS did not answer. Check your network or VPN.', profileWide: true };
  }
  return { status: 'error', message: clip(scrub(output), 200) || 'AWS returned an error.', profileWide: false };
};

export interface DiscoverDeps {
  aws: (args: string[]) => Promise<RunResult>;
  profiles: () => Record<string, AwsProfile>;
  /** Regions of the clusters already in the kubeconfig. */
  kubeRegions: () => string[];
  now: () => number;
  /** Called after each profile finishes. */
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
}

interface Planned {
  name: string;
  profile: AwsProfile;
  regions: string[];
}

/** Profiles that can hold credentials, with the regions to look in: the profile's own and every region of the kubeconfig. */
export const planDiscovery = (profiles: Record<string, AwsProfile>, kubeRegions: string[]): { planned: Planned[]; skipped: EksProfileView[] } => {
  const regions = new Set(kubeRegions.filter(isRegion));
  const planned: Planned[] = [];
  const skipped: EksProfileView[] = [];
  for (const name of Object.keys(profiles).sort()) {
    const profile = profiles[name]!;
    const own = profile.region && isRegion(profile.region) ? [profile.region] : [];
    const list = [...new Set([...own, ...regions])].sort();
    const base = { profile: name, auth: profile.auth, accountId: profile.accountId, regions: list, count: 0, signIn: false, at: 0 };
    if (!isProfileName(name)) skipped.push({ ...base, status: 'skipped', message: 'The name of this profile is not one this panel can use.' });
    else if (profile.auth === 'none') skipped.push({ ...base, status: 'skipped', message: 'No credentials.' });
    else if (list.length === 0) skipped.push({ ...base, status: 'skipped', message: 'No region to look in.' });
    else planned.push({ name, profile, regions: list });
  }
  return { planned, skipped };
};

const awsArgs = (profile: string, rest: string[]): string[] => [...rest, '--profile', profile, '--no-cli-pager', '--cli-read-timeout', '20', '--cli-connect-timeout', '10'];

const parseClusters = (stdout: string): string[] => {
  try {
    const parsed = JSON.parse(stdout) as { clusters?: unknown };
    return Array.isArray(parsed.clusters) ? parsed.clusters.filter(isClusterName) : [];
  } catch {
    return [];
  }
};

export const discoverProfile = async (item: Planned, deps: DiscoverDeps): Promise<{ view: EksProfileView; clusters: StoredCluster[] }> => {
  const clusters: StoredCluster[] = [];
  let accountId = item.profile.accountId && isAccountId(item.profile.accountId) ? item.profile.accountId : null;
  let failure: AwsFailure | null = null;
  let okRegions = 0;
  let failedRegions = 0;
  for (const region of item.regions) {
    const out = await deps.aws(awsArgs(item.name, ['eks', 'list-clusters', '--region', region, '--output', 'json']));
    if (out.code === 0) {
      okRegions += 1;
      for (const name of parseClusters(out.stdout)) clusters.push({ name, region, profile: item.name, accountId });
      continue;
    }
    const found = classifyAwsFailure(`${out.stderr} ${out.stdout}`, item.profile.auth);
    failedRegions += 1;
    failure ??= found;
    if (found.profileWide) break;
  }
  if (okRegions > 0 && !accountId) {
    const who = await deps.aws(awsArgs(item.name, ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']));
    const text = who.stdout.trim();
    if (who.code === 0 && isAccountId(text)) accountId = text;
    for (const cluster of clusters) cluster.accountId = accountId;
  }
  const at = deps.now();
  const base = { profile: item.name, auth: item.profile.auth, accountId, regions: item.regions, count: clusters.length, at };
  if (okRegions > 0) {
    const partial = failedRegions > 0 && failure ? `${failedRegions} of ${item.regions.length} regions could not be read: ${failure.message}` : null;
    return { view: { ...base, status: 'ok', message: partial, signIn: false }, clusters };
  }
  const why = failure ?? { status: 'error' as const, message: 'AWS returned an error.', profileWide: false };
  return { view: { ...base, status: why.status, message: why.message, signIn: why.status === 'signin' }, clusters: [] };
};

const keyOf = (planned: Planned[], kubeRegions: string[]): string =>
  `${planned.map((item) => `${item.name}:${item.profile.auth}:${item.profile.region ?? ''}`).join(',')}|${[...new Set(kubeRegions)].sort().join(',')}`;

const isFresh = (view: EksProfileView, now: number): boolean => now - view.at < (view.status === 'ok' || view.status === 'denied' ? FRESH_MS : FAILED_MS);

const readStored = (): Stored | null => {
  try {
    const value = JSON.parse(readFileSync(join(dataDir(), CACHE_FILE), 'utf8')) as Stored;
    return value && value.version === 1 && Array.isArray(value.profiles) && Array.isArray(value.clusters) ? value : null;
  } catch {
    return null;
  }
};

const writeStored = (value: Stored): void => {
  const dir = ensureDir(dataDir());
  const file = join(dir, CACHE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
};

/** The service's own folder from the host; the state folder when it is not set (a run outside the app). */
export const dataDir = (): string => process.env.OPENCHAMBER_SERVICE_DATA_DIR || stateDir();

const runPool = async <T,>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
};

export interface StartOptions {
  /** Look again even when the answer is fresh. */
  refresh?: boolean;
  /** Only this profile. The rest of the kept answer stays. */
  only?: string;
}

export const createDiscovery = (deps: DiscoverDeps, announce: (event: { state: 'running' | 'done'; done?: number; total?: number; at?: number }) => void = () => undefined) => {
  let running: Promise<void> | null = null;
  let progress: { done: number; total: number } | null = null;

  const start = (options: StartOptions = {}): { started: boolean } => {
    if (running) return { started: false };
    const kubeRegions = deps.kubeRegions();
    const { planned, skipped } = planDiscovery(deps.profiles(), kubeRegions);
    const key = keyOf(planned, kubeRegions);
    const stored = readStored();
    const now = deps.now();
    const sameShape = stored?.key === key;
    let todo: Planned[];
    if (options.only) todo = planned.filter((item) => item.name === options.only);
    else if (!sameShape || options.refresh) todo = planned;
    else todo = planned.filter((item) => {
      const kept = stored.profiles.find((view) => view.profile === item.name);
      return !kept || !isFresh(kept, now);
    });
    if (todo.length === 0) return { started: false };
    progress = { done: 0, total: todo.length };
    announce({ state: 'running', done: 0, total: todo.length });
    const keep = sameShape && stored ? stored : null;
    const results = new Map<string, { view: EksProfileView; clusters: StoredCluster[] }>();
    running = (async () => {
      try {
        await runPool(todo, deps.concurrency ?? DEFAULT_CONCURRENCY, async (item) => {
          try {
            results.set(item.name, await discoverProfile(item, deps));
          } catch (error) {
            const at = deps.now();
            results.set(item.name, {
              view: { profile: item.name, auth: item.profile.auth, accountId: item.profile.accountId, regions: item.regions, count: 0, signIn: false, at, status: 'error', message: clip(scrub(error instanceof Error ? error.message : String(error)), 200) || 'Something went wrong.' },
              clusters: [],
            });
          }
          progress = { done: results.size, total: todo.length };
          announce({ state: 'running', done: results.size, total: todo.length });
        });
        const names = new Set(todo.map((item) => item.name));
        const profiles = [
          ...(keep?.profiles ?? []).filter((view) => !names.has(view.profile) && planned.some((item) => item.name === view.profile)),
          ...[...results.values()].map((entry) => entry.view),
          ...skipped,
        ].sort((a, b) => a.profile.localeCompare(b.profile));
        const clusters = [...(keep?.clusters ?? []).filter((cluster) => !names.has(cluster.profile) && planned.some((item) => item.name === cluster.profile)), ...[...results.values()].flatMap((entry) => entry.clusters)];
        writeStored({ version: 1, key, profiles, clusters });
      } finally {
        running = null;
        progress = null;
        announce({ state: 'done', at: deps.now() });
      }
    })();
    running.catch(() => undefined);
    return { started: true };
  };

  /** What the panel shows: the kept answer joined with the kubeconfig as it is now. */
  const state = (contexts: ContextInfo[], kubeconfigArg: string | null, kubeconfigPath: string): EksState => {
    const kubeRegions = deps.kubeRegions();
    const { planned, skipped } = planDiscovery(deps.profiles(), kubeRegions);
    const stored = readStored();
    const now = deps.now();
    const sameShape = stored?.key === keyOf(planned, kubeRegions);
    const profiles = stored ? stored.profiles.filter((view) => skipped.some((entry) => entry.profile === view.profile) || planned.some((item) => item.name === view.profile)) : [];
    const known = new Set(profiles.map((view) => view.profile));
    const all = [...profiles, ...skipped.filter((entry) => !known.has(entry.profile))].sort((a, b) => a.profile.localeCompare(b.profile));
    const taken = new Set(contexts.map((info) => info.name));
    const seen = new Set<string>();
    const clusters: EksClusterView[] = [];
    for (const cluster of (stored?.clusters ?? []).sort((a, b) => (a.accountId ?? '').localeCompare(b.accountId ?? '') || a.region.localeCompare(b.region) || a.name.localeCompare(b.name) || a.profile.localeCompare(b.profile))) {
      const id = `${cluster.accountId ?? cluster.profile}|${cluster.region}|${cluster.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      clusters.push({ ...cluster, context: contextFor(cluster, contexts), alias: suggestAlias(cluster.name, cluster.region, cluster.accountId, taken) });
    }
    const checked = planned.map((item) => stored?.profiles.find((view) => view.profile === item.name));
    const everyFresh = sameShape && checked.every((view) => view !== undefined && isFresh(view, now));
    const oldest = checked.filter((view): view is EksProfileView => view !== undefined && view.at > 0).reduce<number | null>((min, view) => (min === null || view.at < min ? view.at : min), null);
    return {
      running: running !== null,
      progress,
      at: oldest,
      fresh: everyFresh && planned.length > 0,
      profiles: all,
      clusters,
      taken: [...taken].sort(),
      kubeconfigArg,
      kubeconfigPath,
    };
  };

  return { start, state, isRunning: () => running !== null, idle: (): Promise<void> => running ?? Promise.resolve() };
};

/** The file `aws eks update-kubeconfig` writes: the one a project named, else the first of KUBECONFIG, else the default. */
export const kubeconfigTarget = (arg: string | null): string => {
  if (arg) return arg;
  const first = (process.env.KUBECONFIG ?? '').split(':').find(Boolean);
  return first || join(homedir(), '.kube', 'config');
};

export interface AddDeps {
  aws: (args: string[]) => Promise<RunResult>;
  /** The contexts the kubeconfig has right now, not a kept copy. */
  contexts: () => Promise<ContextInfo[]>;
  profiles: () => Record<string, AwsProfile>;
}

/**
 * Runs `aws eks update-kubeconfig` for a discovered cluster. Every argument is checked first, the new name must not be a
 * context already, and `expect` must be the exact text the user saw and confirmed: if anything changed since, nothing runs.
 */
export const addToKubeconfig = async (deps: AddDeps, request: Partial<AddRequest>, expect: string | undefined): Promise<{ command: string }> => {
  const command = updateKubeconfigCommand(request);
  if (!command.ok) throw new K8sError('BAD_REQUEST', command.error);
  const profile = deps.profiles()[request.profile as string];
  if (!profile) throw new K8sError('INVALID', `The AWS profile "${request.profile}" is not in your AWS config.`);
  if (profile.auth === 'none') throw new K8sError('INVALID', `The AWS profile "${request.profile}" has no credentials.`);
  const contexts = await deps.contexts();
  if (contexts.some((info) => info.name === request.alias)) throw new K8sError('CONFLICT', `You already have a cluster named "${request.alias}". Pick another name.`);
  if (expect !== command.text) throw new K8sError('CONFLICT', 'The command is not the one you confirmed. Review it again.');
  const out = await deps.aws(command.args);
  if (out.code !== 0) {
    const found = classifyAwsFailure(`${out.stderr} ${out.stdout}`, profile.auth);
    if (found.status === 'signin') throw new K8sError('AUTH_EXPIRED', 'Your sign-in for this AWS profile has expired.', { kind: 'sign-in', profile: request.profile as string });
    if (found.status === 'expired') throw new K8sError('AUTH_EXPIRED', found.message);
    if (found.status === 'denied') throw new K8sError('FORBIDDEN', 'This profile is not allowed to read that cluster.');
    if (found.status === 'unreachable') throw new K8sError('UNREACHABLE', found.message);
    throw new K8sError('K8S_ERROR', found.message);
  }
  return { command: command.text };
};
