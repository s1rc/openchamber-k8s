import { describe, expect, test } from 'bun:test';
import { forPanel, isSensitiveKey, REDACTED, redactManifest, redactSecret, redactValues, restoreRedacted, stripNoise } from '../src/shared/redact.ts';

const secret = {
  kind: 'Secret',
  metadata: { name: 's', managedFields: [{ manager: 'x' }], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"cGFzcw=="}}', keep: 'yes' } },
  data: { password: 'cGFzc3dvcmQ=', empty: '' },
  stringData: { token: 'abcdef' },
};

describe('redactSecret', () => {
  test('replaces every value with its size', () => {
    const out = redactSecret(secret);
    expect(out.data.password).toBe('<redacted, 8 bytes>');
    expect(out.data.empty).toBe('<redacted, 0 bytes>');
    expect(out.stringData.token).toBe('<redacted, 6 bytes>');
    expect(JSON.stringify(out)).not.toContain('cGFzc3dvcmQ=');
  });

  test('drops the last-applied annotation but keeps others', () => {
    const out = redactSecret(secret);
    expect(out.metadata.annotations).toEqual({ keep: 'yes' });
  });

  test('does not change its input', () => {
    redactSecret(secret);
    expect(secret.data.password).toBe('cGFzc3dvcmQ=');
  });

  test('reveal keeps the values for the panel click', () => {
    expect(redactSecret(secret, true).data.password).toBe('cGFzc3dvcmQ=');
  });
});

describe('forPanel', () => {
  test('strips managedFields from every kind', () => {
    expect(stripNoise({ metadata: { name: 'x', managedFields: [1] } }).metadata).toEqual({ name: 'x' });
    expect(forPanel(false, { metadata: { managedFields: [1], name: 'x' } }).metadata.managedFields).toBeUndefined();
  });

  test('hides Secret values by default', () => {
    const out = forPanel(true, secret);
    expect(out.metadata.managedFields).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('cGFzc3dvcmQ=');
  });
});

describe('redactValues', () => {
  test('hides text and numbers under a secret-looking key, whatever the case', () => {
    const out = redactValues({ db: { Password: 'hunter2', user: 'app', port: 5432 }, apiToken: 'abc', signingKey: 12345, credentials: { id: 'x', nested: { value: 'y' } } }) as Record<string, any>;
    expect(out.db).toEqual({ Password: REDACTED, user: 'app', port: 5432 });
    expect(out.apiToken).toBe(REDACTED);
    expect(out.signingKey).toBe(REDACTED);
    expect(out.credentials).toEqual({ id: REDACTED, nested: { value: REDACTED } });
  });

  test('matches every word of the rule', () => {
    for (const key of ['password', 'secret', 'token', 'key', 'credential', 'dbPassword', 'MY_SECRET', 'accessToken', 'apiKey', 'credentials']) expect(isSensitiveKey(key)).toBe(true);
    for (const key of ['replicas', 'image', 'name', 'host']) expect(isSensitiveKey(key)).toBe(false);
  });

  test('keeps booleans, null and empty text, which hold nothing', () => {
    const out = redactValues({ secretEnabled: true, tokenRef: null, password: '', other: 'visible' }) as Record<string, unknown>;
    expect(out).toEqual({ secretEnabled: true, tokenRef: null, password: '', other: 'visible' });
  });

  test('hides the value of a name and value pair whose name looks secret', () => {
    const out = redactValues({ extraEnv: [{ name: 'DB_PASSWORD', value: 'p' }, { name: 'LOG_LEVEL', value: 'debug' }] }) as { extraEnv: Array<Record<string, string>> };
    expect(out.extraEnv[0]).toEqual({ name: 'DB_PASSWORD', value: REDACTED });
    expect(out.extraEnv[1]).toEqual({ name: 'LOG_LEVEL', value: 'debug' });
  });

  test('hides arrays under a secret-looking key and does not change its input', () => {
    const input = { tokens: ['a', 'b'], list: [{ secret: 's' }] };
    const out = redactValues(input) as Record<string, any>;
    expect(out.tokens).toEqual([REDACTED, REDACTED]);
    expect(out.list[0].secret).toBe(REDACTED);
    expect(input.tokens).toEqual(['a', 'b']);
  });

  test('never lets a value through in the serialized result', () => {
    const text = JSON.stringify(redactValues({ a: { b: { password: 'zzz-unique-1' }, token: 'zzz-unique-2' }, list: [{ apiKey: 'zzz-unique-3' }] }));
    expect(text).not.toContain('zzz-unique');
  });
});

