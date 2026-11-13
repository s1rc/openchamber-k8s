import { useState } from 'preact/hooks';
import { signInText, type AuthView } from '../shared/eks.ts';
import { copyText, host } from './host.ts';
import { Banner, Button, Spinner } from './kit.tsx';
import { attemptForContext, attemptForProfile, cancelSignIn, planFor, startSignIn, useRetryOnSignIn, useSignInState } from './signin.ts';

const openLink = (url: string): void => {
  void host.openUrl(url).catch(() => undefined);
};

/** The wait: a spinner, what to do, Cancel, and the link when the browser did not open by itself. */
export const Waiting = ({ view, what }: { view: AuthView; what: string }) => (
  <div class="k8s-signin-wait">
    <Spinner size="sm" label={what} />
    <div class="sui-muted sui-small">Finish signing in in your browser. This waits up to 5 minutes.</div>
    <div class="k8s-signin-actions">
      <Button label="Cancel" size="xs" variant="outline" onClick={() => void cancelSignIn(view.id)} />
      {view.url ? (
        <>
          <Button label="Open sign-in page" size="xs" variant="ghost" onClick={() => openLink(view.url as string)} />
          <Button label="Copy link" size="xs" variant="ghost" onClick={() => void copyText(view.url as string, 'Sign-in link copied.')} />
        </>
      ) : null}
    </div>
  </div>
);

interface Props {
  context: string | null;
  /** Reads again what failed. Runs by itself when the sign-in finishes. */
  onRetry?: () => void;
}

/**
 * The banner for an expired login: Sign in (SSO opens the AWS page, OIDC opens kubelogin's page, both in the browser,
 * never a terminal), a waiting state with Cancel, and Try again. When the sign-in finishes the view reads again by itself.
 */
export const SignInPrompt = ({ context, onRetry }: Props) => {
  useSignInState();
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const plan = planFor(context);
  const attempt = attemptForContext(context);
  useRetryOnSignIn(context, true, onRetry);
  const canSignIn = plan?.kind === 'sso' || plan?.kind === 'oidc';

  const start = async (): Promise<void> => {
    if (!context) return;
    setStarting(true);
    setStartError(null);
    const result = await startSignIn({ context });
    setStarting(false);
    if (!result.ok) setStartError(result.error ?? 'Could not start the sign-in.');
  };

  if (attempt?.state === 'running') {
    return (
      <div class="k8s-pad">
        <Banner tone="info" title="Waiting for you to sign in" body={plan?.kind === 'sso' ? `Signing in to the AWS profile "${plan.profile}".` : 'Signing in to this cluster.'} />
        <Waiting view={attempt} what="Waiting for the browser" />
      </div>
    );
  }
  if (attempt?.state === 'done') {
    return (
      <div class="k8s-pad">
        <Banner tone="success" title="Signed in" body="Loading this view again." />
        <Spinner size="sm" label="Loading" />
      </div>
    );
  }
  const failed = attempt?.state === 'failed' || attempt?.state === 'timeout';
  const note = startError ?? (failed ? attempt?.error : null) ?? (attempt?.state === 'cancelled' ? 'The sign-in was cancelled.' : null);
  return (
    <div class="k8s-pad">
      <Banner tone={failed || startError ? 'error' : 'warning'} title={failed || startError ? 'The sign-in did not finish' : plan?.kind === 'none' ? 'The login for this cluster has expired' : 'Sign in to this cluster again'} body={`${note ? `${/[.!?]$/.test(note.trim()) ? note.trim() : `${note.trim()}.`} ` : ''}${signInText(plan)}`} />
      <div class="k8s-signin-actions">
        {canSignIn ? <Button label="Sign in" size="sm" loading={starting} onClick={() => void start()} /> : null}
        {onRetry ? <Button label="Try again" size="sm" variant="outline" onClick={onRetry} /> : null}
      </div>
    </div>
  );
};

/** A Sign in for an AWS profile (the discovery dialog), with the same waiting state. */
export const ProfileSignIn = ({ profile }: { profile: string }) => {
  useSignInState();
  const [error, setError] = useState<string | null>(null);
  const attempt = attemptForProfile(profile);
  if (attempt?.state === 'running') return <Waiting view={attempt} what="Waiting for the browser" />;
  const failed = attempt?.state === 'failed' || attempt?.state === 'timeout';
  return (
    <div class="k8s-signin-profile">
      <Button
        label="Sign in"
        size="xs"
        onClick={() => {
          setError(null);
          void startSignIn({ profile }).then((result) => {
            if (!result.ok) setError(result.error ?? 'Could not start the sign-in.');
          });
        }}
      />
      {error || (failed && attempt?.error) ? <span class="k8s-dialog-error sui-small">{error ?? attempt?.error}</span> : null}
    </div>
  );
};
