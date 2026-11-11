import { useMemo } from 'preact/hooks';
import { stringify } from 'yaml';
import type { Obj } from '../../shared/types.ts';

/** The object as the cluster has it, read only. Secret values are already masked by the service. */
export const Yaml = ({ object }: { object: Obj }) => {
  const text = useMemo(() => stringify(object, { lineWidth: 0, indent: 2 }), [object]);
  return (
    <div class="k8s-yaml-wrap">
      <div class="sui-muted sui-small">Read only. Editing arrives in a later version.</div>
      <pre class="k8s-yaml sui-mono">{text}</pre>
    </div>
  );
};
