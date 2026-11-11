import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';

interface Props {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
}

/** A dialog over the panel: one decision at a time. Escape and the backdrop close it. */
export const Modal = ({ title, onClose, children, footer, wide }: Props) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div class="k8s-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div class={`k8s-modal${wide ? ' k8s-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div class="k8s-modal-head">
          <strong>{title}</strong>
          <span class="k8s-push" />
        </div>
        <div class="k8s-modal-body">{children}</div>
        {footer ? <div class="k8s-modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
};
