import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleRequest } from './api.ts';

export function createApp() {
  return createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });
}

export async function listen(port = 0): Promise<string> {
  const server = createApp();
  await new Promise<void>((resolve) =>
    server.listen(port, '127.0.0.1', resolve),
  );
  const { port: actual } = server.address() as AddressInfo;
  return `http://127.0.0.1:${actual}`;
}
