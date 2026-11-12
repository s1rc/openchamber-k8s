import { describe, expect, test } from 'bun:test';
import { evalPath, parsePath, printerValue } from '../src/shared/jsonpath.ts';

const object = {
  metadata: { name: 'x', creationTimestamp: '2026-01-01T00:00:00Z', annotations: { 'a.b/c': 'dotted', plain: 'p' } },
  spec: { replicas: 3, enabled: false, ports: [80, 443], url: 'https://git/x' },
  status: {
    conditions: [
      { type: 'Ready', status: 'True', message: 'all good' },
      { type: 'Stalled', status: 'False' },
    ],
  },
};

describe('printerValue', () => {
  test('plain paths', () => {
    expect(printerValue(object, '.spec.replicas')).toBe(3);
    expect(printerValue(object, '.metadata.name')).toBe('x');
    expect(printerValue(object, '.spec.enabled')).toBe(false);
    expect(printerValue(object, '.spec.nothing')).toBeNull();
    expect(printerValue(object, '.spec.nothing.deeper')).toBeNull();
  });

  test('kubectl wrapper and dollar prefix', () => {
    expect(printerValue(object, '{.spec.replicas}')).toBe(3);
    expect(printerValue(object, '$.spec.replicas')).toBe(3);
  });

  test('indexes, negative indexes and wildcards', () => {
    expect(printerValue(object, '.spec.ports[0]')).toBe(80);
    expect(printerValue(object, '.spec.ports[-1]')).toBe(443);
    expect(printerValue(object, '.spec.ports[*]')).toBe('80,443');
    expect(printerValue(object, '.spec.ports[5]')).toBeNull();
  });

  test('filters on a condition, the usual Ready column', () => {
    expect(printerValue(object, '.status.conditions[?(@.type=="Ready")].status')).toBe('True');
    expect(printerValue(object, ".status.conditions[?(@.type=='Ready')].message")).toBe('all good');
    expect(printerValue(object, '.status.conditions[?(@.type=="Missing")].status')).toBeNull();
    expect(printerValue(object, '.status.conditions[?(@.type!="Ready")].type')).toBe('Stalled');
    expect(printerValue(object, '.status.conditions[?(@.message)].type')).toBe('Ready');
  });

  test('keys with dots, by bracket and by escape', () => {
    expect(printerValue(object, ".metadata.annotations['a.b/c']")).toBe('dotted');
    expect(printerValue(object, '.metadata.annotations.a\\.b/c')).toBe('dotted');
  });

  test('objects and arrays come back as JSON', () => {
    expect(printerValue(object, '.spec.ports')).toBe('[80,443]');
    expect(printerValue(object, '.status.conditions[1]')).toBe('{"type":"Stalled","status":"False"}');
  });

  test('a path it cannot read is no value, not an error', () => {
    expect(parsePath('.a[')).toBeNull();
    expect(printerValue(object, '.a[')).toBeNull();
    expect(printerValue(object, 'nonsense')).toBeNull();
    expect(printerValue(object, '')).toBeNull();
  });

  test('evalPath returns every match', () => {
    expect(evalPath(object, '.spec.ports[*]')).toEqual([80, 443]);
  });
});
