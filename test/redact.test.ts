import { describe, expect, test } from 'bun:test';
import { forPanel, redactSecret, stripNoise } from '../src/shared/redact.ts';

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
