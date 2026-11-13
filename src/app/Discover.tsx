import { useEffect, useRef, useState } from 'preact/hooks';
import { Chip, Dot } from '@openchamber-ext/shared-ui/preact';
import { aliasProblem, updateKubeconfigCommand, type EksClusterView, type EksProfileView, type EksState } from '../shared/eks.ts';
import { CopyButton } from './CopyButton.tsx';
import { ErrorState, type ErrorInfo } from './errors.tsx';
import { call, notify } from './host.ts';
import { Button, Empty, Spinner, TextField } from './kit.tsx';
import { Modal } from './Modal.tsx';
import { ProfileSignIn } from './SignIn.tsx';
import { loadSignIns, onSignedIn } from './signin.ts';
import { onTopic } from './watches.ts';

interface Props {
  dir: string | null;
  onClose: () => void;
  /** The kubeconfig changed: read the cluster list again. */
  onAdded: () => void;
  /** Open a cluster that is already in the kubeconfig. */
  onUse: (context: string) => void;
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A short path for the confirm text: the home folder as ~. */
const tilde = (path: string): string => path.replace(/^\/Users\/[^/]+\//, '~/').replace(/^\/home\/[^/]+\//, '~/');

const PROFILE_TONE: Record<EksProfileView['status'], 'success' | 'warning' | 'error' | 'muted'> = { ok: 'success', signin: 'warning', expired: 'warning', denied: 'muted', unreachable: 'error', error: 'error', skipped: 'muted' };

const ProfileRow = ({ view }: { view: EksProfileView }) => (
  <div class="k8s-eks-profile">
    <div class="k8s-eks-name">
      <Dot tone={PROFILE_TONE[view.status]} />
      <span class="sui-mono k8s-wrap">{view.profile}</span>
      {view.accountId ? <span class="sui-muted sui-small">{`account ${view.accountId}`}</span> : null}
    </div>
    {view.message ? <div class="sui-muted sui-small k8s-wrap">{view.message}</div> : null}
    {view.signIn ? <ProfileSignIn profile={view.profile} /> : null}
  </div>
);

interface AddProps {
  cluster: EksClusterView;
  state: EksState;
  dir: string | null;
  onBack: () => void;
  onDone: (alias: string) => void;
}

/** The confirm step: the exact command, the file it writes to, and a name that is not taken. */
const AddCluster = ({ cluster, state, dir, onBack, onDone }: AddProps) => {
  const [alias, setAlias] = useState(cluster.alias);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; profile: string | null } | null>(null);
  const taken = new Set(state.taken);
  const problem = aliasProblem(alias, taken);
  const command = updateKubeconfigCommand({ name: cluster.name, region: cluster.region, profile: cluster.profile, alias, ...(state.kubeconfigArg ? { kubeconfig: state.kubeconfigArg } : {}) });
  const text = command.ok ? command.text : '';

  const add = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const reply = await call('POST', '/eks/add', { dir, name: cluster.name, region: cluster.region, profile: cluster.profile, alias, expect: text });
    setBusy(false);
    if (reply.ok) {
      notify('success', `${alias} is in your kubeconfig.`);
      onDone(alias);
      return;
    }
    const action = reply.action as { kind?: string; profile?: string } | undefined;
    setFailure({ message: String(reply.error ?? 'Could not add the cluster.'), profile: action?.kind === 'sign-in' && action.profile ? action.profile : null });
  };

  return (
    <Modal
      title={`Add ${cluster.name} to your kubeconfig?`}
      wide
      onClose={onBack}
      footer={
        <>
          <Button label="Add to kubeconfig" size="sm" loading={busy} disabled={Boolean(problem) || !command.ok} onClick={() => void add()} />
          <CopyButton text={text} done="Command copied." label="Copy command" size="sm" variant="outline" />
          <Button label="Back" size="sm" variant="ghost" onClick={onBack} />
        </>
      }
    >
      <div class="k8s-wrap">
        {`This adds ${cluster.name} (${cluster.region}${cluster.accountId ? `, account ${cluster.accountId}` : ''}) as a new cluster, using the AWS profile `}
        <span class="sui-mono">{cluster.profile}</span>
        {'. It runs this command:'}
      </div>
      <pre class="k8s-yaml k8s-yaml--wrap sui-mono k8s-eks-command">{text || 'The command cannot be built from these values.'}</pre>
      <div class="sui-muted sui-small k8s-wrap">{`It writes to ${tilde(state.kubeconfigPath)}: a cluster, a user and a context are added, and entries for this cluster that are already in the file are updated. Nothing in AWS or on the cluster changes.`}</div>
      <TextField label="Name in your kubeconfig" value={alias} onChange={setAlias} error={problem ?? undefined} mono />
      {failure ? (
        <>
          <div class="k8s-dialog-error k8s-wrap">{failure.message}</div>
          {failure.profile ? <ProfileSignIn profile={failure.profile} /> : null}
        </>
      ) : null}
    </Modal>
  );
};

