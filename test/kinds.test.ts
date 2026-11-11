import { describe, expect, test } from 'bun:test';
import { findKind, findKindByApiVersion, isSecret, kindPath, KINDS } from '../src/shared/kinds.ts';

describe('findKind', () => {
  test('matches kind, plural and short name, case-insensitive', () => {
    for (const word of ['Deployment', 'deployments', 'deploy', 'DEPLOY']) expect(findKind(word)?.kind).toBe('Deployment');
    expect(findKind('po')?.kind).toBe('Pod');
    expect(findKind('nothing')).toBeUndefined();
  });

  test('has no duplicate kinds or plurals', () => {
    expect(new Set(KINDS.map((info) => `${info.group}/${info.kind}`)).size).toBe(KINDS.length);
    expect(new Set(KINDS.map((info) => `${info.group}/${info.plural}`)).size).toBe(KINDS.length);
  });

  test('findKindByApiVersion follows the version it is given', () => {
    expect(findKindByApiVersion('apps/v1', 'Deployment')?.plural).toBe('deployments');
    expect(findKindByApiVersion('autoscaling/v1', 'HorizontalPodAutoscaler')?.version).toBe('v1');
    expect(findKindByApiVersion('v1', 'ConfigMap')?.group).toBe('');
    expect(findKindByApiVersion('example.io/v1', 'Widget')).toBeUndefined();
  });
});

describe('kindPath', () => {
  const pod = findKind('pod')!;
  const deploy = findKind('deploy')!;
  const node = findKind('node')!;

  test('core and grouped kinds', () => {
    expect(kindPath(pod, 'gm', 'api-1')).toBe('/api/v1/namespaces/gm/pods/api-1');
    expect(kindPath(deploy, 'gm')).toBe('/apis/apps/v1/namespaces/gm/deployments');
  });

  test('all namespaces and cluster-scoped kinds', () => {
    expect(kindPath(pod, null)).toBe('/api/v1/pods');
    expect(kindPath(node, 'gm', 'n1')).toBe('/api/v1/nodes/n1');
  });

  test('encodes names', () => {
    expect(kindPath(pod, 'a b', 'x/y')).toBe('/api/v1/namespaces/a%20b/pods/x%2Fy');
  });

  test('only the core Secret is a Secret', () => {
    expect(isSecret(findKind('secret')!)).toBe(true);
    expect(isSecret({ kind: 'Secret', group: 'external-secrets.io' })).toBe(false);
  });
});
