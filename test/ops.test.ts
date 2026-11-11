import { describe, expect, test } from 'bun:test';
import {
  argoPatch,
  currentRevision,
  deploymentRevisions,
  drainIssue,
  drainKind,
  fluxPatch,
  manualJobFor,
  parseAuditLine,
  remainingText,
  replicaSetRevision,
  statefulSetRevisions,
} from '../src/shared/ops.ts';
import type { Obj } from '../src/shared/types.ts';

describe('manualJobFor', () => {
  const cronJob: Obj = {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: 'cleanup', namespace: 'ops', uid: 'u1' },
    spec: {
      jobTemplate: {
        metadata: { labels: { app: 'cleanup' } },
        spec: { template: { spec: { containers: [{ name: 'c', image: 'busybox' }] } } },
      },
    },
  };
  const job = manualJobFor(cronJob, new Date('2026-01-02T03:04:05.000Z'));

  test('names the job after the CronJob and the time', () => {
    expect(job.metadata.name).toBe('cleanup-manual-20260102-030405');
    expect(job.metadata.namespace).toBe('ops');
    expect(job.kind).toBe('Job');
    expect(job.apiVersion).toBe('batch/v1');
  });

  test('keeps the template and marks the run manual', () => {
    expect(job.spec.template.spec.containers[0].image).toBe('busybox');
    expect(job.metadata.labels.app).toBe('cleanup');
    expect(job.metadata.annotations['cronjob.kubernetes.io/instantiate']).toBe('manual');
  });

  test('is owned by the CronJob', () => {
    expect(job.metadata.ownerReferences[0]).toMatchObject({ kind: 'CronJob', name: 'cleanup', uid: 'u1', controller: true });
  });
});

describe('revisions', () => {
  const deployment: Obj = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'web', uid: 'd1', annotations: { 'deployment.kubernetes.io/revision': '4' } },
  };
  const replicaSets: Obj[] = [
    { metadata: { name: 'api-1', uid: 'r1', ownerReferences: [{ kind: 'Deployment', name: 'api', uid: 'd1' }], annotations: { 'deployment.kubernetes.io/revision': '1' } }, spec: { template: { spec: { containers: [{ image: 'one' }] } } } },
    { metadata: { name: 'api-3', uid: 'r3', ownerReferences: [{ kind: 'Deployment', name: 'api', uid: 'd1' }], annotations: { 'deployment.kubernetes.io/revision': '3' } }, spec: { template: { spec: { containers: [{ image: 'three' }] } } } },
    { metadata: { name: 'other', uid: 'r9', ownerReferences: [{ kind: 'Deployment', name: 'other', uid: 'd2' }], annotations: { 'deployment.kubernetes.io/revision': '9' } } },
    { metadata: { name: 'no-rev', uid: 'r0', ownerReferences: [{ kind: 'Deployment', name: 'api', uid: 'd1' }] } },
  ];

  test('lists a Deployment history newest first, owned only', () => {
    const history = deploymentRevisions(deployment, replicaSets);
    expect(history.map((entry) => entry.revision)).toEqual([3, 1]);
    expect(history[0]?.template?.spec.containers[0].image).toBe('three');
  });

  test('reads the current revision and a ReplicaSet revision', () => {
    expect(currentRevision(deployment)).toBe(4);
    expect(replicaSetRevision(replicaSets[1]!)).toBe(3);
    expect(replicaSetRevision(replicaSets[3]!)).toBeNull();
  });

  test('reads a StatefulSet history from its ControllerRevisions', () => {
    const statefulSet: Obj = { metadata: { name: 'db', uid: 's1' } };
    const revisions: Obj[] = [
      { metadata: { name: 'db-2', ownerReferences: [{ kind: 'StatefulSet', uid: 's1' }] }, revision: 2, data: { raw: { spec: { containers: [{ image: 'two' }] } } } },
      { metadata: { name: 'db-1', ownerReferences: [{ kind: 'StatefulSet', uid: 's1' }] }, revision: 1, data: { raw: { spec: { containers: [{ image: 'one' }] } } } },
      { metadata: { name: 'other', ownerReferences: [{ kind: 'StatefulSet', uid: 's2' }] }, revision: 7, data: { raw: {} } },
    ];
    const history = statefulSetRevisions(statefulSet, revisions);
    expect(history.map((entry) => entry.revision)).toEqual([2, 1]);
  });
});

describe('drain helpers', () => {
  test('flags static and unowned pods', () => {
    expect(drainIssue({ metadata: { annotations: { 'kubernetes.io/config.mirror': 'x' } } })).toContain('static');
    expect(drainIssue({ metadata: {} })).toContain('No controller');
    expect(drainIssue({ metadata: { ownerReferences: [{ kind: 'ReplicaSet', name: 'rs' }] } })).toBeNull();
  });

  test('names the controller', () => {
    expect(drainKind({ metadata: { ownerReferences: [{ kind: 'ReplicaSet', name: 'api-1', controller: true }, { kind: 'Deployment', name: 'api' }] } })).toBe('ReplicaSet/api-1');
    expect(drainKind({ metadata: {} })).toBe('No controller');
  });
});

describe('Flux and Argo patches', () => {
  test('Flux reconcile stamps an annotation and suspend sets the flag', () => {
    expect(fluxPatch('reconcile', new Date('2026-01-02T03:04:05.000Z'))).toEqual({ metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': '2026-01-02T03:04:05.000Z' } } });
    expect(fluxPatch('suspend', new Date())).toEqual({ spec: { suspend: true } });
    expect(fluxPatch('resume', new Date())).toEqual({ spec: { suspend: false } });
  });

  test('Argo refresh and sync patches', () => {
    expect(argoPatch('refresh')).toEqual({ metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } });
    expect(argoPatch('sync')).toEqual({ operation: { sync: {} } });
    expect(argoPatch('sync', 'abc123')).toEqual({ operation: { sync: { revision: 'abc123' } } });
  });
});

describe('audit and countdown', () => {
  test('parses a written entry and skips junk', () => {
    const line = JSON.stringify({ time: '2026-01-02T03:04:05.000Z', project: '/repo', context: 'ctx', verb: 'scale to 2', target: 'Deployment/api', source: 'panel' });
    expect(parseAuditLine(line)).toMatchObject({ verb: 'scale to 2', source: 'panel' });
    expect(parseAuditLine('not json')).toBeNull();
    expect(parseAuditLine('{"time":"x"}')).toBeNull();
    expect(parseAuditLine(JSON.stringify({ time: 't', context: 'c', verb: 'v', target: 't', source: 'agent' }))?.source).toBe('agent');
  });

  test('counts the unlock down', () => {
    const now = Date.parse('2026-01-02T03:00:00.000Z');
    expect(remainingText(now + 27 * 60_000 + 41_000, now)).toBe('27:41');
    expect(remainingText(now + 5_000, now)).toBe('0:05');
    expect(remainingText(now - 5_000, now)).toBe('0:00');
  });
});
