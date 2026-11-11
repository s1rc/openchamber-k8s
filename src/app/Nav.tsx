import { NAV } from '../shared/kinds.ts';
import { List } from './kit.tsx';

interface Props {
  kind: string;
  onPick: (kind: string) => void;
}

/** The left navigation of the page layout, in Lens order. */
export const Nav = ({ kind, onPick }: Props) => (
  <nav class="k8s-nav" aria-label="Resources">
    {NAV.map((section) => {
      const has = section.items.some((item) => item.kind === kind);
      return (
        <div class="k8s-nav-group" key={`${section.id}:${has ? kind : ''}`}>
          {section.items.length > 1 || section.heading ? <div class="k8s-nav-heading">{section.title}</div> : null}
          <List ariaLabel={section.title} selectedId={has ? kind : null} onSelect={onPick} items={section.items.map((item) => ({ id: item.kind, title: item.title }))} />
        </div>
      );
    })}
  </nav>
);
