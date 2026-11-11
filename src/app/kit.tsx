import {
  mountBadge, mountBanner, mountButton, mountEmpty, mountList, mountSearchField, mountSelect, mountSpinner, mountTabs,
  type BadgeProps, type BannerProps, type ButtonProps, type EmptyProps, type ListProps, type SearchFieldProps, type SelectProps, type SpinnerProps, type TabsProps,
} from '@openchamber/sdk/ui';
import { useKit, type Mount } from '@openchamber-ext/shared-ui/preact';

// The SDK kit controls as Preact components. Nothing here draws its own control.
const wrap = <P,>(mount: Mount<P>, display: 'inline-flex' | 'block' = 'inline-flex') => (props: P) => {
  const ref = useKit(mount, props);
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
