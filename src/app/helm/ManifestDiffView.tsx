import type { DiffLine, ManifestDiff } from '../../shared/diff.ts';
import { Chip } from '@openchamber-ext/shared-ui/preact';

const mark = (line: DiffLine): string => (line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : line.kind === 'skip' ? '' : '  ');

/** The lines of one changed document, with the unchanged runs folded. */
export const DiffBody = ({ lines }: { lines: DiffLine[] }) => (
  <pre class="k8s-diff-body sui-mono">
    {lines.map((line) => (
      <span class={`k8s-diff-line k8s-diff-line--${line.kind}`}>{line.kind === 'skip' ? `... ${line.text}` : `${mark(line)}${line.text}`}</span>
    ))}
  </pre>
);

const NameList = ({ title, names, tone }: { title: string; names: string[]; tone: 'add' | 'del' }) =>
  names.length === 0 ? null : (
    <div class="k8s-diff-names">
      <strong class="sui-small">{title}</strong>
      <div class="k8s-chips">
        {names.slice(0, 30).map((name) => (
          <Chip>
            <span class={`k8s-diff-chip--${tone}`}>{name}</span>
          </Chip>
        ))}
        {names.length > 30 ? <Chip>{`+${names.length - 30} more`}</Chip> : null}
      </div>
    </div>
  );

/**
 * What a Helm change would do to the cluster's objects, document by document: objects added, removed, and the lines that
 * change in the others. Secret values are already hidden by the service.
 */
export const ManifestDiffView = ({ diff }: { diff: ManifestDiff }) => {
  const nothing = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  return (
    <div class="k8s-diff k8s-manifest-diff">
      <div class="sui-row">
        <strong class="sui-small">Changes to the cluster's objects</strong>
        <span class="sui-muted sui-small">{`${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed, ${diff.unchanged} unchanged`}</span>
      </div>
      {nothing ? <div class="sui-muted sui-small">The objects stay exactly as they are.</div> : null}
      <NameList title="Added" names={diff.added} tone="add" />
      <NameList title="Removed" names={diff.removed} tone="del" />
      {diff.changed.map((change) => (
        <details class="k8s-details" open={diff.changed.length <= 3}>
          <summary>
            <span class="sui-mono">{change.key}</span> <span class="sui-muted sui-small">{`+${change.added} -${change.removed}`}</span>
          </summary>
          <DiffBody lines={change.lines} />
        </details>
      ))}
      {diff.truncated ? <div class="sui-muted sui-small">The list is cut short. The rest of the changes are not shown.</div> : null}
    </div>
  );
};
