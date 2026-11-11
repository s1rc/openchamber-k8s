import { isLocked, isProtected, lock, setProtected, unlock, unlockedUntil } from '../shared/locks.ts';
import { forPanel } from '../shared/redact.ts';
import { isSecret, kindPath, RESTARTABLE, SCALABLE, type KindInfo } from '../shared/kinds.ts';
import {
  argoPatch,
  currentRevision,
  deploymentRevisions,
  drainIssue,
  drainKind,
  fluxPatch,
  manualJobFor,
  parseAuditLine,
  statefulSetRevisions,
  type AuditEntry,
  type Revision,
} from '../shared/ops.ts';
import type { ForwardKind, Obj, ScopeResult, Target } from '../shared/types.ts';
import { parseAllDocuments } from 'yaml';
import { K8sError } from './errors.ts';
import { callJson, resolveKind } from './k8s.ts';
import { contextInfo, loadKubeconfig } from './kubeconfig.ts';
import { createScopeCache, readAwsProfiles, resolveScope } from './scope.ts';
import { appendAudit, readAudit, readLocks, readPicks, writeLocks, writePick } from './state.ts';
import { kubeconfigArgs, kubectlPath, run } from './exec.ts';
import { createForward, listForwards, stopForward } from './forwards.ts';
import { closeAllLogs, renewLogLeases, startLogs, stopLogs } from './logs.ts';
import { closeAllWatches, openWatch, publish, renewLeases } from './watch.ts';

type Params = Record<string, unknown>;
export type RouteHandler = (params: Params) => Promise<Obj>;

