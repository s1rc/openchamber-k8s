import { entriesFromCrds, type CrdEntry } from '../shared/crds.ts';
import type { Obj, Target } from '../shared/types.ts';
import { callJson, discoverAll, forgetDiscovery } from './k8s.ts';
import { targetKey } from './proxy.ts';

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; entries: CrdEntry[] }>();

/**
 * The cluster's custom resource definitions, compact: kind, group, scope, the served version and the printer columns.
 * The CRD list can be large (every schema comes with it), so it is read once a minute at most and only the small part is kept.
 */
export const readCrds = async (target: Target, refresh = false): Promise<CrdEntry[]> => {
  const key = targetKey(target);
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.entries;
  if (refresh) forgetDiscovery(target);
  const [list, kinds] = await Promise.all([
    callJson(target, { path: '/apis/apiextensions.k8s.io/v1/customresourcedefinitions', timeoutMs: 60_000 }),
    discoverAll(target).catch(() => []),
  ]);
  const served = new Map(kinds.map((info) => [`${info.group}|${info.plural}`, info.version]));
  const entries = entriesFromCrds((list.items ?? []) as Obj[], (group, plural) => served.get(`${group}|${plural}`));
  cache.set(key, { at: Date.now(), entries });
  return entries;
};

export const forgetCrds = (target: Target): void => {
  cache.delete(targetKey(target));
};
