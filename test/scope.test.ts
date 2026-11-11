import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createScopeCache, parseEnvFile, readAwsProfiles, resolveScope, type ScopeDeps } from '../src/service/scope.ts';
import type { ContextInfo } from '../src/shared/types.ts';

const ctx = (name: string, account: string, region: string, cluster: string, server?: string): ContextInfo => ({
  name,
  cluster: `arn:aws:eks:${region}:${account}:cluster/${cluster}`,
  clusterName: cluster,
  server: server ?? `https://${cluster}.example.com`,
  namespace: null,
  arn: `arn:aws:eks:${region}:${account}:cluster/${cluster}`,
  account,
  region,
  auth: 'aws',
  awsProfile: null,
});

const CONTEXTS = [
  ctx('initech-production-ap-southeast-2', '987654321098', 'ap-southeast-2', 'initech-production'),
  ctx('initech-production-us-east-1', '987654321098', 'us-east-1', 'initech-production'),
  ctx('initech-staging-us-east-1', '987654321098', 'us-east-1', 'initech-staging', 'https://stg.example.com'),
  ctx('northwind-staging-eks-us-east-1', '210987654321', 'us-east-1', 'northwind-staging-eks'),
];

let root: string;
let counter = 0;
const project = (files: Record<string, string>): string => {
  const dir = join(root, `p${counter++}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
};

const deps = (extra: Partial<ScopeDeps> = {}): ScopeDeps => ({
  loadContexts: async () => CONTEXTS,
  picks: {},
  awsProfiles: () => ({
    initech: { accountId: '987654321098', region: 'us-east-1' },
    apac: { accountId: '987654321098', region: 'ap-southeast-2' },
    anywhere: { accountId: '987654321098', region: null },
    nw: { accountId: '210987654321', region: 'us-east-1' },
    noaccount: { accountId: null, region: 'us-east-1' },
  }),
  ...extra,
});

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-scope-')));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('parseEnvFile', () => {
  test('reads export and plain lines, quotes and comments', () => {
    const out = parseEnvFile(`# c\nexport A=1\nB="two words"\nC='x' \nD=plain # note\n`);
    expect(out).toEqual({ A: '1', B: 'two words', C: 'x', D: 'plain' });
  });

  test('never expands: values that need a shell are ignored', () => {
    const out = parseEnvFile('A=$(whoami)\nB="${HOME}/x"\nC=`id`\nD=$OTHER\nE=ok');
    expect(out).toEqual({ E: 'ok' });
  });

  test('the first definition of a key wins', () => {
    expect(parseEnvFile('A=1\nA=2').A).toBe('1');
  });
});

describe('readAwsProfiles', () => {
  test('reads account and region, sso or role', () => {
    const dir = project({
      config: `[default]\nregion = us-west-2\n\n[profile a]\nsso_account_id = 111111111111\nregion=eu-west-1\n\n[profile b]\nrole_arn = arn:aws:iam::222222222222:role/x\n\n[sso-session s]\nsso_region = us-east-1\n`,
    });
    const profiles = readAwsProfiles(join(dir, 'config'));
    expect(profiles.a).toEqual({ accountId: '111111111111', region: 'eu-west-1' });
    expect(profiles.b?.accountId).toBe('222222222222');
    expect(profiles.default?.region).toBe('us-west-2');
    expect(profiles.s).toBeUndefined();
  });

  test('a missing file is empty', () => {
    expect(readAwsProfiles(join(root, 'nope'))).toEqual({});
  });
});

describe('remembered pick', () => {
  test('wins over env files and says so', async () => {
    const dir = project({ '.envrc': 'export KUBECONTEXT=northwind-staging-eks-us-east-1\nexport NAMESPACE=other' });
    const scope = await resolveScope(dir, deps({ picks: { [dir]: { context: 'initech-staging-us-east-1', namespace: 'contracts', pickedAt: 'x' } } }));
    expect(scope).toMatchObject({ context: 'initech-staging-us-east-1', namespace: 'contracts', source: 'Your pick', sourceKind: 'pick', confidence: 1 });
  });

  test('is ignored when the context no longer exists', async () => {
    const dir = project({ '.envrc': 'KUBECONTEXT=initech-staging-us-east-1' });
    const scope = await resolveScope(dir, deps({ picks: { [dir]: { context: 'gone', namespace: null, pickedAt: 'x' } } }));
    expect(scope?.context).toBe('initech-staging-us-east-1');
  });
});

