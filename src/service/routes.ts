import { isLocked, isProtected, lock, setProtected, unlock, unlockedUntil } from '../shared/locks.ts';
import { forPanel } from '../shared/redact.ts';
import { isSecret, kindPath, RESTARTABLE, SCALABLE, type KindInfo } from '../shared/kinds.ts';
import type { Obj, ScopeResult, Target } from '../shared/types.ts';
import { parseAllDocuments } from 'yaml';
import { K8sError } from './errors.ts';
import { callJson, resolveKind } from './k8s.ts';
import { contextInfo, loadKubeconfig } from './kubeconfig.ts';
import { createScopeCache, readAwsProfiles, resolveScope } from './scope.ts';
import { appendAudit, readLocks, readPicks, writeLocks, writePick } from './state.ts';
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
};

export const shutdownRoutes = (): void => closeAllWatches();
