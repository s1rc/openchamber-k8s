import { connectHost } from '@openchamber/sdk';
import { api, toast, type ApiMethod, type Reply } from '@openchamber-ext/shared-ui';

export const host = connectHost();

type Params = Record<string, string | null | undefined>;

/** One call to the service. Never throws; a failure is `{ ok: false, code, error }`. */
export const call = (method: ApiMethod, path: string, params: Params | Record<string, unknown> = {}): Promise<Reply> =>
  method === 'GET'
    ? api(host, method, path, { name: 'Kubernetes', query: params as Params })
    : api(host, method, path, { name: 'Kubernetes', body: params });

/** Shows a toast. Only called from a click handler. */
export const notify = (kind: 'info' | 'success' | 'error', message: string): void => {
  void toast(host, kind, message);
};
