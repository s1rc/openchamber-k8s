import { useEffect, useRef, useState } from 'preact/hooks';
import { Dot } from '@openchamber-ext/shared-ui/preact';
import { cellText, containerStates, type Column, type KindView, type ViewContext } from '../shared/kinds.ts';
import { barTone } from '../shared/overview.ts';
import type { Obj } from '../shared/types.ts';
import { objectKey } from './apply-events.ts';

export interface SortState {
  column: string;
  dir: 'asc' | 'desc';
}

interface Props {
  view: KindView;
  columns: Column[];
  rows: Obj[];
  sort: SortState;
  onSort: (column: string) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  now: number;
  /** Live usage for the CPU, memory and disk columns. */
  ctx?: ViewContext;
}

const ROW_H = 30;
/** Past this many rows only the visible ones are drawn. */
export const VIRTUAL_FROM = 300;
const OVERSCAN = 12;

/** The smallest width a grid track needs, so the table scrolls sideways instead of squashing. */
const minOf = (width: string | undefined): number => {
  const match = /(\d+)px/.exec(width ?? '');
  return match ? Number(match[1]) : 100;
};

const Cell = ({ column, object, view, now, ctx }: { column: Column; object: Obj; view: KindView; now: number; ctx?: ViewContext }) => {
  if (column.cell === 'status') {
    const status = view.status?.(object);
    if (!status) return <span>{cellText(column, object, now)}</span>;
    return (
      <span class="k8s-status" title={status.label}>
        <Dot tone={status.tone} />
        <span class="k8s-ellipsis">{status.label}</span>
      </span>
    );
  }
  if (column.cell === 'tone') {
    const value = cellText(column, object, now);
    const tone = column.tone?.(object) ?? null;
    return (
      <span class="k8s-status" title={value}>
        {tone && value ? <Dot tone={tone} /> : null}
        <span class="k8s-ellipsis">{value}</span>
      </span>
    );
  }
  if (column.cell === 'containers') {
    const states = containerStates(object);
    return (
      <span class="k8s-dots" title={states.map((s) => `${s.name}: ${s.state}`).join('\n')}>
        {states.map((s) => <Dot tone={s.tone} />)}
      </span>
    );
  }
  const value = cellText(column, object, now, ctx);
  if (column.cell === 'meter') {
    const meter = column.meter?.(object, ctx) ?? null;
    const fraction = meter?.fraction ?? null;
    return (
      <span class="k8s-meter" title={value}>
        <span class="k8s-ellipsis">{value}</span>
        {fraction !== null ? <span class="k8s-meter-bar" data-tone={barTone(fraction)}><span style={{ width: `${Math.min(100, Math.max(2, Math.round(fraction * 100)))}%` }} /></span> : null}
      </span>
    );
  }
  return <span class={`k8s-ellipsis${column.cell === 'mono' ? ' sui-mono' : ''}`} title={column.cell === 'age' ? undefined : value}>{value}</span>;
};

export const Table = ({ view, columns, rows, sort, onSort, selectedKey, onSelect, now, ctx }: Props) => {
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const template = columns.map((c) => c.width ?? 'minmax(90px, 1fr)').join(' ');
  const minWidth = columns.reduce((sum, c) => sum + minOf(c.width) + 8, 16);
  const virtual = rows.length > VIRTUAL_FROM;

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = (): void => setHeight(node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const first = virtual ? Math.max(0, Math.floor(top / ROW_H) - OVERSCAN) : 0;
  const last = virtual ? Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN) : rows.length;
  const visible = rows.slice(first, last);

  const move = (delta: number): void => {
    const at = rows.findIndex((row) => objectKey(row) === selectedKey);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
    if (!next) return;
    onSelect(objectKey(next));
    const node = scroller.current;
    const index = rows.indexOf(next);
    if (node) {
      const y = index * ROW_H + ROW_H;
      if (y > node.scrollTop + node.clientHeight) node.scrollTop = y - node.clientHeight;
      else if (index * ROW_H < node.scrollTop + ROW_H) node.scrollTop = Math.max(0, index * ROW_H - ROW_H);
    }
  };

  return (
    <div
      class="k8s-table"
      ref={scroller}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length}
      onScroll={(event) => setTop((event.currentTarget as HTMLDivElement).scrollTop)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      <div class="k8s-grid" style={{ minWidth: `${minWidth}px` }}>
        <div class="k8s-thead" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((column) => (
            <button
              type="button"
              class="k8s-th"
              data-align={column.align}
              aria-sort={sort.column === column.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              title={column.hint}
              onClick={() => onSort(column.id)}
            >
              <span class="k8s-ellipsis">{column.label}</span>
              {sort.column === column.id ? <span class="k8s-sort">{sort.dir === 'asc' ? '\u2191' : '\u2193'}</span> : null}
            </button>
          ))}
        </div>
        {virtual ? <div style={{ height: `${first * ROW_H}px` }} /> : null}
        {visible.map((object) => {
          const key = objectKey(object);
          return (
            <div
              role="row"
              class="k8s-tr"
              key={key}
              aria-selected={key === selectedKey}
              style={{ gridTemplateColumns: template, height: `${ROW_H}px` }}
              onClick={() => onSelect(key)}
            >
              {columns.map((column) => (
                <div role="gridcell" class="k8s-td" data-align={column.align}>
                  <Cell column={column} object={object} view={view} now={now} ctx={ctx} />
                </div>
              ))}
            </div>
          );
        })}
        {virtual ? <div style={{ height: `${(rows.length - last) * ROW_H}px` }} /> : null}
      </div>
    </div>
  );
};
