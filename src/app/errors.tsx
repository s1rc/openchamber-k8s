import type { BannerTone } from '@openchamber/sdk/ui';
import { Banner, Empty } from './kit.tsx';
import { SignInPrompt } from './SignIn.tsx';

export interface ErrorInfo {
  code: string;
  message?: string;
}

interface Look {
  tone: BannerTone;
  title: string;
  body: (error: ErrorInfo, context: string | null) => string;
  /** A small note inside the view, not a banner: the rest of the panel keeps working. */
  inline?: boolean;
  retry?: boolean;
}

/** The cluster's own words end without a full stop; add one before more text follows. */
const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const withMessage = (fallback: string) => (error: ErrorInfo): string => error.message || fallback;

const LOOKS: Record<string, Look> = {
  NO_KUBECTL: { tone: 'error', title: 'kubectl was not found', body: (e) => `${sentence(e.message || 'This panel needs kubectl')} Install kubectl, then try again.`, retry: true },
  // Drawn by SignInPrompt (a Sign in button, a waiting state, Try again). The text here is the fallback for a context the panel has no plan for.
  AUTH_EXPIRED: { tone: 'warning', title: 'Sign in to this cluster again', body: () => 'Your sign-in for this cluster has expired.', retry: true },
  FORBIDDEN: { tone: 'info', title: 'No access here', body: withMessage('Your account is not allowed to see this. The rest of the panel still works.'), inline: true },
  UNREACHABLE: { tone: 'error', title: 'Cluster not reachable', body: (e) => `${sentence(e.message || 'The cluster did not answer')} Check your network or VPN, then try again.`, retry: true },
  LOCKED: { tone: 'warning', title: 'This cluster is locked', body: withMessage('Production clusters are read-only until you unlock them.') },
  NOT_FOUND: { tone: 'warning', title: 'Not found', body: withMessage('The cluster has no such resource.'), inline: true },
  CONFLICT: { tone: 'warning', title: 'Changed by someone else', body: withMessage('The resource changed while you were looking at it.'), retry: true },
  INVALID: { tone: 'warning', title: 'The cluster refused this', body: withMessage('The request was not valid.') },
  BAD_REQUEST: { tone: 'warning', title: 'The request was not valid', body: withMessage('Something in the request was wrong.') },
  NO_CONTEXT: { tone: 'warning', title: 'This cluster is not in your kubeconfig', body: (e) => e.message || 'Pick another cluster above.', inline: true },
  UNKNOWN_WATCH: { tone: 'info', title: 'The live view ended', body: () => 'The panel lost its live connection. It will open again.', retry: true },
  K8S_ERROR: { tone: 'error', title: 'The cluster returned an error', body: withMessage('Something went wrong.'), retry: true },
  INTERNAL: { tone: 'error', title: 'Something went wrong', body: withMessage('An unexpected error happened.'), retry: true },
  failed: { tone: 'error', title: 'Could not load', body: withMessage('The Kubernetes helper did not answer.'), retry: true },
};

export const lookFor = (code: string): Look => LOOKS[code] ?? LOOKS.INTERNAL!;

/** Every error code the plan lists, plus the one the shared helper adds when a call itself fails. */
export const ERROR_CODES = Object.keys(LOOKS);

interface Props {
  error: ErrorInfo;
  context: string | null;
  onRetry?: () => void;
}

/** Draws one error: a banner with a Try again button, or a quiet note in the view for errors that only affect that view. */
export const ErrorState = ({ error, context, onRetry }: Props) => {
  if (error.code === 'AUTH_EXPIRED') return <SignInPrompt context={context} onRetry={onRetry} />;
  const look = lookFor(error.code);
  const body = look.body(error, context);
  const action = look.retry && onRetry ? { label: 'Try again', onClick: onRetry } : undefined;
  if (look.inline) return <div class="k8s-pad"><Empty title={look.title} body={body} action={action} /></div>;
  return (
    <div class="k8s-pad">
      <Banner tone={look.tone} title={look.title} body={body} action={action} />
    </div>
  );
};