describe('env files', () => {
  test('context and namespace by name, labelled with the file', async () => {
    const dir = project({ '.envrc': 'export KUBE_CONTEXT=initech-staging-us-east-1\nexport KUBE_NAMESPACE=contracts' });
    const scope = await resolveScope(dir, deps());
    expect(scope).toMatchObject({ context: 'initech-staging-us-east-1', namespace: 'contracts', source: 'From .envrc', sourceKind: 'env' });
    expect(scope?.reasons.join(' ')).toContain('.envrc');
  });

  test('earlier files win: .envrc before .env', async () => {
    const dir = project({ '.envrc': 'NAMESPACE=first', '.env': 'NAMESPACE=second\nKUBECONTEXT=initech-staging-us-east-1' });
    const scope = await resolveScope(dir, deps());
    expect(scope?.namespace).toBe('first');
    expect(scope?.context).toBe('initech-staging-us-east-1');
  });

  test('a context that is not in the kubeconfig is not used', async () => {
    const dir = project({ '.env': 'KUBECONTEXT=missing' });
    expect(await resolveScope(dir, deps())).toBeNull();
  });

  test('AWS_PROFILE with one matching cluster', async () => {
    const dir = project({ '.env': 'AWS_PROFILE=nw' });
    const scope = await resolveScope(dir, deps());
    expect(scope).toMatchObject({ context: 'northwind-staging-eks-us-east-1', candidates: [] });
  });

  test('AWS_PROFILE prefers the profile region', async () => {
    const dir = project({ '.env': 'AWS_PROFILE=apac' });
    expect((await resolveScope(dir, deps()))?.context).toBe('initech-production-ap-southeast-2');
  });

  test('AWS_PROFILE with several matches preselects none', async () => {
    const dir = project({ '.env': 'AWS_PROFILE=anywhere' });
    const scope = await resolveScope(dir, deps());
    expect(scope?.context).toBeNull();
    expect(scope?.candidates.sort()).toEqual(['initech-production-ap-southeast-2', 'initech-production-us-east-1', 'initech-staging-us-east-1']);
  });

  test('AWS_PROFILE without an account id explains why', async () => {
    const dir = project({ '.env': 'AWS_PROFILE=noaccount' });
    expect(await resolveScope(dir, deps())).toBeNull();
  });

  test('KUBECONFIG inside the repo is refused', async () => {
    const dir = project({ '.envrc': 'KUBECONFIG=./kube.yaml\nKUBECONTEXT=initech-staging-us-east-1', 'kube.yaml': 'apiVersion: v1\nkind: Config\n' });
    const scope = await resolveScope(dir, deps());
    expect(scope?.kubeconfig).toBeUndefined();
    expect(scope?.reasons.join(' ')).toContain('points inside the repo');
  });

  test('KUBECONFIG outside the repo is used', async () => {
    const outside = project({ 'kube.yaml': 'apiVersion: v1\nkind: Config\n' });
    const dir = project({ '.envrc': `KUBECONFIG=${join(outside, 'kube.yaml')}` });
    const seen: (string | undefined)[] = [];
    const scope = await resolveScope(dir, deps({ loadContexts: async (kubeconfig) => (seen.push(kubeconfig), CONTEXTS) }));
    expect(seen).toContain(join(outside, 'kube.yaml'));
    expect(scope).toBeNull();
  });
});

