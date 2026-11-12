import { describe, expect, test } from 'bun:test';
import { proxyFunctions, signatureOf } from '../src/app/stable.ts';

describe('signatureOf', () => {
  test('is the same for the same data, whatever the functions are', () => {
    const a = { label: 'Go', items: [{ id: '1', title: 'One' }], onSelect: () => 1 };
    const b = { label: 'Go', items: [{ id: '1', title: 'One' }], onSelect: () => 2 };
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test('changes when text, order, selection or the presence of a function changes', () => {
    const base = { items: [{ id: '1' }, { id: '2' }], selectedId: '1', onSelect: () => 1 };
    expect(signatureOf({ ...base, selectedId: '2' })).not.toBe(signatureOf(base));
    expect(signatureOf({ ...base, items: [{ id: '2' }, { id: '1' }] })).not.toBe(signatureOf(base));
    const { onSelect: _drop, ...without } = base;
    expect(signatureOf(without)).not.toBe(signatureOf(base));
  });
});

describe('proxyFunctions', () => {
  test('a proxied callback runs the newest function, at any depth', () => {
    const calls: string[] = [];
    const first = { onClick: () => calls.push('old'), action: { label: 'x', onClick: () => calls.push('old action') }, items: [{ id: 'a', run: () => calls.push('old item') }] };
    const latest = { current: first };
    const stable = proxyFunctions(first, latest);
    latest.current = { onClick: () => calls.push('new'), action: { label: 'x', onClick: () => calls.push('new action') }, items: [{ id: 'a', run: () => calls.push('new item') }] };
    stable.onClick();
    stable.action.onClick();
    stable.items[0]!.run();
    expect(calls).toEqual(['new', 'new action', 'new item']);
  });

  test('passes arguments and the result through, and keeps plain data as it was', () => {
    const latest = { current: { onSelect: (id: string) => `picked ${id}`, label: 'L', n: 3, flag: true, none: null } };
    const stable = proxyFunctions(latest.current, latest);
    expect(stable.onSelect('7')).toBe('picked 7');
    expect({ label: stable.label, n: stable.n, flag: stable.flag, none: stable.none }).toEqual({ label: 'L', n: 3, flag: true, none: null });
  });

  test('a function that is gone from the newest props does nothing instead of throwing', () => {
    const first: { onClick?: () => number } = { onClick: () => 1 };
    const latest = { current: first };
    const stable = proxyFunctions(first, latest);
    latest.current = {};
    expect(stable.onClick!()).toBeUndefined();
  });

  test('does not copy class instances or DOM-like objects', () => {
    class Thing { value = 1 }
    const thing = new Thing();
    const stable = proxyFunctions({ thing }, { current: { thing } });
    expect(stable.thing).toBe(thing);
  });
});
