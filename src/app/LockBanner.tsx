import { useEffect, useState } from 'preact/hooks';
import { remainingText } from '../shared/ops.ts';
import { Button } from './kit.tsx';

interface Props {
  context: string;
  until: number;
  onLock: () => void;
  /** The unlock ran out: the panel flips the badge without a call. */
  onExpired: () => void;
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The lock banner: an unlocked production cluster with the time left, and Lock now. */
export const LockBanner = ({ context, until, onLock, onExpired }: Props) => {
  const [now, setNow] = useState(Date.now());
  const left = until - now;

  useEffect(() => {
    // A local clock tick for the countdown. Nothing is fetched and no cluster is called.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);

  useEffect(() => {
    if (left <= 0) onExpired();
  }, [left <= 0]);

  return (
    <div class="k8s-lock-banner" role="status">
      <div class="k8s-lock-text">
        <strong>{`${context} is unlocked`}</strong>
        <span class="sui-small">{`Writes are allowed for ${left > 0 ? remainingText(until, now) : 'no time'}. It locks again at ${clock(until)}.`}</span>
      </div>
      <Button label="Lock now" size="sm" variant="outline" onClick={onLock} />
    </div>
  );
};
