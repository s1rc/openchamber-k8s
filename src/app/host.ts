import { connectHost } from '@openchamber/sdk';
import { CLIPBOARD_MAX } from '../shared/clipboard.ts';
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

/**
 * Copies text with the host. The host takes at most 32 000 characters at once; longer text is refused, so this says so
 * instead of showing a success that did not happen. Returns whether the text was copied. Only called from a click.
 */
export const copyText = async (text: string, done: string): Promise<boolean> => {
  if (text.length === 0) {
    notify('error', 'There is nothing to copy.');
    return false;
  }
  if (text.length > CLIPBOARD_MAX) {
    notify('error', `That is ${text.length.toLocaleString()} characters and a copy holds ${CLIPBOARD_MAX.toLocaleString()}. Use the Copy button next to the text: it copies in parts.`);
    return false;
  }
  try {
    await host.writeClipboard(text);
  } catch {
    notify('error', 'The copy did not work. Try again.');
    return false;
  }
  notify('success', done);
  return true;
};