describe('repo contents', () => {
  test('Argo CD Application: cluster name and namespace', async () => {
    const dir = project({
      'argo/app.yaml': `apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata: { name: x }\nspec:\n  destination:\n    name: initech-staging\n    namespace: contracts\n`,
    });
    const scope = await resolveScope(dir, deps());
    expect(scope).toMatchObject({ context: 'initech-staging-us-east-1', namespace: 'contracts', source: 'From repo files', sourceKind: 'repo' });
    expect(scope?.reasons.join(' ')).toContain('argo/app.yaml');
  });

  test('Argo CD destination server matches a context server', async () => {
    const dir = project({ 'app.yaml': `apiVersion: argoproj.io/v1alpha1\nkind: Application\nspec:\n  destination:\n    server: https://stg.example.com/\n    namespace: gm\n` });
    expect((await resolveScope(dir, deps()))?.context).toBe('initech-staging-us-east-1');
  });

  test('Argo CD in-cluster destinations are ignored', async () => {
    const dir = project({ 'app.yaml': `apiVersion: argoproj.io/v1alpha1\nkind: Application\nspec:\n  destination:\n    server: https://kubernetes.default.svc\n    name: in-cluster\n    namespace: gm\n` });
    const scope = await resolveScope(dir, deps());
    expect(scope).toMatchObject({ context: null, namespace: 'gm' });
  });

  test('Flux Kustomization and HelmRelease targetNamespace', async () => {
    const dir = project({
      'flux/ks.yaml': `apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nmetadata: { name: a, namespace: flux-system }\nspec:\n  targetNamespace: payments\n`,
      'flux/hr.yaml': `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata: { name: b, namespace: payments }\nspec: {}\n`,
    });
    expect((await resolveScope(dir, deps()))?.namespace).toBe('payments');
  });

  test('kustomization.yaml namespace', async () => {
    const dir = project({ 'k8s/overlays/staging/kustomization.yaml': 'namespace: contracts\nresources: []\n' });
    const scope = await resolveScope(dir, deps());
    expect(scope?.namespace).toBe('contracts');
    expect(scope?.reasons.join(' ')).toContain('k8s/overlays/staging/kustomization.yaml');
  });

  test('plain manifests: the most common namespace', async () => {
    const dir = project({
      'a.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: a, namespace: gm }\n',
      'b.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: b, namespace: gm }\n---\napiVersion: v1\nkind: Service\nmetadata: { name: c, namespace: other }\n',
    });
    expect((await resolveScope(dir, deps()))?.namespace).toBe('gm');
  });

  test('two kustomize overlays with different namespaces preselect none', async () => {
    const dir = project({ 'o/stg/kustomization.yaml': 'namespace: a\n', 'o/prod/kustomization.yaml': 'namespace: b\n' });
    const scope = await resolveScope(dir, deps());
    expect(scope).toBeNull();
  });

  test('Terraform aws_eks_cluster, module eks and data source', async () => {
    const dir = project({
      'infra/main.tf': `resource "aws_eks_cluster" "main" {\n  name     = "northwind-staging-eks"\n  role_arn = aws_iam_role.x.arn\n}\n`,
    });
    expect((await resolveScope(dir, deps()))?.context).toBe('northwind-staging-eks-us-east-1');
    const mod = project({ 'main.tf': `module "eks" {\n  source = "x"\n  cluster_name = "initech-staging"\n}\n` });
    expect((await resolveScope(mod, deps()))?.context).toBe('initech-staging-us-east-1');
    const data = project({ 'main.tf': `data "aws_eks_cluster" "c" {\n  name = "northwind-staging-eks"\n}\n` });
    expect((await resolveScope(data, deps()))?.context).toBe('northwind-staging-eks-us-east-1');
  });

  test('Terraform variables are not guessed', async () => {
    const dir = project({ 'main.tf': `module "eks" {\n  cluster_name = var.name\n}\n` });
    expect(await resolveScope(dir, deps())).toBeNull();
  });

  test('Skaffold kubeContext and Tilt allow_k8s_contexts', async () => {
    const sk = project({ 'skaffold.yaml': 'apiVersion: skaffold/v4beta6\nkind: Config\ndeploy:\n  kubeContext: initech-staging-us-east-1\n' });
    expect((await resolveScope(sk, deps()))?.context).toBe('initech-staging-us-east-1');
    const tilt = project({ Tiltfile: "allow_k8s_contexts(['northwind-staging-eks-us-east-1'])\n" });
    expect((await resolveScope(tilt, deps()))?.context).toBe('northwind-staging-eks-us-east-1');
  });

  test('conflicting clusters tie: candidates, none preselected', async () => {
    const dir = project({
      'a/main.tf': `resource "aws_eks_cluster" "a" {\n  name = "initech-staging"\n}\n`,
      'b/main.tf': `resource "aws_eks_cluster" "b" {\n  name = "northwind-staging-eks"\n}\n`,
    });
    const scope = await resolveScope(dir, deps());
    expect(scope?.context).toBeNull();
    expect(scope?.candidates.sort()).toEqual(['initech-staging-us-east-1', 'northwind-staging-eks-us-east-1']);
  });

  test('more evidence wins a conflict', async () => {
    const dir = project({
      'main.tf': `resource "aws_eks_cluster" "a" {\n  name = "northwind-staging-eks"\n}\n`,
      'skaffold.yaml': 'apiVersion: skaffold/v4beta6\ndeploy:\n  kubeContext: initech-staging-us-east-1\n',
    });
    expect((await resolveScope(dir, deps()))?.context).toBe('initech-staging-us-east-1');
  });

  test('the Helm Chart name is kept as a release hint', async () => {
    const dir = project({ 'chart/Chart.yaml': 'apiVersion: v2\nname: contracts-api\nversion: 1.0.0\n', 'kustomization.yaml': 'namespace: gm\n' });
    expect((await resolveScope(dir, deps()))?.releaseHint).toBe('contracts-api');
  });

  test('skips node_modules, .git, vendor and dist, and stops at depth 4', async () => {
    const dir = project({
      'node_modules/x/kustomization.yaml': 'namespace: nm\n',
      '.git/kustomization.yaml': 'namespace: git\n',
      'vendor/kustomization.yaml': 'namespace: vendor\n',
      'dist/kustomization.yaml': 'namespace: dist\n',
      'a/b/c/d/e/kustomization.yaml': 'namespace: toodeep\n',
    });
    expect(await resolveScope(dir, deps())).toBeNull();
    const ok = project({ 'a/b/c/d/kustomization.yaml': 'namespace: fine\n' });
    expect((await resolveScope(ok, deps()))?.namespace).toBe('fine');
  });

  test('broken YAML is skipped, not fatal', async () => {
    const dir = project({ 'bad.yaml': 'a: [unclosed\n', 'kustomization.yaml': 'namespace: gm\n' });
    expect((await resolveScope(dir, deps()))?.namespace).toBe('gm');
  });

  test('env context with repo namespace: each field from its best source', async () => {
    const dir = project({ '.envrc': 'KUBECONTEXT=initech-staging-us-east-1', 'kustomization.yaml': 'namespace: contracts\n' });
    const scope = await resolveScope(dir, deps());
    expect(scope).toMatchObject({ context: 'initech-staging-us-east-1', namespace: 'contracts', source: 'From .envrc' });
  });
});

describe('nothing found', () => {
  test('an empty project has no scope', async () => {
    expect(await resolveScope(project({ 'README.md': 'hi' }), deps())).toBeNull();
  });
});

describe('cache', () => {
  test('answers from memory for five minutes, then looks again', async () => {
    let calls = 0;
    let clock = 0;
    const cache = createScopeCache(async () => (calls++, null), 300_000, () => clock);
    await cache.get('/x');
    await cache.get('/x');
    expect(calls).toBe(1);
    clock = 299_999;
    await cache.get('/x');
    expect(calls).toBe(1);
    clock = 300_000;
    await cache.get('/x');
    expect(calls).toBe(2);
  });

  test('invalidate forces a new look', async () => {
    let calls = 0;
    const cache = createScopeCache(async () => (calls++, null));
    await cache.get('/x');
    cache.invalidate('/x');
    await cache.get('/x');
    expect(calls).toBe(2);
  });
});
