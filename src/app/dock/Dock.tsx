import { useState } from 'preact/hooks';
import type { Obj } from '../../shared/types.ts';
import { ForwardsView } from './ForwardsView.tsx';
import { LogView } from './LogView.tsx';
import { ConsoleView } from './ConsoleView.tsx';

export type DockTab =
  | { id: string; kind: 'logs'; title: string; object: Obj; namespace: string }
  | { id: string; kind: 'console'; title: string; pod: string; containers: string[]; namespace: string }
  | { id: string; kind: 'forwards'; title: string };

interface Props {
  tabs: DockTab[];
  active: string | null;
  context: string | null;
  dir: string | null;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
}

const MIN_H = 140;
const MAX_H = 640;

/** The bottom dock: open log follows, consoles and the port forward list, one at a time. */
export const Dock = ({ tabs, active, context, dir, onPick, onClose }: Props) => {
  const [height, setHeight] = useState(300);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0] ?? null;

  const startResize = (event: PointerEvent): void => {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startH = height;
    const move = (moveEvent: PointerEvent): void => setHeight(Math.min(MAX_H, Math.max(MIN_H, Math.round(startH + (startY - moveEvent.clientY)))));
    const stop = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
  };

  return (
    <div class="k8s-dock" style={{ height: `${height}px` }}>
      <div class="k8s-dock-resizer" role="separator" aria-orientation="horizontal" onPointerDown={startResize} />
      <div class="k8s-dock-tabs" role="tablist">
        {tabs.map((tab) => (
          <span class={`k8s-dock-tab${tab.id === current?.id ? ' k8s-dock-tab--active' : ''}`} key={tab.id}>
            <button type="button" role="tab" aria-selected={tab.id === current?.id} onClick={() => onPick(tab.id)}>
              {tab.title}
            </button>
            <button type="button" class="k8s-dock-close" aria-label={`Close ${tab.title}`} onClick={() => onClose(tab.id)}>
              x
            </button>
          </span>
        ))}
      </div>
      <div class="k8s-dock-body">
        {!current ? <div class="sui-muted sui-small k8s-dock-empty">Open a log, a console or a port forward from a resource's Actions menu.</div> : null}
        {current?.kind === 'logs' ? <LogView context={context ?? ''} dir={dir} namespace={current.namespace} object={current.object} /> : null}
        {current?.kind === 'console' ? <ConsoleView context={context ?? ''} dir={dir} namespace={current.namespace} pod={current.pod} containers={current.containers} /> : null}
        {current?.kind === 'forwards' ? <ForwardsView context={context} compact /> : null}
      </div>
    </div>
  );
};
