// Pure helpers for the actions the panel asks the service to run. No I/O, so they run in tests.
import type { Obj } from './types.ts';

const arr = (value: unknown): Obj[] => (Array.isArray(value) ? (value as Obj[]) : []);
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

/** A manual run of a CronJob: the job template, named after the CronJob, owned by it. */
export const manualJobFor = (cronJob: Obj, now: Date): Obj => {
  const template = (cronJob.spec?.jobTemplate ?? {}) as Obj;
  const name = text(cronJob.metadata?.name);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return {
    ...template,
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      ...(template.metadata ?? {}),
      name: `${name}-manual-${stamp}`,
      namespace: text(cronJob.metadata?.namespace),
      annotations: { ...(template.metadata?.annotations ?? {}), 'cronjob.kubernetes.io/instantiate': 'manual' },
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'CronJob',
          name,
          uid: text(cronJob.metadata?.uid),
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
  };
};

export interface Revision {
  revision: number;
  name: string;
  /** The pod template at that revision, or null when the object has none (unknown revision). */
  template: Obj | null;
  created: string | null;
}

/** The revision number a ReplicaSet holds, from its deployment annotation. */
export const replicaSetRevision = (replicaSet: Obj): number | null => {
  const raw = Number(replicaSet.metadata?.annotations?.['deployment.kubernetes.io/revision']);
  return Number.isInteger(raw) ? raw : null;
};

/** Revision history for a Deployment, newest first, from its ReplicaSets. */
export const deploymentRevisions = (deployment: Obj, replicaSets: Obj[]): Revision[] => {
  const uid = text(deployment.metadata?.uid);
  return replicaSets
    .filter((rs) => arr(rs.metadata?.ownerReferences).some((owner) => owner.kind === 'Deployment' && (text(owner.uid) === uid || text(owner.name) === text(deployment.metadata?.name))))
    .map((rs) => ({ revision: replicaSetRevision(rs), name: text(rs.metadata?.name), template: (rs.spec?.template ?? null) as Obj | null, created: rs.metadata?.creationTimestamp ?? null }))
    .filter((entry): entry is Revision => entry.revision !== null)
    .sort((a, b) => b.revision - a.revision);
};

/** Revision history for a StatefulSet, from its ControllerRevisions. */
export const statefulSetRevisions = (statefulSet: Obj, revisions: Obj[]): Revision[] => {
  const uid = text(statefulSet.metadata?.uid);
  return revisions
    .filter((cr) => arr(cr.metadata?.ownerReferences).some((owner) => owner.kind === 'StatefulSet' && (text(owner.uid) === uid || text(owner.name) === text(statefulSet.metadata?.name))))
    .map((cr) => ({ revision: Number.isInteger(cr.revision) ? cr.revision : null, name: text(cr.metadata?.name), template: (cr.data?.raw ?? null) as Obj | null, created: cr.metadata?.creationTimestamp ?? null }))
    .filter((entry): entry is Revision => entry.revision !== null && entry.template !== null)
    .sort((a, b) => b.revision - a.revision);
};

/** The current revision of a Deployment, from its annotation. */
export const currentRevision = (object: Obj): number | null => {
  const raw = Number(object.metadata?.annotations?.['deployment.kubernetes.io/revision']);
  return Number.isInteger(raw) ? raw : null;
};

/** A pod that cannot leave a node cleanly, and why. DaemonSet pods and emptyDir data are handled by the flags drain uses. */
export const drainIssue = (pod: Obj): string | null => {
  if (pod.metadata?.annotations?.['kubernetes.io/config.mirror']) return 'A static pod; it cannot be evicted.';
  const owners = arr(pod.metadata?.ownerReferences);
  if (owners.length === 0) return 'No controller owns it; drain would delete it.';
  if (owners.some((owner) => owner.kind === 'DaemonSet')) return null;
  return null;
};

/** The labels the panel shows next to a pod in the drain dialog. */
export const drainKind = (pod: Obj): string => {
  const owners = arr(pod.metadata?.ownerReferences);
  const owner = owners.find((entry) => entry.controller) ?? owners[0];
  return owner ? `${text(owner.kind)}/${text(owner.name)}` : 'No controller';
};

export type FluxAction = 'reconcile' | 'suspend' | 'resume';

/** The merge patch for a Flux reconcile, suspend or resume. */
export const fluxPatch = (action: FluxAction, now: Date): Obj => {
  if (action === 'reconcile') return { metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': now.toISOString() } } };
  return { spec: { suspend: action === 'suspend' } };
};

export type ArgoAction = 'refresh' | 'sync';

/** The merge patch for an Argo CD refresh or sync. A sync without a revision follows the app's own target. */
export const argoPatch = (action: ArgoAction, revision?: string): Obj => {
  if (action === 'refresh') return { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } };
  return { operation: { sync: revision ? { revision } : {} } };
};

export interface AuditEntry {
  time: string;
  project: string | null;
  context: string;
  verb: string;
  target: string;
  source: 'panel' | 'agent';
}

/** Parses one line of audit.log; null for a line that is not an entry. */
export const parseAuditLine = (line: string): AuditEntry | null => {
  try {
    const value = JSON.parse(line) as Partial<AuditEntry>;
    if (typeof value.time !== 'string' || typeof value.context !== 'string' || typeof value.verb !== 'string' || typeof value.target !== 'string') return null;
    return {
      time: value.time,
      project: typeof value.project === 'string' ? value.project : null,
      context: value.context,
      verb: value.verb,
      target: value.target,
      source: value.source === 'agent' ? 'agent' : 'panel',
    };
  } catch {
    return null;
  }
};

/** `27:41` left of an unlock, or `0:00` once it has passed. */
export const remainingText = (untilMs: number, nowMs: number): string => {
  const left = Math.max(0, Math.floor((untilMs - nowMs) / 1000));
  const minutes = Math.floor(left / 60);
  return `${minutes}:${String(left % 60).padStart(2, '0')}`;
};
