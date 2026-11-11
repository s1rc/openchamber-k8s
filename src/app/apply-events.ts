import type { Obj } from '../shared/types.ts';

export interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RESET';
  object?: Obj;
  /** The object was too big to push; fetch it with GET /get. */
  large?: boolean;
  namespace?: string;
  name?: string;
}

export const objectKey = (object: Obj): string => `${object.metadata?.namespace ?? ''}/${object.metadata?.name ?? ''}`;

/** Applies one batch of watch events to the map. Returns the keys still to be dropped after a relist. */
export const applyEvents = (map: Map<string, Obj>, events: WatchEvent[], stale: Set<string> | null): { stale: Set<string> | null; refetch: Array<{ namespace: string; name: string }> } => {
  const refetch: Array<{ namespace: string; name: string }> = [];
  let pending = stale;
  for (const event of events) {
    if (event.type === 'RESET') {
      pending = new Set(map.keys());
      continue;
    }
    if (event.large) {
      const key = `${event.namespace ?? ''}/${event.name ?? ''}`;
      if (event.type === 'DELETED') map.delete(key);
      else refetch.push({ namespace: event.namespace ?? '', name: event.name ?? '' });
      pending?.delete(key);
      continue;
    }
    if (!event.object) continue;
    const key = objectKey(event.object);
    if (event.type === 'DELETED') map.delete(key);
    else map.set(key, event.object);
    pending?.delete(key);
  }
  return { stale: pending, refetch };
};

