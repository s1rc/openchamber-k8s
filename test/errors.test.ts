import { describe, expect, test } from 'bun:test';
import { classifyText, fromHttp, fromOutput, toReply, K8sError } from '../src/service/errors.ts';

describe('classifyText', () => {
  test.each([
    ['Error loading SSO Token: Token for profile x does not exist', 'AUTH_EXPIRED'],
    ['The SSO session associated with this profile has expired or is otherwise invalid', 'AUTH_EXPIRED'],
    ['UnauthorizedSSOTokenError', 'AUTH_EXPIRED'],
    ['Token has expired and refresh failed', 'AUTH_EXPIRED'],
    ['getting credentials: exec: executable aws failed with exit code 255', 'AUTH_EXPIRED'],
    ['error: You must be logged in to the server (Unauthorized)', 'AUTH_EXPIRED'],
    ['oidc-login: invalid_grant', 'AUTH_EXPIRED'],
    ['getting credentials: exec: executable kubectl-oidc_login not found', 'NO_KUBECTL'],
    ['dial tcp 10.0.0.1:443: i/o timeout', 'UNREACHABLE'],
    ['Unable to connect to the server: no such host', 'UNREACHABLE'],
    ['dial tcp: connection refused', 'UNREACHABLE'],
  ])('%s', (text, code) => {
    expect(classifyText(text)).toBe(code as never);
  });

  test('unrelated text is not classified', () => {
    expect(classifyText('deployments.apps "x" is invalid')).toBeNull();
  });
});

describe('fromHttp', () => {
  const status = (message: string) => JSON.stringify({ kind: 'Status', message });
  test.each([
    [401, 'AUTH_EXPIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'INVALID'],
    [500, 'K8S_ERROR'],
  ])('%d', (code, expected) => {
    expect(fromHttp(code, status('boom')).code).toBe(expected as never);
  });

  test('a 401 offers Sign in for that context', () => {
    expect(fromHttp(401, '', 'ctx-a').action).toEqual({ kind: 'sign-in', context: 'ctx-a' });
  });

  test('a 5xx that says the SSO token expired is an auth error', () => {
    expect(fromHttp(500, status('Token has expired'), 'ctx-a').code).toBe('AUTH_EXPIRED');
  });

  test('keeps the status and the cluster message', () => {
    const error = fromHttp(403, status('pods is forbidden: User "x" cannot list'));
    expect(error.status).toBe(403);
    expect(error.message).toContain('forbidden');
  });
});

describe('replies', () => {
  test('a K8sError keeps its code and action', () => {
    expect(toReply(new K8sError('LOCKED', 'locked', { kind: 'unlock', context: 'p' }))).toEqual({ ok: false, code: 'LOCKED', error: 'locked', action: { kind: 'unlock', context: 'p' } });
  });

  test('anything else is INTERNAL, never a throw', () => {
    expect(toReply(new Error('x')).code).toBe('INTERNAL');
    expect(toReply('plain').error).toBe('plain');
  });

  test('program output without a known cause becomes a short K8S_ERROR', () => {
    expect(fromOutput('weird\n\nthing', 'fallback').code).toBe('K8S_ERROR');
  });
});
