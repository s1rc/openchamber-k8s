import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import type { AwsProfile } from '../shared/eks.ts';
import type { ContextInfo, Obj, ProjectPick, ScopeResult } from '../shared/types.ts';

export type { AwsProfile };

export interface ScopeDeps {
  /** Contexts of a kubeconfig; no argument means the default one. */
  loadContexts: (kubeconfig?: string) => Promise<ContextInfo[]>;
  picks: Record<string, ProjectPick>;
  awsProfiles: () => Record<string, AwsProfile>;
  home?: string;
}

const ENV_FILES = ['.envrc', '.env', '.env.local', '.env.development'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist']);
const MAX_DEPTH = 4;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;

const clean = (value: string): string => value.trim();

/** `export KEY=value` and `KEY=value` only. Values that need a shell to expand (`$VAR`, `$(cmd)`, backticks) are ignored. */
export const parseEnvFile = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!match) continue;
    let value = clean(match[2] ?? '');
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"' && /[$`]/.test(value)) continue;
    } else {
      value = clean(value.replace(/\s+#.*$/, ''));
      if (/[$`]/.test(value)) continue;
    }
    if (value && !(match[1]! in out)) out[match[1]!] = value;
  }
  return out;
};

const awsConfigPath = (): string => process.env.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config');
const awsCredentialsPath = (): string => process.env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), '.aws', 'credentials');

/** Only the section names of the credentials file. The keys and secrets in it are never kept: a line that is not a header is skipped unread. */
const credentialProfileNames = (path: string): Set<string> => {
  const names = new Set<string>();
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return names;
  }
  for (const raw of text.split(/\r?\n/)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(raw);
    if (section) names.add(section[1]!.trim().replace(/^profile\s+/, ''));
  }
  return names;
};

/**
 * The profiles of `~/.aws/config` with their account, region and how they get credentials. The names in the credentials
 * file count as profiles that hold keys. Nothing from the credentials file except those names is read.
 * Pass `null` as the second argument to leave the credentials file out.
 */
export const readAwsProfiles = (configPath = awsConfigPath(), credentialsPath: string | null = awsCredentialsPath()): Record<string, AwsProfile> => {
  let text = '';
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    text = '';
  }
  const profiles: Record<string, AwsProfile> = {};
  const seen = new Map<string, { sso: boolean; keys: boolean; role: boolean; process: boolean }>();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(raw);
    if (section) {
      const header = section[1]!.trim();
      if (header === 'default') current = 'default';
      else if (header.startsWith('profile ')) current = header.slice(8).trim();
      else current = null;
      if (current) {
        profiles[current] = { accountId: null, region: null, auth: 'none' };
        seen.set(current, { sso: false, keys: false, role: false, process: false });
      }
      continue;
    }
    if (!current) continue;
    const pair = /^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/.exec(raw);
    if (!pair) continue;
    const entry = profiles[current]!;
    const flags = seen.get(current)!;
    const key = pair[1]!;
    if (key === 'sso_account_id') entry.accountId = pair[2]!;
    if (key === 'region') entry.region = pair[2]!;
    if (key === 'role_arn' && !entry.accountId) entry.accountId = /^arn:aws[a-z-]*:iam::(\d{12}):/.exec(pair[2]!)?.[1] ?? null;
    if (key === 'sso_session' || key === 'sso_start_url' || key === 'sso_account_id') flags.sso = true;
    if (key === 'aws_access_key_id') flags.keys = true;
    if (key === 'role_arn') flags.role = true;
    if (key === 'credential_process') flags.process = true;
  }
  if (credentialsPath) {
    for (const name of credentialProfileNames(credentialsPath)) {
      if (!profiles[name]) {
        profiles[name] = { accountId: null, region: null, auth: 'none' };
        seen.set(name, { sso: false, keys: false, role: false, process: false });
      }
      seen.get(name)!.keys = true;
    }
  }
  // The order the AWS program tries them: a role, then SSO, then keys, then a program of the user's own.
  for (const [name, flags] of seen) profiles[name]!.auth = flags.role ? 'role' : flags.sso ? 'sso' : flags.keys ? 'keys' : flags.process ? 'process' : 'none';
  return profiles;
};

interface Vote {
  value: string;
  weight: number;
  reason: string;
}

interface CtxVote extends Vote {
  by: 'name' | 'cluster' | 'server';
}

interface Tier {
  context: string | null;
  namespace: string | null;
  candidates: string[];
  reasons: string[];
  confidence: number;
  label: string;
  kubeconfig?: string;
  releaseHint?: string;
}

const emptyTier = (label: string): Tier => ({ context: null, namespace: null, candidates: [], reasons: [], confidence: 0, label });

const findContext = (contexts: ContextInfo[], vote: CtxVote): ContextInfo | undefined => {
  if (vote.by === 'name') return contexts.find((info) => info.name === vote.value);
  if (vote.by === 'cluster') return contexts.find((info) => info.clusterName === vote.value || info.name === vote.value || info.cluster.endsWith(`/${vote.value}`));
  const server = vote.value.replace(/\/+$/, '');
  return contexts.find((info) => info.server === server);
};

const tally = (votes: Vote[]): { best: string | null; tied: string[]; score: number; reasons: string[] } => {
  const scores = new Map<string, { score: number; reasons: string[] }>();
  for (const vote of votes) {
    const entry = scores.get(vote.value) ?? { score: 0, reasons: [] };
    entry.score += vote.weight;
    if (!entry.reasons.includes(vote.reason)) entry.reasons.push(vote.reason);
    scores.set(vote.value, entry);
  }
  let top = 0;
  for (const entry of scores.values()) top = Math.max(top, entry.score);
  const winners = [...scores.entries()].filter(([, entry]) => entry.score === top);
  if (winners.length === 0) return { best: null, tied: [], score: 0, reasons: [] };
  if (winners.length > 1) return { best: null, tied: winners.map(([value]) => value), score: top, reasons: winners.flatMap(([, entry]) => entry.reasons) };
  return { best: winners[0]![0], tied: [], score: top, reasons: winners[0]![1].reasons };
};

const confidenceOf = (score: number): number => Math.min(0.95, Math.max(0.3, score / 100));

const pathIsInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const expandHome = (value: string, home: string): string => (value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value);

const envTier = async (dir: string, deps: ScopeDeps): Promise<Tier> => {
  const tier = emptyTier('From env file');
  const env: Record<string, { value: string; file: string }> = {};
  for (const file of ENV_FILES) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parseEnvFile(text))) if (!(key in env)) env[key] = { value, file };
  }
  const pick = (...keys: string[]): { value: string; file: string; key: string } | null => {
    for (const key of keys) if (env[key]) return { ...env[key]!, key };
    return null;
  };
  const home = deps.home ?? homedir();

  const kube = pick('KUBECONFIG');
  if (kube) {
    const path = resolve(dir, expandHome(kube.value, home));
    let real: string | null = null;
    try {
      real = statSync(path).isFile() ? realpathSync(path) : null;
    } catch {
      real = null;
    }
    if (!real) tier.reasons.push(`${kube.key} in ${kube.file} names a file that does not exist`);
    else if (pathIsInside(real, realpathSync(dir))) tier.reasons.push(`${kube.key} in ${kube.file} points inside the repo, so it is not used: a kubeconfig can run programs`);
    else {
      tier.kubeconfig = real;
      tier.reasons.push(`kubeconfig ${basename(real)} from ${kube.key} in ${kube.file}`);
    }
  }
  const contexts = await deps.loadContexts(tier.kubeconfig);
  const ns = pick('NAMESPACE', 'KUBE_NAMESPACE', 'K8S_NAMESPACE');
  if (ns) {
    tier.namespace = ns.value;
    tier.reasons.push(`namespace ${ns.value} from ${ns.key} in ${ns.file}`);
    tier.label = `From ${ns.file}`;
  }
  const named = pick('KUBECONTEXT', 'KUBE_CONTEXT', 'K8S_CONTEXT');
  if (named) {
    if (contexts.some((info) => info.name === named.value)) {
      tier.context = named.value;
      tier.confidence = 0.95;
      tier.reasons.push(`context ${named.value} from ${named.key} in ${named.file}`);
      tier.label = `From ${named.file}`;
    } else tier.reasons.push(`${named.key} in ${named.file} names "${named.value}", which is not in the kubeconfig`);
    return tier;
  }
  const profileEnv = pick('AWS_PROFILE');
  if (profileEnv) {
    const profile = deps.awsProfiles()[profileEnv.value];
    if (!profile?.accountId) tier.reasons.push(`AWS profile ${profileEnv.value} in ${profileEnv.file} has no account id to match`);
    else {
      let matches = contexts.filter((info) => info.account === profile.accountId);
      const sameRegion = matches.filter((info) => info.region === profile.region);
      if (matches.length > 1 && sameRegion.length > 0) matches = sameRegion;
      if (matches.length === 1) {
        tier.context = matches[0]!.name;
        tier.confidence = 0.8;
        tier.reasons.push(`AWS profile ${profileEnv.value} (account ${profile.accountId}) from ${profileEnv.file} matches ${matches[0]!.name}`);
        tier.label = `From ${profileEnv.file}`;
      } else if (matches.length > 1) {
        tier.candidates = matches.map((info) => info.name);
        tier.confidence = 0.4;
        tier.reasons.push(`AWS profile ${profileEnv.value} (account ${profile.accountId}) from ${profileEnv.file} fits ${matches.length} clusters: pick one`);
        tier.label = `From ${profileEnv.file}`;
      } else tier.reasons.push(`AWS profile ${profileEnv.value} (account ${profile.accountId}) matches no cluster in the kubeconfig`);
    }
  }
  return tier;
};

const listFiles = (root: string): string[] => {
  const out: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile()) out.push(join(dir, entry.name));
    }
  }
  return out;
};

const readSmall = (file: string): string | null => {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const blockAfter = (text: string, at: number): string => text.slice(at, at + 2500);

const terraformVotes = (text: string, file: string, ctx: CtxVote[]): void => {
  const headers: [RegExp, RegExp][] = [
    [/resource\s+"aws_eks_cluster"\s+"[^"]+"\s*\{/g, /^\s*name\s*=\s*"([^"$]+)"/m],
    [/data\s+"aws_eks_cluster"\s+"[^"]+"\s*\{/g, /^\s*name\s*=\s*"([^"$]+)"/m],
    [/module\s+"eks[^"]*"\s*\{/g, /^\s*cluster_name\s*=\s*"([^"$]+)"/m],
  ];
  for (const [header, field] of headers) {
    for (const match of text.matchAll(header)) {
      const name = field.exec(blockAfter(text, (match.index ?? 0) + match[0].length))?.[1];
      if (name) ctx.push({ by: 'cluster', value: name, weight: 40, reason: `cluster ${name} from ${file}` });
    }
  }
};

const isK8sDoc = (doc: Obj): boolean => typeof doc.apiVersion === 'string' && typeof doc.kind === 'string';

const repoTier = async (dir: string, contexts: ContextInfo[]): Promise<Tier> => {
  const tier = emptyTier('From repo files');
  const ctxVotes: CtxVote[] = [];
  const nsVotes: Vote[] = [];
  const plain = new Map<string, number>();
  let release: string | undefined;

  for (const path of listFiles(dir)) {
    const file = relative(dir, path);
    const name = basename(path);
    const lower = name.toLowerCase();
    const isYaml = lower.endsWith('.yaml') || lower.endsWith('.yml');
    if (!isYaml && !lower.endsWith('.tf') && name !== 'Tiltfile') continue;
    const text = readSmall(path);
    if (text === null) continue;

    if (lower.endsWith('.tf')) {
      terraformVotes(text, file, ctxVotes);
      continue;
    }
    if (name === 'Tiltfile') {
      for (const match of text.matchAll(/allow_k8s_contexts\(\s*(\[[^\]]*\]|["'][^"']+["'])\s*\)/g)) {
        for (const item of match[1]!.matchAll(/["']([^"']+)["']/g)) ctxVotes.push({ by: 'name', value: item[1]!, weight: 70, reason: `context ${item[1]} from ${file}` });
      }
      continue;
    }

    for (const parsed of parseAllDocuments(text, { prettyErrors: false })) {
      if (parsed.errors.length > 0) continue;
      const doc = parsed.toJS({ maxAliasCount: 100 }) as unknown;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
      const item = doc as Obj;

      if (name === 'Chart.yaml' && typeof item.name === 'string') {
        release ??= item.name;
        continue;
      }
      if (typeof item.apiVersion === 'string' && item.apiVersion.startsWith('skaffold/')) {
        const kc = item.deploy?.kubeContext;
        if (typeof kc === 'string') ctxVotes.push({ by: 'name', value: kc, weight: 70, reason: `context ${kc} from ${file}` });
        continue;
      }
      if (!isK8sDoc(item) && !(lower === 'kustomization.yaml' || lower === 'kustomization.yml')) continue;

      const apiVersion = String(item.apiVersion ?? '');
      const kind = String(item.kind ?? '');
      const spec: Obj = item.spec ?? {};
      const metaNs: unknown = item.metadata?.namespace;

      if (apiVersion.startsWith('argoproj.io/') && (kind === 'Application' || kind === 'ApplicationSet')) {
        const destination: Obj = (kind === 'Application' ? spec.destination : spec.template?.spec?.destination) ?? {};
        if (typeof destination.namespace === 'string' && !destination.namespace.includes('{')) nsVotes.push({ value: destination.namespace, weight: 60, reason: `namespace ${destination.namespace} from ${file}` });
        if (typeof destination.name === 'string' && destination.name !== 'in-cluster' && !destination.name.includes('{')) ctxVotes.push({ by: 'cluster', value: destination.name, weight: 60, reason: `cluster ${destination.name} from ${file}` });
        if (typeof destination.server === 'string' && !/kubernetes\.default\.svc/.test(destination.server)) ctxVotes.push({ by: 'server', value: destination.server, weight: 60, reason: `cluster ${destination.server} from ${file}` });
        continue;
      }
      if (apiVersion.startsWith('kustomize.toolkit.fluxcd.io/') || apiVersion.startsWith('helm.toolkit.fluxcd.io/')) {
        if (typeof spec.targetNamespace === 'string') nsVotes.push({ value: spec.targetNamespace, weight: 50, reason: `namespace ${spec.targetNamespace} from ${file}` });
        else if (typeof metaNs === 'string') nsVotes.push({ value: metaNs, weight: 50, reason: `namespace ${metaNs} from ${file}` });
        continue;
      }
      if (lower === 'kustomization.yaml' || lower === 'kustomization.yml') {
        if (typeof item.namespace === 'string') nsVotes.push({ value: item.namespace, weight: 40, reason: `namespace ${item.namespace} from ${file}` });
        continue;
      }
      if (typeof metaNs === 'string' && kind !== 'Namespace') plain.set(metaNs, (plain.get(metaNs) ?? 0) + 1);
    }
  }

  const resolved: CtxVote[] = [];
  const named = new Map<string, ContextInfo>();
  for (const vote of ctxVotes) {
    const found = findContext(contexts, vote);
    if (found) {
      named.set(found.name, found);
      resolved.push({ ...vote, value: found.name });
    }
  }
  const ctx = tally(resolved);
  if (ctx.best) {
    tier.context = ctx.best;
    tier.confidence = confidenceOf(ctx.score);
    tier.reasons.push(...ctx.reasons);
  } else if (ctx.tied.length > 1) {
    tier.candidates = ctx.tied;
    tier.confidence = 0.3;
    tier.reasons.push(`${ctx.tied.length} clusters fit equally well: pick one`, ...ctx.reasons);
  }
  for (const [value, count] of plain) nsVotes.push({ value, weight: Math.min(count, 10) * 2, reason: `namespace ${value} in ${count} manifest${count === 1 ? '' : 's'}` });
  const ns = tally(nsVotes);
  if (ns.best) {
    tier.namespace = ns.best;
    tier.confidence = Math.max(tier.confidence, confidenceOf(ns.score));
    tier.reasons.push(...ns.reasons);
  } else if (ns.tied.length > 1) tier.reasons.push(`namespaces ${ns.tied.join(', ')} fit equally well, none preselected`);
  if (release) tier.releaseHint = release;
  return tier;
};

/** Where the project most likely works: your pick, then env files, then what the repo says. Null when nothing is found. */
export const resolveScope = async (directory: string, deps: ScopeDeps): Promise<ScopeResult | null> => {
  const dir = resolve(directory);
  const pick = deps.picks[dir];
  const defaults = await deps.loadContexts();
  if (pick && defaults.some((info) => info.name === pick.context)) {
    const env = await envTier(dir, deps).catch(() => emptyTier(''));
    return {
      context: pick.context,
      namespace: pick.namespace,
      source: 'Your pick',
      sourceKind: 'pick',
      confidence: 1,
      reasons: [`You picked ${pick.context}${pick.namespace ? ` and ${pick.namespace}` : ''} for this project`],
      candidates: [],
      ...(env.kubeconfig ? { kubeconfig: env.kubeconfig } : {}),
    };
  }
  const env = await envTier(dir, deps);
  const repo = await repoTier(dir, env.kubeconfig ? await deps.loadContexts(env.kubeconfig) : defaults);

  const contextTier = env.context !== null || env.candidates.length > 0 ? env : repo;
  const namespaceTier = env.namespace !== null ? env : repo;
  const context = contextTier.context;
  const namespace = namespaceTier.namespace;
  const candidates = context ? [] : contextTier.candidates;
  if (!context && candidates.length === 0 && !namespace) return null;

  const primary = context || candidates.length > 0 ? contextTier : namespaceTier;
  const usesRepo = contextTier === repo || namespaceTier === repo;
  return {
    context,
    namespace,
    source: primary.label,
    sourceKind: primary === env ? 'env' : 'repo',
    confidence: Math.max(primary.confidence, 0.3),
    reasons: [...new Set([...env.reasons, ...(usesRepo ? repo.reasons : [])])],
    candidates,
    ...(env.kubeconfig ? { kubeconfig: env.kubeconfig } : {}),
    ...(repo.releaseHint ? { releaseHint: repo.releaseHint } : {}),
  };
};

/** Results per directory for five minutes, so a mention search never rescans the repo. */
export const createScopeCache = (resolveFn: (dir: string) => Promise<ScopeResult | null>, ttlMs = 5 * 60 * 1000, now: () => number = Date.now) => {
  const entries = new Map<string, { at: number; value: ScopeResult | null }>();
  return {
    get: async (dir: string): Promise<ScopeResult | null> => {
      const key = resolve(dir);
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = await resolveFn(key);
      entries.set(key, { at: now(), value });
      return value;
    },
    invalidate: (dir?: string): void => {
      if (dir) entries.delete(resolve(dir));
      else entries.clear();
    },
  };
};

export const projectExists = (dir: string): boolean => existsSync(dir);
