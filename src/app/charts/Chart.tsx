import { useEffect, useRef, useState } from 'preact/hooks';
import { areaPath, boundsOf, linePath, nearestIndex, valueText, type ChartUnit, type Series } from '../../shared/prom.ts';

export interface ChartData {
  id: string;
  title: string;
  unit: ChartUnit;
  series: Series[];
  hidden: number;
  note?: string;
  error?: string;
}

interface Props {
  chart: ChartData;
}

const HEIGHT = 124;
const LEFT = 52;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 18;

const clock = (seconds: number): string => new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const lastValue = (series: Series): number | null => {
  for (let i = series.points.length - 1; i >= 0; i -= 1) {
    const value = series.points[i]![1];
    if (value !== null) return value;
  }
  return null;
};

/** One line chart drawn as SVG. Colors come from the theme through CSS classes, so light and dark both work. */
export const Chart = ({ chart }: Props) => {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = (): void => setWidth(Math.max(200, Math.floor(node.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { series, unit } = chart;
  const bounds = boundsOf(series, unit);
  const plotW = width - LEFT - RIGHT;
  const plotH = HEIGHT - TOP - BOTTOM;
  const x = (time: number): number => LEFT + ((time - bounds.start) / (bounds.end - bounds.start)) * plotW;
  const y = (value: number): number => TOP + plotH - (Math.min(value, bounds.max) / bounds.max) * plotH;
  const floor = TOP + plotH;

  let readout = '';
  let hoverX: number | null = null;
  if (hover !== null && series[0]) {
    const at = series[0].points[nearestIndex(series[0].points, hover)];
    if (at) {
      hoverX = x(at[0]);
      readout = `${clock(at[0])}  ${series
        .map((line) => {
          const point = line.points[nearestIndex(line.points, at[0])];
          return `${line.name} ${point && point[1] !== null ? valueText(unit, point[1], true) : 'no data'}`;
        })
        .join('  ')}`;
    }
  }

  const onMove = (event: PointerEvent): void => {
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    const fraction = (event.clientX - rect.left - LEFT) / plotW;
    setHover(bounds.start + Math.min(1, Math.max(0, fraction)) * (bounds.end - bounds.start));
  };

  return (
    <div class="k8s-chart" ref={box}>
      <div class="k8s-chart-head">
        <strong>{chart.title}</strong>
        {series.length > 0 ? (
          <span class="k8s-chart-legend sui-small">
            {series.map((line, index) => {
              const now = lastValue(line);
              return (
                <span class="k8s-chart-key" title={line.name}>
                  <span class={`k8s-swatch k8s-series-${index}`} />
                  <span class="k8s-ellipsis">{line.name}</span>
                  {now !== null ? <span class="sui-muted">{valueText(unit, now, true)}</span> : null}
                </span>
              );
            })}
            {chart.hidden > 0 ? <span class="sui-muted">{`+${chart.hidden} more`}</span> : null}
          </span>
        ) : null}
      </div>
      {chart.note ? <div class="sui-muted sui-small">{chart.note}</div> : null}
      {series.length === 0 ? (
        <div class="k8s-chart-empty sui-muted sui-small">{chart.error ?? 'Prometheus has no data for this in the last hour.'}</div>
      ) : (
        <>
          <div class="k8s-chart-readout sui-mono sui-small" aria-live="off">{readout || '\u00a0'}</div>
          <svg class="k8s-chart-svg" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={`${chart.title}, last hour`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {[0, 0.5, 1].map((step) => {
              const gy = floor - step * plotH;
              return (
                <g>
                  <line class="k8s-grid-line" x1={LEFT} x2={width - RIGHT} y1={gy} y2={gy} />
                  <text class="k8s-axis" x={LEFT - 6} y={gy + 3} text-anchor="end">{valueText(unit, step * bounds.max)}</text>
                </g>
              );
            })}
            {[0, 0.5, 1].map((step) => (
              <text class="k8s-axis" x={LEFT + step * plotW} y={HEIGHT - 4} text-anchor={step === 0 ? 'start' : step === 1 ? 'end' : 'middle'}>
                {clock(bounds.start + step * (bounds.end - bounds.start))}
              </text>
            ))}
            {series.length === 1 ? <path class="k8s-area k8s-series-0" d={areaPath(series[0]!.points, x, y, floor)} /> : null}
            {series.map((line, index) => <path class={`k8s-line k8s-series-${index}`} d={linePath(line.points, x, y)} />)}
            {series.map((line, index) => {
              // A series with one reading (a new pod or node) has no line to draw, so it gets a dot.
              const readings = line.points.filter(([, value]) => value !== null);
              return readings.length === 1 ? <circle class={`k8s-point k8s-series-${index}`} cx={x(readings[0]![0])} cy={y(readings[0]![1]!)} r={3} /> : null;
            })}
            {hoverX !== null ? <line class="k8s-hover-line" x1={hoverX} x2={hoverX} y1={TOP} y2={floor} /> : null}
          </svg>
        </>
      )}
    </div>
  );
};
