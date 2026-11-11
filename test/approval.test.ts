import { describe, expect, test } from 'bun:test';
import { APPROVAL_TTL_MS, approvalHash, grantApproval, pruneApprovals, useApproval } from '../src/shared/approval.ts';

const input = { context: 'prod-a', namespace: 'gm', verb: 'scale', kind: 'Deployment', name: 'api', payload: '{"replicas":3}' };

describe('approvalHash', () => {
  test('is stable and 64 hex characters', () => {
    expect(approvalHash(input)).toBe(approvalHash({ ...input }));
    expect(approvalHash(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changes with every part of the write', () => {
    const base = approvalHash(input);
    for (const change of [{ context: 'prod-b' }, { namespace: 'other' }, { verb: 'delete' }, { kind: 'StatefulSet' }, { name: 'web' }, { payload: '{"replicas":4}' }]) {
      expect(approvalHash({ ...input, ...change })).not.toBe(base);
    }
  });

  test('an empty payload and a missing one hash the same', () => {
    const { payload: _payload, ...without } = input;
    expect(approvalHash({ ...without, payload: '' })).toBe(approvalHash(without));
  });

  test('field boundaries cannot be shifted', () => {
    expect(approvalHash({ ...input, namespace: 'a|b', verb: 'c' })).not.toBe(approvalHash({ ...input, namespace: 'a', verb: 'b|c' }));
  });
});

describe('approvals file', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');
  const hash = approvalHash(input);

  test('a granted approval works once', () => {
    const granted = grantApproval({}, hash, 'scale api to 3', now);
    const first = useApproval(granted, hash, now + 1000);
    expect(first.ok).toBe(true);
    expect(useApproval(first.file, hash, now + 2000).ok).toBe(false);
  });

  test('an unknown hash fails', () => {
    expect(useApproval({}, hash, now).ok).toBe(false);
  });

  test('an approval for a different write fails', () => {
    const granted = grantApproval({}, hash, 'scale api to 3', now);
    expect(useApproval(granted, approvalHash({ ...input, payload: '{"replicas":9}' }), now).ok).toBe(false);
  });

  test('expires after ten minutes', () => {
    const granted = grantApproval({}, hash, 'x', now);
    expect(useApproval(granted, hash, now + APPROVAL_TTL_MS - 1).ok).toBe(true);
    expect(useApproval(granted, hash, now + APPROVAL_TTL_MS).ok).toBe(false);
  });

  test('granting drops used and expired entries', () => {
    const old = grantApproval({}, 'old', 'x', now);
    const used = useApproval(grantApproval(old, 'spent', 'x', now), 'spent', now).file;
    const later = grantApproval(used, 'fresh', 'x', now + APPROVAL_TTL_MS + 1);
    expect(Object.keys(later)).toEqual(['fresh']);
    expect(pruneApprovals(used, now)).not.toHaveProperty('spent');
  });
});
