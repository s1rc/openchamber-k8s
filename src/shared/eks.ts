// EKS discovery and sign-in: the parts both the service and the panel need. Pure, so each rule is tested.
import { shellQuote } from './shell.ts';
import type { ContextInfo } from './types.ts';

/** How an AWS profile gets its credentials. Only `sso` can be signed in again from here. */
export type ProfileAuth = 'sso' | 'keys' | 'role' | 'process' | 'none';

export interface AwsProfile {
  accountId: string | null;
  region: string | null;
  auth: ProfileAuth;
}

/** What Sign in does for a context. */
export type SignInPlan =
  | { kind: 'sso'; profile: string }
  | { kind: 'oidc' }
  /** Nothing to sign in to from here: the login uses access keys, a missing profile, or a program of its own. */
  | { kind: 'none'; profile: string | null; reason: 'keys' | 'missing' | 'other' };

// Every value that reaches a command line is checked against one of these first. None can start with a dash,
// and none can hold a space, a quote or any shell character, so a value can never read as a flag or a second command.
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.@+=-]{0,127}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const CLUSTER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,126}$/;
const ACCOUNT = /^\d{12}$/;

export const isProfileName = (value: unknown): value is string => typeof value === 'string' && PROFILE.test(value);
export const isRegion = (value: unknown): value is string => typeof value === 'string' && REGION.test(value);
export const isClusterName = (value: unknown): value is string => typeof value === 'string' && CLUSTER.test(value);
export const isAlias = (value: unknown): value is string => typeof value === 'string' && ALIAS.test(value);
export const isAccountId = (value: unknown): value is string => typeof value === 'string' && ACCOUNT.test(value);

/** What the user can do about a context whose login has expired. */
export const signInPlan = (info: Pick<ContextInfo, 'auth' | 'awsProfile'>, profiles: Record<string, AwsProfile>, envProfile?: string): SignInPlan => {
  if (info.auth === 'oidc') return { kind: 'oidc' };
  if (info.auth !== 'aws') return { kind: 'none', profile: null, reason: 'other' };
  const name = info.awsProfile ?? (envProfile && envProfile.trim() ? envProfile.trim() : 'default');
  const profile = profiles[name];
  if (!profile) return { kind: 'none', profile: name, reason: 'missing' };
  if (profile.auth === 'sso' && isProfileName(name)) return { kind: 'sso', profile: name };
  return { kind: 'none', profile: name, reason: profile.auth === 'keys' ? 'keys' : 'other' };
};

/** The words in the banner for a context's sign-in plan. */
export const signInText = (plan: SignInPlan | null | undefined): string => {
  if (!plan) return 'Your sign-in for this cluster has expired.';
  if (plan.kind === 'sso') return `Your AWS sign-in for the profile "${plan.profile}" has expired. Sign in again to bring this cluster back.`;
  if (plan.kind === 'oidc') return 'Your login for this cluster has expired. Sign in again: your browser opens to finish it.';
  if (plan.reason === 'keys') return `This cluster signs in with the access keys of the AWS profile "${plan.profile ?? 'default'}". Those cannot be renewed here: update the keys, then try again.`;
  if (plan.reason === 'missing') return `This cluster uses the AWS profile "${plan.profile ?? ''}", which is not in your AWS config. Add it, then try again.`;
  return 'Your sign-in for this cluster has expired, and it cannot be renewed from here. Sign in the way you usually do, then try again.';
};

export interface AddRequest {
  name: string;
  region: string;
  profile: string;
  alias: string;
  /** Only when the panel works on a kubeconfig the project named. Otherwise the AWS program chooses the file. */
  kubeconfig?: string;
}

export type AddCommand = { ok: true; args: string[]; text: string } | { ok: false; error: string };

/** The arguments of `aws eks update-kubeconfig`, after `aws`. The same text is shown to the user and compared before it runs. */
export const updateKubeconfigCommand = (input: Partial<AddRequest>): AddCommand => {
  if (!isClusterName(input.name)) return { ok: false, error: 'That cluster name is not one this panel can add.' };
  if (!isRegion(input.region)) return { ok: false, error: 'That region is not valid.' };
  if (!isProfileName(input.profile)) return { ok: false, error: 'That AWS profile name is not one this panel can use.' };
  if (!isAlias(input.alias)) return { ok: false, error: 'Use letters, digits, dots, dashes and underscores for the name, starting with a letter or digit.' };
  const kubeconfig = input.kubeconfig;
  if (kubeconfig !== undefined && (kubeconfig.length === 0 || kubeconfig.startsWith('-') || /[\0\n\r]/.test(kubeconfig))) return { ok: false, error: 'That kubeconfig path is not valid.' };
  const args = ['eks', 'update-kubeconfig', '--name', input.name, '--region', input.region, '--profile', input.profile, '--alias', input.alias, ...(kubeconfig ? ['--kubeconfig', kubeconfig] : [])];
  return { ok: true, args, text: ['aws', ...args.map(shellQuote)].join(' ') };
};

