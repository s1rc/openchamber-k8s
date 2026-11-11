import { describe, expect, test } from 'bun:test';
import { parseKubeconfig } from '../src/service/kubeconfig.ts';

const doc = {
  'current-context': 'stg',
  clusters: [
    { name: 'arn:aws:eks:us-east-1:987654321098:cluster/initech-staging', cluster: { server: 'https://abc.eks.amazonaws.com/' } },
    { name: 'arn:aws:eks:us-east-1:210987654321:cluster/northwind-staging-eks', cluster: { server: 'https://def.eks.amazonaws.com' } },
    { name: 'minikube', cluster: { server: 'https://127.0.0.1:8443' } },
  ],
  users: [
    { name: 'aws-user', user: { exec: { command: 'aws', args: ['--region', 'us-east-1', 'eks', 'get-token', '--profile', 'initech'], env: null } } },
    { name: 'nw-oidc', user: { exec: { command: 'kubectl', args: ['oidc-login', 'get-token', '--oidc-client-id=x'], env: null } } },
    { name: 'plain', user: { 'client-certificate-data': 'DATA+OMITTED' } },
    { name: 'envuser', user: { exec: { command: '/opt/homebrew/bin/aws', args: ['eks'], env: [{ name: 'AWS_PROFILE', value: 'from-env' }, { name: 'SECRET', value: 'nope' }] } } },
  ],
  contexts: [
    { name: 'stg', context: { cluster: 'arn:aws:eks:us-east-1:987654321098:cluster/initech-staging', user: 'aws-user', namespace: 'contracts' } },
    { name: 'nw', context: { cluster: 'arn:aws:eks:us-east-1:210987654321:cluster/northwind-staging-eks', user: 'nw-oidc' } },
    { name: 'mk', context: { cluster: 'minikube', user: 'plain' } },
    { name: 'env', context: { cluster: 'minikube', user: 'envuser' } },
  ],
};

describe('parseKubeconfig', () => {
  const { current, contexts } = parseKubeconfig(doc);
  const by = (name: string) => contexts.find((info) => info.name === name)!;

  test('reads the current context and every context', () => {
    expect(current).toBe('stg');
    expect(contexts.map((info) => info.name)).toEqual(['stg', 'nw', 'mk', 'env']);
  });

  test('takes account, region and cluster name from an EKS ARN', () => {
    expect(by('stg')).toMatchObject({ account: '987654321098', region: 'us-east-1', clusterName: 'initech-staging', namespace: 'contracts', server: 'https://abc.eks.amazonaws.com' });
    expect(by('mk')).toMatchObject({ account: null, region: null, clusterName: 'minikube', arn: null });
  });

  test('says how each context signs in', () => {
    expect(by('stg').auth).toBe('aws');
    expect(by('nw').auth).toBe('oidc');
    expect(by('mk').auth).toBe('none');
    expect(by('stg').awsProfile).toBe('initech');
    expect(by('env').awsProfile).toBe('from-env');
  });

  test('keeps nothing that looks like a credential', () => {
    expect(JSON.stringify(contexts)).not.toMatch(/nope|DATA\+OMITTED|oidc-client-id/);
  });
});
