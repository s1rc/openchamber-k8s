import { describe, expect, test } from 'bun:test';
import { applyEvents, objectKey } from '../src/app/apply-events.ts';
import type { Obj } from '../src/shared/types.ts';

const pod = (name: string, rv = '1', namespace = 'gm'): Obj => ({ kind: 'Pod', metadata: { name, namespace, resourceVersion: rv } });
const mapOf = (...objects: Obj[]): Map<string, Obj> => new Map(objects.map((o) => [objectKey(o), o]));

describe('applyEvents', () => {
  test('adds, changes and removes by namespace and name', () => {
    const map = mapOf(pod('a'), pod('b'));
    applyEvents(map, [
      { type: 'ADDED', object: pod('c') },
      { type: 'MODIFIED', object: pod('a', '2') },
      { type: 'DELETED', object: pod('b') },
    ], null);
    expect([...map.keys()].sort()).toEqual(['gm/a', 'gm/c']);
    expect(map.get('gm/a')?.metadata.resourceVersion).toBe('2');
  });

  test('the same name in two namespaces stays two rows', () => {
    const map = mapOf(pod('a', '1', 'x'));
    applyEvents(map, [{ type: 'ADDED', object: pod('a', '1', 'y') }], null);
    expect(map.size).toBe(2);
  });

  test('a cluster-scoped object has an empty namespace in its key', () => {
    expect(objectKey({ metadata: { name: 'node-1' } })).toBe('/node-1');
  });

  test('a repeated event is harmless', () => {
    const map = mapOf();
    const event = { type: 'ADDED' as const, object: pod('a') };
    applyEvents(map, [event, event], null);
    expect(map.size).toBe(1);
    applyEvents(map, [{ type: 'DELETED', object: pod('a') }, { type: 'DELETED', object: pod('a') }], null);
    expect(map.size).toBe(0);
  });

  test('a relist keeps what is added again and reports the rest as stale', () => {
    const map = mapOf(pod('a'), pod('b'), pod('c'));
    const first = applyEvents(map, [{ type: 'RESET' }, { type: 'ADDED', object: pod('a', '9') }], null);
    expect([...(first.stale ?? [])].sort()).toEqual(['gm/b', 'gm/c']);
    const second = applyEvents(map, [{ type: 'ADDED', object: pod('b', '9') }], first.stale);
    expect([...(second.stale ?? [])]).toEqual(['gm/c']);
    // Nothing is dropped until the caller's timer runs, so the table never flashes empty.
    expect(map.size).toBe(3);
  });

  test('an object too large to push asks for a fetch, and a large delete just deletes', () => {
    const map = mapOf(pod('a'), pod('b'));
    const result = applyEvents(map, [
      { type: 'MODIFIED', large: true, namespace: 'gm', name: 'a' },
      { type: 'DELETED', large: true, namespace: 'gm', name: 'b' },
    ], null);
    expect(result.refetch).toEqual([{ namespace: 'gm', name: 'a' }]);
    expect([...map.keys()]).toEqual(['gm/a']);
  });
});