/** "Discover EKS clusters": what each AWS profile can see, and Add for a cluster the kubeconfig does not have. */
export const Discover = ({ dir, onClose, onAdded, onUse }: Props) => {
  const [state, setState] = useState<EksState | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [adding, setAdding] = useState<EksClusterView | null>(null);
  const doneSeq = useRef(0);

  const take = (reply: Record<string, unknown>): void => {
    setError(null);
    setState(reply as unknown as EksState);
  };
  const fail = (reply: { code?: unknown; error?: unknown }): void => setError({ code: String(reply.code ?? 'INTERNAL'), message: String(reply.error ?? 'Could not look for clusters.') });

  const read = async (): Promise<void> => {
    const reply = await call('GET', '/eks', { dir });
    if (reply.ok) take(reply);
    else fail(reply);
  };

  const discover = async (extra: Record<string, string> = {}): Promise<void> => {
    const seen = doneSeq.current;
    const reply = await call('POST', '/eks/discover', { dir, ...extra });
    if (!reply.ok) return fail(reply);
    take(reply);
    // The look can end before this answer arrives; its event came and went, so read again.
    if (reply.running && doneSeq.current !== seen) await read();
  };

  useEffect(() => {
    void loadSignIns();
    void discover();
    const stopEks = onTopic('eks', (data) => {
      const event = data as { state?: string; done?: number; total?: number };
      if (event.state === 'done') {
        doneSeq.current += 1;
        void read();
      } else if (event.state === 'running') {
        setState((prev) => (prev ? { ...prev, running: true, progress: typeof event.total === 'number' ? { done: event.done ?? 0, total: event.total } : prev.progress } : prev));
      }
    });
    // A profile whose sign-in just finished is asked again, and only that one.
    const stopSignIn = onSignedIn((view) => {
      if (view.profile) void discover({ profile: view.profile });
    });
    return () => {
      stopEks();
      stopSignIn();
    };
  }, []);

  if (adding && state) {
    return (
      <AddCluster
        cluster={adding}
        state={state}
        dir={dir}
        onBack={() => setAdding(null)}
        onDone={() => {
          setAdding(null);
          onAdded();
          void read();
        }}
      />
    );
  }

  const profiles = state?.profiles ?? [];
  const attention = profiles.filter((view) => view.status !== 'ok' && view.status !== 'skipped' ? true : view.status === 'ok' && Boolean(view.message));
  const skipped = profiles.filter((view) => view.status === 'skipped');
  const checked = profiles.filter((view) => view.status !== 'skipped').length;
  const clusters = state?.clusters ?? [];

  let body;
  if (error && !state) body = <ErrorState error={error} context={null} onRetry={() => void discover()} />;
  else if (!state) body = <div class="k8s-center"><Spinner label="Looking in your AWS profiles" /></div>;
  else {
    body = (
      <div class="k8s-eks">
        <div class="k8s-eks-head">
          {state.running ? (
            <Spinner size="sm" label={state.progress ? `Looking in your AWS profiles (${state.progress.done} of ${state.progress.total})` : 'Looking in your AWS profiles'} />
          ) : (
            <span class="sui-muted sui-small">{state.at ? `${checked} AWS ${checked === 1 ? 'profile' : 'profiles'} checked at ${clock(state.at)}.` : 'Nothing was checked yet.'}</span>
          )}
          <span class="k8s-push">
            <Button label="Look again" size="xs" variant="outline" disabled={state.running} onClick={() => void discover({ refresh: '1' })} />
          </span>
        </div>
        {error ? <ErrorState error={error} context={null} /> : null}
        {attention.length > 0 ? (
          <div class="k8s-eks-list">
            {attention.map((view) => (
              <ProfileRow key={view.profile} view={view} />
            ))}
          </div>
        ) : null}
        {clusters.length > 0 ? (
          <div class="k8s-eks-list" aria-label="Clusters found">
            {clusters.map((cluster) => (
              <div class="k8s-eks-row" key={`${cluster.accountId ?? cluster.profile}|${cluster.region}|${cluster.name}`}>
                <div class="k8s-eks-main">
                  <span class="sui-mono k8s-ellipsis">{cluster.name}</span>
                  <span class="sui-muted sui-small k8s-ellipsis">{[cluster.accountId ? `account ${cluster.accountId}` : null, cluster.region, cluster.profile].filter(Boolean).join(' \u00b7 ')}</span>
                </div>
                <div class="k8s-eks-actions">
                  {cluster.context ? (
                    <>
                      <Chip>{`In your kubeconfig as ${cluster.context}`}</Chip>
                      <Button label="Use" size="xs" variant="outline" onClick={() => onUse(cluster.context as string)} />
                    </>
                  ) : (
                    <Button label="Add" size="xs" onClick={() => setAdding(cluster)} />
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : !state.running ? (
          <Empty
            title={checked === 0 ? 'No AWS profiles to look in' : 'No clusters found'}
            body={checked === 0 ? 'None of the profiles in your AWS config has credentials. Set one up with the AWS CLI, then look again.' : 'The AWS profiles that answered list no EKS cluster in the regions they were asked about.'}
          />
        ) : null}
        {skipped.length > 0 ? <div class="sui-muted sui-small k8s-wrap">{`Not used: ${skipped.map((view) => `${view.profile} (${(view.message ?? '').replace(/\.$/, '').toLowerCase()})`).join(', ')}.`}</div> : null}
      </div>
    );
  }

  return (
    <Modal title="Discover EKS clusters" wide onClose={onClose} footer={<Button label="Close" size="sm" variant="ghost" onClick={onClose} />}>
      {body}
    </Modal>
  );
};
