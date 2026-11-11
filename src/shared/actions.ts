// What the Actions menu offers for an object. Pure, so the panel and tests agree.
import type { Obj } from './types.ts';

export type ActionId =
  | 'logs'
  | 'shell'
  | 'console'
  | 'port-forward'
  | 'edit'
  | 'delete'
  | 'evict'
  | 'scale'
  | 'restart'
  | 'rollback'
  | 'toggle-pause'
  | 'trigger'
  | 'toggle-suspend'
  | 'cordon'
  | 'uncordon'
  | 'drain'
  | 'reveal'
  | 'reconcile'
  | 'sync'
  | 'refresh'
  | 'copy-name'
  | 'copy-yaml';

export interface ActionSpec {
  id: ActionId;
  label: string;
  destructive?: boolean;
  /** A separator before this entry, to group remote actions. */
  groupStart?: boolean;
}

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

const apiOf = (object: Obj): string => String(object.apiVersion ?? '');
export const isFlux = (object: Obj): boolean => /toolkit\.fluxcd\.io\//.test(apiOf(object));
export const isArgoApplication = (object: Obj): boolean => apiOf(object).startsWith('argoproj.io/') && object.kind === 'Application';

const suspended = (object: Obj): boolean => object.spec?.suspend === true || object.spec?.paused === true;

/** The menu for one object, in the order the plan lists. The last three are always there. */
export const actionsFor = (object: Obj): ActionSpec[] => {
  const kind = String(object.kind ?? '');
  const items: ActionSpec[] = [];
  const add = (id: ActionId, label: string, extra: Partial<ActionSpec> = {}): void => {
    if (!items.some((item) => item.id === id || item.label === label)) items.push({ id, label, ...extra });
  };
  // The per-kind lists above decide for themselves; every other kind gets the common entries.
  const listed = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Node', 'Service', 'Secret'].includes(kind);

  if (kind === 'Pod') {
    add('logs', 'Logs');
    add('shell', 'Copy shell command');
    add('console', 'Console');
    add('port-forward', 'Port forward');
    add('edit', 'Edit');
    add('evict', 'Evict', { destructive: true, groupStart: true });
    add('delete', 'Delete', { destructive: true });
  } else if (WORKLOADS.has(kind)) {
    add('logs', 'Logs');
    add('scale', 'Scale');
    add('restart', 'Restart');
    if (kind !== 'DaemonSet') add('rollback', 'Rollback');
    if (kind === 'Deployment') add('toggle-pause', suspended(object) ? 'Resume' : 'Pause');
    add('edit', 'Edit', { groupStart: true });
    add('delete', 'Delete', { destructive: true });
  } else if (kind === 'CronJob') {
    add('trigger', 'Trigger now');
    add('toggle-suspend', suspended(object) ? 'Resume' : 'Suspend');
    add('edit', 'Edit', { groupStart: true });
    add('delete', 'Delete', { destructive: true });
  } else if (kind === 'Job') {
    add('logs', 'Logs');
    add('delete', 'Delete', { destructive: true });
  } else if (kind === 'Node') {
    add('cordon', 'Cordon');
    add('uncordon', 'Uncordon');
    add('drain', 'Drain', { destructive: true, groupStart: true });
    add('shell', 'Copy node shell command');
  } else if (kind === 'Service') {
    add('port-forward', 'Port forward');
    add('edit', 'Edit');
    add('delete', 'Delete', { destructive: true });
  } else if (kind === 'Secret') {
    add('reveal', 'Reveal values');
    add('edit', 'Edit');
    add('delete', 'Delete', { destructive: true });
  }

  if (isFlux(object)) {
    add('reconcile', 'Reconcile', { groupStart: items.length > 0 });
    add('toggle-suspend', /Kustomization|HelmRelease/.test(kind) ? (suspended(object) ? 'Resume' : 'Suspend') : 'Suspend');
  }
  if (isArgoApplication(object)) {
    add('refresh', 'Refresh', { groupStart: items.length > 0 });
    add('sync', 'Sync', { groupStart: false });
  }

  add('copy-name', 'Copy name', { groupStart: items.length > 0 });
  add('copy-yaml', 'Copy YAML');

  if (!items.some((item) => item.id === 'edit') && !listed) add('edit', 'Edit');
  if (!items.some((item) => item.id === 'delete') && !listed) add('delete', 'Delete', { destructive: true });

  return items;
};
