import { connectHost, type GuestBlockCall } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const host = connectHost();

const App = () => {
  const [call, setCall] = useState<GuestBlockCall | null>(null);
  useEffect(() => host.onReady((ctx) => applyHostReady(ctx, document.documentElement)), []);
  useEffect(() => host.onBlock(setCall), []);
  useEffect(() => {
    const root = document.getElementById('root')!;
    const observer = new ResizeObserver(() => { void host.setHeight(Math.ceil(root.getBoundingClientRect().height)); });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return <div class="k8s-pad sui-muted">{call ? call.name : 'Waiting for the agent'}</div>;
};

render(<App />, document.getElementById('root')!);