describe('restoreRedacted', () => {
  const original = { db: { password: 'hunter2', user: 'app' }, extraEnv: [{ name: 'DB_PASSWORD', value: 'p' }] };

  test('puts the real value back where the placeholder stayed', () => {
    const shown = redactValues(original);
    const { value, unresolved } = restoreRedacted(shown, original);
    expect(value).toEqual(original);
    expect(unresolved).toEqual([]);
  });

  test('keeps a value the user retyped and a key the user removed', () => {
    const edited = { db: { password: 'new-one' }, extraEnv: [{ name: 'DB_PASSWORD', value: REDACTED }] };
    const { value } = restoreRedacted(edited, original);
    expect(value).toEqual({ db: { password: 'new-one' }, extraEnv: [{ name: 'DB_PASSWORD', value: 'p' }] });
  });

  test('reports a placeholder with nothing to restore, so it is never written', () => {
    const { unresolved } = restoreRedacted({ db: { token: REDACTED }, list: [REDACTED] }, original);
    expect(unresolved).toEqual(['db.token', 'list[0]']);
  });

  test('does not restore a placeholder from an object', () => {
    expect(restoreRedacted({ db: REDACTED }, original).unresolved).toEqual(['db']);
  });
});

describe('redactManifest', () => {
  const manifest = [
    '---',
    '# Source: app/templates/config.yaml',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: cfg',
    'data:',
    '  note: "kind: Secret is only text here"',
    '---',
    '# Source: app/templates/secret.yaml',
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '  name: creds',
    'type: Opaque',
    'data:',
    '  password: aHVudGVyMg==',
    'stringData:',
    '  token: plain-text-token',
    '---',
    '# Source: app/templates/deploy.yaml',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: web',
    '',
  ].join('\n');

  test('hides every Secret document and keeps its keys', () => {
    const { text, secrets } = redactManifest(manifest);
    expect(secrets).toBe(1);
    expect(text).not.toContain('aHVudGVyMg==');
    expect(text).not.toContain('plain-text-token');
    expect(text).toContain('password: <redacted, 7 bytes>');
    expect(text).toContain('token: <redacted, 16 bytes>');
    expect(text).toContain('# Source: app/templates/secret.yaml');
  });

  test('leaves other documents exactly as they were, even when they mention Secret in text', () => {
    const { text } = redactManifest(manifest);
    expect(text).toContain('  note: "kind: Secret is only text here"');
    expect(text).toContain('# Source: app/templates/deploy.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web');
  });

  test('a manifest with no Secret is returned unchanged', () => {
    const plain = '---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n';
    expect(redactManifest(plain)).toEqual({ text: plain, secrets: 0 });
  });

  test('hides a Secret document that cannot be parsed', () => {
    const broken = '---\n# Source: x\nkind: Secret\ndata:\n  a: [unclosed\n  b: c: d\n';
    const { text, secrets } = redactManifest(broken);
    expect(secrets).toBe(1);
    expect(text).not.toContain('unclosed');
  });

  test('hides a Secret inside a List', () => {
    const list = '---\napiVersion: v1\nkind: List\nitems:\n  - kind: Secret\n    metadata:\n      name: s\n    data:\n      k: c2VjcmV0\n  - kind: ConfigMap\n    metadata:\n      name: c\n';
    const { text, secrets } = redactManifest(list);
    expect(secrets).toBe(1);
    expect(text).not.toContain('c2VjcmV0');
  });
});