const text = (params: Params, key: string): string | undefined => {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const need = (params: Params, key: string): string => {
  const value = text(params, key);
  if (!value) throw new K8sError('BAD_REQUEST', `Missing "${key}".`);
  return value;
};

const flag = (params: Params, key: string): boolean => params[key] === true || params[key] === 'true' || params[key] === '1' || params[key] === 1;

/** Absent, empty or `_all` all mean every namespace. */
const namespaceOf = (params: Params): string | null => {
  const value = text(params, 'namespace');
  return value && value !== '_all' ? value : null;
};

const scopes = createScopeCache((dir) =>
  resolveScope(dir, {
    loadContexts: async (kubeconfig) => (await loadKubeconfig(kubeconfig)).contexts,
    picks: readPicks(),
    awsProfiles: () => readAwsProfiles(),
  }),
);

export const scopeFor = (dir: string): Promise<ScopeResult | null> => scopes.get(dir);

/** The kubeconfig a project's env file named, only when it passed the safety check in the scope resolver. */
const targetFor = async (params: Params): Promise<Target> => {
  const context = need(params, 'context');
  const dir = text(params, 'dir');
  const kubeconfig = dir ? (await scopeFor(dir))?.kubeconfig : undefined;
  await contextInfo(context, kubeconfig);
  return kubeconfig ? { context, kubeconfig } : { context };
};

const guard = async (target: Target, dryRun: boolean): Promise<void> => {
  if (dryRun) return;
  const info = await contextInfo(target.context, target.kubeconfig);
  if (isLocked(readLocks(), info.name, info.arn, Date.now())) {
    throw new K8sError('LOCKED', `${info.name} is protected and locked. Unlock it to make changes.`, { kind: 'unlock', context: info.name });
  }
};

/** Tells every open frame where a context's lock stands, so the badge changes in the rail and the page together. */
const publishLock = async (params: Params): Promise<void> => {
  try {
    const target = await targetFor(params);
    const info = await contextInfo(target.context, target.kubeconfig);
    const locks = readLocks();
    const now = Date.now();
    publish('lock', { context: info.name, protected: isProtected(locks, info.name, info.arn), locked: isLocked(locks, info.name, info.arn, now), unlockedUntil: unlockedUntil(locks, info.name, now) });
  } catch {
    // The lock file is already written; a context missing from the kubeconfig has no badge to update.
  }
};

const panelObject = (info: KindInfo, object: Obj, reveal = false): Obj => forPanel(isSecret(info), object, reveal);

const audit = (params: Params, target: Target, verb: string, what: string): void => {
  appendAudit({ project: text(params, 'dir') ?? null, context: target.context, verb, target: what, source: 'panel' });
};

const writeNamespace = async (target: Target, info: KindInfo, params: Params): Promise<string | null> => {
  if (!info.namespaced) return null;
  const given = namespaceOf(params);
  if (given) return given;
  return (await contextInfo(target.context, target.kubeconfig)).namespace ?? 'default';
};

const parseManifest = (input: unknown): Obj[] => {
  let docs: unknown[] = [];
  if (typeof input === 'string') {
    for (const parsed of parseAllDocuments(input, { prettyErrors: false })) {
      if (parsed.errors.length > 0) throw new K8sError('INVALID', `The manifest is not valid YAML: ${parsed.errors[0]!.message.split('\n')[0]}`);
      const value = parsed.toJS() as unknown;
      if (value !== null && value !== undefined) docs.push(value);
    }
  } else if (Array.isArray(input)) docs = input;
  else if (input && typeof input === 'object') docs = [input];
  if (docs.length === 0) throw new K8sError('BAD_REQUEST', 'The manifest is empty.');
  if (docs.length > 50) throw new K8sError('BAD_REQUEST', 'A manifest can hold at most 50 documents.');
  return docs.map((doc) => {
    const object = doc as Obj;
    if (!object || typeof object !== 'object' || typeof object.apiVersion !== 'string' || typeof object.kind !== 'string' || typeof object.metadata?.name !== 'string') {
      throw new K8sError('INVALID', 'Every manifest needs apiVersion, kind and metadata.name.');
    }
    return object;
  });
};

const refOf = (info: KindInfo, namespace: string | null, name: string): string => `${info.kind}/${name}${namespace ? ` in ${namespace}` : ''}`;

export const routes: Record<string, RouteHandler> = {
  'GET /health': async () => ({ ok: true }),

  'GET /contexts': async (params) => {
    const dir = text(params, 'dir');
    const scope = dir ? await scopeFor(dir) : null;
    const config = await loadKubeconfig(scope?.kubeconfig);
    const locks = readLocks();
    const now = Date.now();
    return {
      ok: true,
      current: config.current,
      contexts: config.contexts.map((info) => {
        const until = unlockedUntil(locks, info.name, now);
        return {
          name: info.name,
          account: info.account,
          region: info.region,
          clusterName: info.clusterName,
          namespace: info.namespace,
          auth: info.auth,
          protected: isProtected(locks, info.name, info.arn),
          locked: isLocked(locks, info.name, info.arn, now),
          unlockedUntil: until,
        };
      }),
      scope,
    };
  },

  'GET /scope': async (params) => ({ ok: true, scope: await scopeFor(need(params, 'dir')) }),

  'POST /scope': async (params) => {
    const dir = need(params, 'dir');
    const context = need(params, 'context');
    const current = await scopeFor(dir);
    await contextInfo(context, current?.kubeconfig);
    writePick(dir, { context, namespace: namespaceOf(params), pickedAt: new Date().toISOString() });
    scopes.invalidate(dir);
    return { ok: true, scope: await scopeFor(dir) };
  },

  'POST /protect': async (params) => {
    const context = need(params, 'context');
    await contextInfo(context, (await targetFor(params)).kubeconfig);
    writeLocks(setProtected(readLocks(), context, flag(params, 'protected')));
    await publishLock(params);
    return { ok: true };
  },

  'POST /unlock': async (params) => {
    const target = await targetFor(params);
    const info = await contextInfo(target.context, target.kubeconfig);
    const next = unlock(readLocks(), info.name, Date.now());
    writeLocks(next);
    await publishLock(params);
    return { ok: true, unlockedUntil: unlockedUntil(next, info.name, Date.now()) };
  },

  'POST /lock': async (params) => {
    writeLocks(lock(readLocks(), need(params, 'context')));
    await publishLock(params);
    return { ok: true };
  },

  'GET /list': async (params) => {
    const target = await targetFor(params);
    const info = await resolveKind(target, need(params, 'kind'));
    const answer = await callJson(target, {
      path: kindPath(info, namespaceOf(params)),
      query: { labelSelector: text(params, 'selector'), fieldSelector: text(params, 'fieldSelector') },
      timeoutMs: 60_000,
    });
    return {
      ok: true,
      kind: info,
      resourceVersion: answer.metadata?.resourceVersion ?? '',
      items: ((answer.items ?? []) as Obj[]).map((item) => panelObject(info, item)),
    };
  },

  'GET /get': async (params) => {
    const target = await targetFor(params);
    const info = await resolveKind(target, need(params, 'kind'));
    const object = await callJson(target, { path: kindPath(info, await writeNamespace(target, info, params), need(params, 'name')) });
    return { ok: true, kind: info, object: panelObject(info, object, flag(params, 'reveal')) };
  },

  'POST /watch': async (params) => {
    const target = await targetFor(params);
    const info = await resolveKind(target, need(params, 'kind'));
    return { ok: true, kind: info, ...(await openWatch(target, info, namespaceOf(params))) };
  },

  'POST /watch/lease': async (params) => {
    const ids = Array.isArray(params.watchIds) ? params.watchIds.filter((id): id is string => typeof id === 'string') : [];
    const { known, unknown } = renewLeases(ids);
    if (unknown.length > 0) return { ok: false, code: 'UNKNOWN_WATCH', error: 'Some live views ended. Open them again.', known, unknown };
    return { ok: true, known, unknown };
  },

  'POST /apply': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const applied: Obj[] = [];
    for (const doc of parseManifest(params.manifest)) {
      const info = await resolveKind(target, String(doc.kind), String(doc.apiVersion));
      const namespace = info.namespaced ? (typeof doc.metadata.namespace === 'string' ? doc.metadata.namespace : await writeNamespace(target, info, params)) : null;
      const body = info.namespaced ? { ...doc, metadata: { ...doc.metadata, namespace } } : doc;
      const object = await callJson(target, {
        method: 'PATCH',
        path: kindPath(info, namespace, String(doc.metadata.name)),
        query: { fieldManager: 'openchamber-k8s', force: flag(params, 'force') ? 'true' : undefined, dryRun: dryRun ? 'All' : undefined },
        contentType: 'application/apply-patch+yaml',
        body: JSON.stringify(body),
      });
      if (!dryRun) audit(params, target, 'apply', refOf(info, namespace, String(doc.metadata.name)));
      applied.push(panelObject(info, object));
    }
    return { ok: true, dryRun, objects: applied };
  },

  'POST /delete': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, need(params, 'kind'));
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    await callJson(target, {
      method: 'DELETE',
      path: kindPath(info, namespace, name),
      query: { propagationPolicy: 'Background', dryRun: dryRun ? 'All' : undefined },
    });
    if (!dryRun) audit(params, target, 'delete', refOf(info, namespace, name));
    return { ok: true, dryRun };
  },

  'POST /scale': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, need(params, 'kind'));
    if (!SCALABLE.has(info.kind)) throw new K8sError('INVALID', `${info.kind} cannot be scaled.`);
    const replicas = Number(params.replicas);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 10_000) throw new K8sError('BAD_REQUEST', 'Replicas must be a whole number from 0 to 10000.');
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    await callJson(target, {
      method: 'PATCH',
      path: `${kindPath(info, namespace, name)}/scale`,
      query: { dryRun: dryRun ? 'All' : undefined },
      contentType: 'application/merge-patch+json',
      body: JSON.stringify({ spec: { replicas } }),
    });
    if (!dryRun) audit(params, target, `scale to ${replicas}`, refOf(info, namespace, name));
    return { ok: true, dryRun, replicas };
  },

  'POST /restart': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, need(params, 'kind'));
    if (!RESTARTABLE.has(info.kind)) throw new K8sError('INVALID', `${info.kind} cannot be restarted.`);
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    await callJson(target, {
      method: 'PATCH',
      path: kindPath(info, namespace, name),
      query: { dryRun: dryRun ? 'All' : undefined },
      contentType: 'application/strategic-merge-patch+json',
      body: JSON.stringify({ spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } }),
    });
    if (!dryRun) audit(params, target, 'restart', refOf(info, namespace, name));
    return { ok: true, dryRun };
  },

  'POST /cordon': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, 'Node');
    const name = need(params, 'name');
    const unschedulable = flag(params, 'unschedulable');
    await callJson(target, {
      method: 'PATCH',
      path: kindPath(info, null, name),
      query: { dryRun: dryRun ? 'All' : undefined },
      contentType: 'application/merge-patch+json',
      body: JSON.stringify({ spec: { unschedulable } }),
    });
    if (!dryRun) audit(params, target, unschedulable ? 'cordon' : 'uncordon', `Node/${name}`);
    return { ok: true, dryRun, unschedulable };
  },

  /** The pods a drain would remove, for the confirm step. A read: no write, no dry run. */
  'GET /drain': async (params) => {
    const target = await targetFor(params);
    const name = need(params, 'name');
    const pods = await callJson(target, { path: '/api/v1/pods', query: { fieldSelector: `spec.nodeName=${name}` }, timeoutMs: 60_000 });
    return {
      ok: true,
      pods: ((pods.items ?? []) as Obj[]).map((pod) => ({
        name: String(pod.metadata?.name ?? ''),
        namespace: String(pod.metadata?.namespace ?? ''),
        kind: drainKind(pod),
        problem: drainIssue(pod),
      })),
    };
  },

  'POST /drain': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const name = need(params, 'name');
    const result = await run(
      kubectlPath(),
      ['--context', target.context, ...kubeconfigArgs(target.kubeconfig), 'drain', name, '--ignore-daemonsets', '--delete-emptydir-data', '--timeout=120s', ...(dryRun ? ['--dry-run=server'] : [])],
      { timeoutMs: 180_000, maxBuffer: 2_000_000 },
    );
    if (result.code !== 0) throw new K8sError('K8S_ERROR', (result.stderr || result.stdout).trim().slice(0, 400) || 'The drain did not finish.');
    if (!dryRun) audit(params, target, 'drain', `Node/${name}`);
    return { ok: true, dryRun, output: result.stdout.trim() };
  },

  'POST /evict': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const namespace = namespaceOf(params) ?? 'default';
    const name = need(params, 'name');
    await callJson(target, {
      method: 'POST',
      path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/eviction`,
      query: { dryRun: dryRun ? 'All' : undefined },
      body: JSON.stringify({ apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name, namespace } }),
    });
    if (!dryRun) audit(params, target, 'evict', `Pod/${name} in ${namespace}`);
    return { ok: true, dryRun };
  },

  'GET /revisions': async (params) => {
    const target = await targetFor(params);
    const info = await resolveKind(target, need(params, 'kind'));
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    const object = await callJson(target, { path: kindPath(info, namespace, name) });
    let revisions: Revision[] = [];
    let current: number | null = null;
    if (info.kind === 'Deployment') {
      const replicaSets = await callJson(target, { path: kindPath(await resolveKind(target, 'ReplicaSet'), namespace), timeoutMs: 60_000 });
      revisions = deploymentRevisions(object, (replicaSets.items ?? []) as Obj[]);
      current = currentRevision(object);
    } else if (info.kind === 'StatefulSet') {
      const history = await callJson(target, { path: kindPath(await resolveKind(target, 'ControllerRevision'), namespace), timeoutMs: 60_000 });
      revisions = statefulSetRevisions(object, (history.items ?? []) as Obj[]);
      current = revisions[0]?.revision ?? null;
    } else throw new K8sError('INVALID', `${info.kind} keeps no revision history.`);
    return {
      ok: true,
      current,
      revisions: revisions.map((rev) => ({
        revision: rev.revision,
        name: rev.name,
        created: rev.created,
        images: ((rev.template?.spec?.containers ?? []) as Obj[]).map((container) => String(container.image ?? '')),
      })),
    };
  },

  'POST /rollback': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, need(params, 'kind'));
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    const revision = Number(params.revision);
    if (!Number.isInteger(revision)) throw new K8sError('BAD_REQUEST', 'Pick a revision to roll back to.');
    const object = await callJson(target, { path: kindPath(info, namespace, name) });
    let revisions: Revision[] = [];
    if (info.kind === 'Deployment') {
      const replicaSets = await callJson(target, { path: kindPath(await resolveKind(target, 'ReplicaSet'), namespace), timeoutMs: 60_000 });
      revisions = deploymentRevisions(object, (replicaSets.items ?? []) as Obj[]);
    } else if (info.kind === 'StatefulSet') {
      const history = await callJson(target, { path: kindPath(await resolveKind(target, 'ControllerRevision'), namespace), timeoutMs: 60_000 });
      revisions = statefulSetRevisions(object, (history.items ?? []) as Obj[]);
    } else throw new K8sError('INVALID', `${info.kind} cannot be rolled back.`);
    const chosen = revisions.find((entry) => entry.revision === revision);
    if (!chosen?.template) throw new K8sError('NOT_FOUND', `Revision ${revision} is no longer available.`);
    await callJson(target, {
      method: 'PATCH',
      path: kindPath(info, namespace, name),
      query: { dryRun: dryRun ? 'All' : undefined },
      contentType: 'application/json-patch+json',
      body: JSON.stringify([{ op: 'replace', path: '/spec/template', value: chosen.template }]),
    });
    if (!dryRun) audit(params, target, `rollback to ${revision}`, refOf(info, namespace, name));
    return { ok: true, dryRun, revision };
  },

  'POST /trigger': async (params) => {
    const target = await targetFor(params);
    await guard(target, false);
    const info = await resolveKind(target, 'CronJob');
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    const cronJob = await callJson(target, { path: kindPath(info, namespace, name) });
    const job = manualJobFor(cronJob, new Date());
    const jobInfo = await resolveKind(target, 'Job');
    const created = await callJson(target, { method: 'POST', path: kindPath(jobInfo, namespace), body: JSON.stringify(job) });
    audit(params, target, 'trigger', `CronJob/${name} in ${namespace}`);
    return { ok: true, job: String(created.metadata?.name ?? '') };
  },

  'POST /pause': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, 'Deployment');
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    const paused = flag(params, 'paused');
    await callJson(target, {
      method: 'PATCH',
      path: kindPath(info, namespace, name),
      query: { dryRun: dryRun ? 'All' : undefined },
      contentType: 'application/merge-patch+json',
      body: JSON.stringify({ spec: { paused } }),
    });
    if (!dryRun) audit(params, target, paused ? 'pause' : 'resume', refOf(info, namespace, name));
    return { ok: true, dryRun, paused };
  },

  'POST /suspend': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, need(params, 'kind'), text(params, 'apiVersion'));
    if (info.kind !== 'CronJob' && !/toolkit\.fluxcd\.io/.test(info.group)) throw new K8sError('INVALID', `${info.kind} cannot be suspended.`);
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    const suspend = flag(params, 'suspend');
    await callJson(target, {
      method: 'PATCH',
      path: kindPath(info, namespace, name),
      query: { dryRun: dryRun ? 'All' : undefined },
      contentType: 'application/merge-patch+json',
      body: JSON.stringify(fluxPatch(suspend ? 'suspend' : 'resume', new Date())),
    });
    if (!dryRun) audit(params, target, suspend ? 'suspend' : 'resume', refOf(info, namespace, name));
    return { ok: true, dryRun, suspend };
  },

  'POST /flux': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, need(params, 'kind'), text(params, 'apiVersion'));
    if (!/toolkit\.fluxcd\.io/.test(info.group)) throw new K8sError('INVALID', `${info.kind} is not a Flux resource.`);
    const action = need(params, 'action');
    if (action !== 'reconcile' && action !== 'suspend' && action !== 'resume') throw new K8sError('BAD_REQUEST', 'Unknown Flux action.');
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    await callJson(target, {
      method: 'PATCH',
      path: kindPath(info, namespace, name),
      query: { dryRun: dryRun ? 'All' : undefined },
      contentType: 'application/merge-patch+json',
      body: JSON.stringify(fluxPatch(action, new Date())),
    });
    if (!dryRun) audit(params, target, `flux ${action}`, refOf(info, namespace, name));
    return { ok: true, dryRun, action };
  },

  'POST /argo': async (params) => {
    const target = await targetFor(params);
    const dryRun = flag(params, 'dryRun');
    await guard(target, dryRun);
    const info = await resolveKind(target, need(params, 'kind'), text(params, 'apiVersion') ?? 'argoproj.io/v1alpha1');
    if (!info.group.startsWith('argoproj.io')) throw new K8sError('INVALID', `${info.kind} is not an Argo CD resource.`);
    const action = need(params, 'action');
    if (action !== 'refresh' && action !== 'sync') throw new K8sError('BAD_REQUEST', 'Unknown Argo CD action.');
    const namespace = await writeNamespace(target, info, params);
    const name = need(params, 'name');
    await callJson(target, {
      method: 'PATCH',
      path: kindPath(info, namespace, name),
      query: { dryRun: dryRun ? 'All' : undefined },
      contentType: 'application/merge-patch+json',
      body: JSON.stringify(argoPatch(action, text(params, 'revision'))),
    });
    if (!dryRun) audit(params, target, `argo ${action}`, refOf(info, namespace, name));
    return { ok: true, dryRun, action };
  },

  'POST /console': async (params) => {
    const target = await targetFor(params);
    const namespace = need(params, 'namespace');
    const pod = need(params, 'pod');
    const container = text(params, 'container');
    const command = need(params, 'command');
    if (command.length > 4000) throw new K8sError('BAD_REQUEST', 'A command can hold at most 4000 characters.');
    const result = await run(
      kubectlPath(),
      ['--context', target.context, ...kubeconfigArgs(target.kubeconfig), '-n', namespace, 'exec', pod, ...(container ? ['-c', container] : []), '--', 'sh', '-c', command],
      { timeoutMs: 30_000, maxBuffer: 1_000_000 },
    );
    audit(params, target, 'exec', `Pod/${pod} in ${namespace}`);
    return { ok: true, output: result.stdout, errorOutput: result.stderr, code: result.code };
  },

  'POST /logs': async (params) => {
    const target = await targetFor(params);
    const namespace = need(params, 'namespace');
    const pod = need(params, 'pod');
    const handle = await startLogs({
      target,
      namespace,
      pod,
      container: text(params, 'container'),
      previous: flag(params, 'previous'),
      timestamps: flag(params, 'timestamps'),
      tailLines: Number(params.tailLines) || 500,
    });
    return { ok: true, ...handle };
  },

  'POST /logs/lease': async (params) => {
    const ids = Array.isArray(params.streamIds) ? params.streamIds.filter((id): id is string => typeof id === 'string') : [];
    const { known, unknown } = renewLogLeases(ids);
    if (unknown.length > 0) return { ok: false, code: 'UNKNOWN_WATCH', error: 'Some log views ended. Open them again.', known, unknown };
    return { ok: true, known, unknown };
  },

  'POST /logs/stop': async (params) => {
    const id = text(params, 'streamId');
    if (id) stopLogs(id);
    return { ok: true };
  },

  'GET /forwards': async () => ({ ok: true, forwards: listForwards() }),

  'POST /forward': async (params) => {
    const target = await targetFor(params);
    const resource = need(params, 'resource');
    if (resource !== 'pod' && resource !== 'service' && resource !== 'svc') throw new K8sError('BAD_REQUEST', 'A forward targets a pod or a service.');
    const kind: ForwardKind = resource === 'pod' ? 'pod' : 'svc';
    const namespace = need(params, 'namespace');
    const name = need(params, 'name');
    const remotePort = Number(params.remotePort);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new K8sError('BAD_REQUEST', 'Pick a port from 1 to 65535.');
    const localPort = params.localPort === undefined || params.localPort === null || params.localPort === '' ? undefined : Number(params.localPort);
    if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) throw new K8sError('BAD_REQUEST', 'Pick a local port from 1 to 65535.');
    const forward = await createForward({
      context: target.context,
      ...(!target.kubeconfig ? {} : { kubeconfig: target.kubeconfig }),
      namespace,
      kind,
      name,
      ...(localPort === undefined ? {} : { localPort }),
      remotePort,
    });
    return { ok: true, forward };
  },

  'POST /forward/stop': async (params) => {
    const id = need(params, 'id');
    stopForward(id);
    return { ok: true, forwards: listForwards() };
  },

  'GET /audit': async (params) => {
    const limit = Math.min(500, Math.max(1, Number(params.limit) || 100));
    const project = text(params, 'dir');
    const context = text(params, 'context');
    const entries = readAudit(limit * 4)
      .map(parseAuditLine)
      .filter((entry): entry is AuditEntry => entry !== null)
      .filter((entry) => (!project || entry.project === project) && (!context || entry.context === context))
      .slice(-limit)
      .reverse();
    return { ok: true, entries };
  },
};

export const shutdownRoutes = (): void => {
  closeAllWatches();
  closeAllLogs();
};
