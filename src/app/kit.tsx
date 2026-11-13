import {
  mountBadge, mountBanner, mountButton, mountEmpty, mountList, mountMenu, mountProgress, mountSearchField, mountSelect, mountSpinner, mountSwitch, mountTabs, mountTextField,
  type BadgeProps, type BannerProps, type ButtonProps, type CheckboxProps, type EmptyProps, type ListProps, type MenuProps, type ProgressProps, type SearchFieldProps, type SelectProps, type SpinnerProps,
  type TabsProps, type TextFieldProps,
} from '@openchamber/sdk/ui';
import type { Mount } from '@openchamber-ext/shared-ui/preact';
import { useEffect, useRef } from 'preact/hooks';
import { proxyFunctions, signatureOf } from './stable.ts';

/**
 * The control is repainted only when its data changed. A kit list repaints all its rows on an update, so a busy watch made
 * the row under the mouse blink. shared-ui's `useKit` did the same only before 0.2.0; this copy is kept (and tested).
 */
const useStableKit = <P,>(mount: Mount<P>, props: P) => {
  const ref = useRef<HTMLSpanElement>(null);
  const handle = useRef<ReturnType<Mount<P>> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const signature = signatureOf(props);
  const mounted = useRef(false);
  useEffect(() => {
    if (!ref.current) return;
    handle.current = mount(ref.current, proxyFunctions(latest.current, latest));
    mounted.current = true;
    return () => {
      handle.current?.dispose();
      handle.current = null;
      mounted.current = false;
    };
  }, []);
  const painted = useRef(signature);
  useEffect(() => {
    if (!mounted.current || painted.current === signature) return;
    painted.current = signature;
    handle.current?.update(proxyFunctions(latest.current, latest));
  }, [signature]);
  return ref;
};

// The SDK kit controls as Preact components. Nothing here draws its own control.
const wrap = <P,>(mount: Mount<P>, display: 'inline-flex' | 'block' = 'inline-flex') => (props: P) => {
  const ref = useStableKit(mount, props);
  return <span ref={ref} style={{ display, minWidth: 0 }} />;
};

export const Button = wrap<ButtonProps>(mountButton);
export const Select = wrap<SelectProps>(mountSelect, 'block');
export const SearchField = wrap<SearchFieldProps>(mountSearchField, 'block');
export const Tabs = wrap<TabsProps>(mountTabs);
export const Badge = wrap<BadgeProps>(mountBadge);
export const Spinner = wrap<SpinnerProps>(mountSpinner);
export const Banner = wrap<BannerProps>(mountBanner, 'block');
export const Empty = wrap<EmptyProps>(mountEmpty, 'block');
export const List = wrap<ListProps>(mountList, 'block');
export const Switch = wrap<CheckboxProps>(mountSwitch);
export const TextField = wrap<TextFieldProps>(mountTextField, 'block');
export const Menu = wrap<MenuProps>(mountMenu);
export const Progress = wrap<ProgressProps>(mountProgress, 'block');
