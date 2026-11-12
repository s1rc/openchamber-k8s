import type { ComponentChildren } from 'preact';
import { HELM_RELEASES, HELM_VIEW, type HelmRelease } from '../../shared/helm.ts';
import { ErrorState } from '../errors.tsx';
import { Button } from '../kit.tsx';
import { ResourceView } from '../ResourceView.tsx';
import type { Live } from '../useWatch.ts';
import { HelmDrawer } from './HelmDrawer.tsx';
import { useHelmReleases } from './useHelmReleases.ts';

interface Props {
  context: string;
  /** `_all` for every namespace. */
  namespace: string;
  dir: string | null;
  layout: 'page' | 'rail';
  lead?: ComponentChildren;
  onLive: (live: Live) => void;
}

/** Helm releases in the same list, search and drawer as every other kind. */
export const HelmReleases = ({ context, namespace, dir, layout, lead, onLive }: Props) => {
  const source = useHelmReleases({ context, namespace, dir });
  return (
    <ResourceView
      context={context}
      namespace={namespace}
      kind={HELM_RELEASES}
      dir={dir}
      layout={layout}
      lead={lead}
      onLive={onLive}
      source={source}
      view={HELM_VIEW}
      toolbarExtra={<Button label="Refresh" size="xs" variant="outline" loading={source.refreshing} onClick={source.reload} />}
      notice={source.phase === 'ready' && source.error ? <ErrorState error={source.error} context={context} onRetry={source.reload} /> : null}
      renderDrawer={({ object, gone, onClose, rail, now }) => (
        <HelmDrawer release={object.helm as HelmRelease} gone={gone} context={context} dir={dir} now={now} rail={rail} onClose={onClose} onChanged={source.reload} />
      )}
    />
  );
};
