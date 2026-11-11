import http from 'node:http';
import { createServiceHost } from '@openchamber/sdk';
import { toReply } from './errors.ts';
import { cleanupStaleProxies, stopAllProxies } from './proxy.ts';
import { routes, shutdownRoutes } from './routes.ts';
import { setEmitter } from './watch.ts';

const host = createServiceHost({ env: process.env });
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;

setEmitter(async (topic, data) => {
  await host.emit(topic, data as Parameters<typeof host.emit>[1]);
});

const parseBody = (body: string): Record<string, unknown> => {
  try {
    const value: unknown = body ? JSON.parse(body) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const send = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) {
        send(res, 404, { ok: false, code: 'NOT_FOUND', error: 'No such route.' });
        return;
      }
      const params = { ...Object.fromEntries(url.searchParams), ...parseBody(body) };
      // A failure is an answer with ok:false, never a 500.
      handler(params).then(
        (answer) => send(res, 200, answer),
        (error: unknown) => send(res, 200, toReply(error)),
      );
    });
  })
  .listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');

void cleanupStaleProxies().catch(() => undefined);

const shutdown = (): void => {
  shutdownRoutes();
  stopAllProxies();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
