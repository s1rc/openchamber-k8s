// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

export interface ContextInfo {
  name: string;
  cluster: string;
  /** Short cluster name: the part after `cluster/` of an EKS ARN, else the cluster entry name. */
  clusterName: string;
  server: string | null;
  namespace: string | null;
  arn: string | null;
  account: string | null;
  region: string | null;
  auth: 'aws' | 'oidc' | 'other' | 'none';
  awsProfile: string | null;
}

export interface ScopeResult {
  context: string | null;
  namespace: string | null;
  /** Short label for the chip: "Your pick", "From .envrc", "From repo files". */
  source: string;
  sourceKind: 'pick' | 'env' | 'repo';
  confidence: number;
  reasons: string[];
  /** Set when several contexts fit and none is preselected. */
  candidates: string[];
  /** A kubeconfig outside the repo that the project's env file named. */
  kubeconfig?: string;
  releaseHint?: string;
}

export interface ProjectPick {
  context: string;
  namespace: string | null;
  pickedAt: string;
}

export interface Target {
  context: string;
  kubeconfig?: string;
}