/** A name for the new context: `<cluster>-<region>`, with the account added when that is taken. */
export const suggestAlias = (name: string, region: string, accountId: string | null, taken: ReadonlySet<string>): string => {
  const base = `${name}-${region}`;
  if (!taken.has(base)) return base;
  if (accountId) {
    const withAccount = `${base}-${accountId}`;
    if (!taken.has(withAccount)) return withAccount;
  }
  return base;
};

/** Why an alias cannot be used, or null. */
export const aliasProblem = (alias: string, taken: ReadonlySet<string>): string | null => {
  if (!alias.trim()) return 'Give the cluster a name.';
  if (!isAlias(alias)) return 'Use letters, digits, dots, dashes and underscores, starting with a letter or digit.';
  if (taken.has(alias)) return 'You already have a cluster with this name. Pick another.';
  return null;
};

export type ProfileStatus = 'ok' | 'signin' | 'expired' | 'denied' | 'unreachable' | 'error' | 'skipped';

export interface EksProfileView {
  profile: string;
  auth: ProfileAuth;
  accountId: string | null;
  regions: string[];
  status: ProfileStatus;
  message: string | null;
  count: number;
  /** A Sign in button makes sense: the profile is SSO and its login is missing or expired. */
  signIn: boolean;
  at: number;
}

export interface EksClusterView {
  name: string;
  region: string;
  profile: string;
  accountId: string | null;
  /** The context that already points at this cluster, or null when it is not in the kubeconfig. */
  context: string | null;
  /** The name to offer for a new context. */
  alias: string;
}

export interface EksState {
  running: boolean;
  progress: { done: number; total: number } | null;
  /** When the oldest answer was read; null when nothing was read yet. */
  at: number | null;
  fresh: boolean;
  profiles: EksProfileView[];
  clusters: EksClusterView[];
  /** The context names in use, for the alias check. */
  taken: string[];
  /** The kubeconfig a project named, passed to the command; null when the AWS program chooses the file. */
  kubeconfigArg: string | null;
  /** Where the new context will be written, for the confirm text. */
  kubeconfigPath: string;
}

/** The context that already points at a discovered cluster, if any. An account that is unknown on either side does not block a match. */
export const contextFor = (cluster: { name: string; region: string; accountId: string | null }, contexts: ReadonlyArray<Pick<ContextInfo, 'name' | 'clusterName' | 'region' | 'account'>>): string | null => {
  const found = contexts.find(
    (info) => info.clusterName === cluster.name && info.region === cluster.region && (!cluster.accountId || !info.account || info.account === cluster.accountId),
  );
  return found?.name ?? null;
};

/** Pulls out a sign-in link the AWS program printed, in case the browser did not open. Only https links to AWS hosts. */
export const signInUrl = (output: string): string | null => {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    const text = match[0].replace(/[.,;)]+$/, '');
    if (text.length > 2000) continue;
    try {
      const host = new URL(text).hostname.toLowerCase();
      if (/(^|\.)(amazonaws\.com|awsapps\.com|amazon\.com|aws)$/.test(host)) return text;
    } catch {
      // Not a link.
    }
  }
  return null;
};

export type AuthState = 'running' | 'done' | 'failed' | 'timeout' | 'cancelled';

/** One sign-in as the panel sees it. Holds no output of the program, only a sign-in link when one was printed. */
export interface AuthView {
  id: string;
  key: string;
  kind: 'sso' | 'oidc';
  profile: string | null;
  /** The context the sign-in was started for, when there is one. */
  context: string | null;
  /** Every context that gets its login back when this succeeds. */
  contexts: string[];
  state: AuthState;
  startedAt: number;
  expiresAt: number;
  url?: string;
  error?: string;
  /** True when this request joined a sign-in that was already running. */
  joined?: boolean;
}
