import { useMemo } from 'preact/hooks';
import { splitForClipboard } from '../shared/clipboard.ts';
import { copyText } from './host.ts';
import { Button, Menu } from './kit.tsx';

interface Props {
  text: string;
  /** What the toast says after a copy, e.g. "Manifest copied". A part adds its number. */
  done: string;
  label?: string;
  size?: 'xs' | 'sm';
  variant?: 'ghost' | 'outline';
}

/** A Copy button. Text longer than one copy holds becomes a Copy menu with one entry per part. */
export const CopyButton = ({ text, done, label = 'Copy', size = 'xs', variant = 'ghost' }: Props) => {
  const parts = useMemo(() => splitForClipboard(text), [text]);
  if (parts.length === 1) return <Button label={label} size={size} variant={variant} onClick={() => void copyText(text, done)} />;
  return (
    <Menu
      label={`${label} in parts`}
      size={size}
      variant={variant}
      items={parts.map((part, index) => ({ id: String(index), label: `Part ${index + 1} of ${parts.length} (${part.split('\n').length} lines)` }))}
      onSelect={(id) => {
        const index = Number(id);
        void copyText(parts[index] ?? '', `${done} (part ${index + 1} of ${parts.length}).`);
      }}
    />
  );
};
