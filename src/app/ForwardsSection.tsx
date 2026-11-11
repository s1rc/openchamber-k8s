import { ForwardsView } from './dock/ForwardsView.tsx';

/** The Port forwarding section of the navigation. Forwards live in the service, not in a kind. */
export const ForwardsSection = ({ context }: { context: string | null }) => (
  <div class="k8s-scroll k8s-pad">
    <ForwardsView context={context} />
  </div>
);
