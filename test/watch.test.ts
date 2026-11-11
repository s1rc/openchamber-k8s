import { describe, expect, test } from 'bun:test';
import { chunkEvents, type WatchEvent } from '../src/service/watch.ts';

const event = (name: string, pad = 0): WatchEvent => ({ type: 'MODIFIED', object: { metadata: { name, namespace: 'gm' }, pad: 'x'.repeat(pad) } });

describe('chunkEvents', () => {
  test('small batches stay in one emit', () => {
    expect(chunkEvents([event('a'), event('b')])).toHaveLength(1);
  });

  test('every emit stays under the limit and nothing is lost or reordered', () => {
    const events = Array.from({ length: 40 }, (_, i) => event(`p${i}`, 3000));
    const chunks = chunkEvents(events, 20_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(JSON.stringify({ watchId: 'w_123456789012', events: chunk }).length).toBeLessThan(20_000 + 100);
    expect(chunks.flat().map((e) => e.object?.metadata?.name)).toEqual(events.map((e) => e.object?.metadata?.name));
  });

  test('an object over the limit is replaced by a pointer to fetch it', () => {
    const [chunk] = chunkEvents([event('huge', 50_000)], 20_000);
    expect(chunk).toEqual([{ type: 'MODIFIED', large: true, namespace: 'gm', name: 'huge' }]);
  });

  test('no events, no emits', () => {
    expect(chunkEvents([])).toEqual([]);
  });
});
