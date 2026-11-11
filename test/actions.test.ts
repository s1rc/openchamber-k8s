import { describe, expect, test } from 'bun:test';
import { actionsFor, isArgoApplication, isFlux } from '../src/shared/actions.ts';
import type { Obj } from '../src/shared/types.ts';

const ids = (object: Obj): string[] => actionsFor(object).map((action) => action.id);

const pod: Obj = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' } };
const deployment: Obj = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'd' }, spec: { replicas: 2 } };
const cronJob: Obj = { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'c' }, spec: {} };
const node: Obj = { apiVersion: 'v1', kind: 'Node', metadata: { name: 'n' } };
const configMap: Obj = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' } };
const flux: Obj = { apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization', metadata: { name: 'k' }, spec: {} };
const argo: Obj = { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name: 'a' } };

describe('actionsFor', () => {
  test('a pod has logs, shell, console, forward, edit and the destructive pair', () => {
    expect(ids(pod)).toEqual(['logs', 'shell', 'console', 'port-forward', 'edit', 'evict', 'delete', 'copy-name', 'copy-yaml']);
  });

  test('a deployment has scale, restart, rollback and pause, and no pause for a DaemonSet', () => {
    expect(ids(deployment)).toEqual(['logs', 'scale', 'restart', 'rollback', 'toggle-pause', 'edit', 'delete', 'copy-name', 'copy-yaml']);
    const daemonSet: Obj = { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'ds' }, spec: {} };
    expect(ids(daemonSet)).not.toContain('rollback');
  });

  test('pause and suspend labels follow the object', () => {
    const paused = { ...deployment, spec: { replicas: 2, paused: true } };
    expect(actionsFor(paused).find((action) => action.id === 'toggle-pause')?.label).toBe('Resume');
    const suspended = { ...cronJob, spec: { suspend: true } };
    expect(actionsFor(suspended).find((action) => action.id === 'toggle-suspend')?.label).toBe('Resume');
  });

  test('a node offers cordon, uncordon and drain, never delete', () => {
    expect(ids(node)).toEqual(['cordon', 'uncordon', 'drain', 'shell', 'copy-name', 'copy-yaml']);
  });

  test('a kind with no list of its own gets edit and delete', () => {
    expect(ids(configMap)).toEqual(['copy-name', 'copy-yaml', 'edit', 'delete']);
  });

  test('Flux and Argo actions appear only for their own resources', () => {
    expect(isFlux(flux)).toBe(true);
    expect(ids(flux)).toContain('reconcile');
    expect(ids(flux)).toContain('toggle-suspend');
    expect(isArgoApplication(argo)).toBe(true);
    expect(ids(argo)).toContain('refresh');
    expect(ids(argo)).toContain('sync');
    expect(ids(deployment)).not.toContain('sync');
  });

  test('no action repeat and every id is unique', () => {
    for (const object of [pod, deployment, cronJob, node, configMap, flux, argo]) {
      const list = ids(object);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  test('group starts only mark a separator worth drawing', () => {
    for (const object of [pod, deployment, node, argo]) {
      expect(actionsFor(object).some((action) => action.groupStart)).toBe(true);
    }
  });
});
