import type { ContextInfo, Obj } from '../shared/types.ts';
import { fromOutput, K8sError } from './errors.ts';
import { kubeconfigArgs, kubectlPath, run } from './exec.ts';

const ARN = /^arn:aws[a-z-]*:eks:([a-z0-9-]+):(\d{12}):cluster\/(.+)$/;

const authKind = (exec: Obj | undefined): ContextInfo['auth'] => {
  if (!exec) return 'none';
  const command = String(exec.command ?? '').split('/').pop() ?? '';
  const first = Array.isArray(exec.args) ? String(exec.args[0] ?? '') : '';
  if (command === 'aws' || command === 'aws-iam-authenticator') return 'aws';
  if (first === 'oidc-login' || /kubelogin/.test(command)) return 'oidc';
  return 'other';
};

const profileOf = (exec: Obj | undefined): string | null => {
  if (!exec) return null;
  const args: string[] = Array.isArray(exec.args) ? exec.args.map(String) : [];
  const at = args.findIndex((arg) => arg === '--profile' || arg.startsWith('--profile='));
  if (at >= 0) return args[at]!.includes('=') ? args[at]!.split('=')[1] ?? null : args[at + 1] ?? null;
  const env: unknown = exec.env;
  if (Array.isArray(env)) {
    const entry = (env as Obj[]).find((item) => item.name === 'AWS_PROFILE');
    if (entry && typeof entry.value === 'string') return entry.value;
  }
  return null;
};

/**
 * Reads the output of `kubectl config view -o json`. It never holds credentials: kubectl hides them without `--raw`,
 * and only the exec program name, its first arguments and AWS_PROFILE are kept.
 */
export const parseKubeconfig = (doc: Obj): { current: string | null; contexts: ContextInfo[] } => {
  const clusters = new Map<string, Obj>();
  for (const entry of (doc.clusters ?? []) as Obj[]) clusters.set(String(entry.name), (entry.cluster ?? {}) as Obj);
  const users = new Map<string, Obj>();
  for (const entry of (doc.users ?? []) as Obj[]) users.set(String(entry.name), (entry.user ?? {}) as Obj);
  const contexts: ContextInfo[] = [];
  for (const entry of (doc.contexts ?? []) as Obj[]) {
    const body = (entry.context ?? {}) as Obj;
    const cluster = String(body.cluster ?? '');
    const arn = ARN.exec(cluster);
    const exec = users.get(String(body.user ?? ''))?.exec as Obj | undefined;
    const server = clusters.get(cluster)?.server;
    contexts.push({
      name: String(entry.name),
      cluster,
      clusterName: arn?.[3] ?? cluster,
      server: typeof server === 'string' ? server.replace(/\/+$/, '') : null,
      namespace: typeof body.namespace === 'string' && body.namespace ? body.namespace : null,
      arn: arn ? cluster : null,
      account: arn?.[2] ?? null,
      region: arn?.[1] ?? null,
      auth: authKind(exec),
      awsProfile: profileOf(exec),
    });
  }
  const current = typeof doc['current-context'] === 'string' && doc['current-context'] ? (doc['current-context'] as string) : null;
  return { current, contexts };
};

export interface Kubeconfig {
  current: string | null;
  contexts: ContextInfo[];
}

const cache = new Map<string, { at: number; value: Kubeconfig }>();
const CACHE_MS = 10_000;

export const loadKubeconfig = async (kubeconfig?: string): Promise<Kubeconfig> => {
  const key = kubeconfig ?? '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const out = await run(kubectlPath(), ['config', 'view', '-o', 'json', ...kubeconfigArgs(kubeconfig)], { timeoutMs: 15000 });
  if (out.code !== 0) throw fromOutput(out.stderr, 'kubectl could not read your kubeconfig.');
  let doc: Obj;
  try {
    doc = JSON.parse(out.stdout) as Obj;
  } catch {
    throw new K8sError('K8S_ERROR', 'kubectl answered something unreadable for your kubeconfig.');
  }
  const value = parseKubeconfig(doc);
  cache.set(key, { at: Date.now(), value });
  return value;
};

export const clearKubeconfigCache = (): void => cache.clear();

export const contextInfo = async (name: string, kubeconfig?: string): Promise<ContextInfo> => {
  const found = (await loadKubeconfig(kubeconfig)).contexts.find((info) => info.name === name);
  if (!found) throw new K8sError('NO_CONTEXT', `There is no cluster named "${name}" in your kubeconfig.`);
  return found;
};
