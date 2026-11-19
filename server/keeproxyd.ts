// SPDX-License-Identifier: Apache-2.0
//
// keeproxyd: the console's backend. Serves the built web app, a small JSON
// API over VaultService, and a Server-Sent Events stream of vault events.
//
//   npm run env:up && npm run serve      # http://127.0.0.1:8787
//
// It binds to 127.0.0.1 only: it holds demo keys for every role.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { VaultService } from '../src/vault-service.js';

const PORT = Number(process.env['PORT'] ?? 8787);
const HOST = '127.0.0.1';
const WEB_DIST = path.resolve('web', 'dist');

const svc = await VaultService.start();

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = path.join(WEB_DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(WEB_DIST)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
  if (!existsSync(file)) return json(res, 404, { error: 'web app not built: npm run build:web' });
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return json(res, 200, { network: svc.network, address: svc.address, busy: svc.busy });
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return json(res, 200, {
        network: svc.network,
        busy: svc.busy,
        chain: await svc.publicView(),
        devices: svc.deviceView(),
        now: Math.floor(Date.now() / 1000),
      });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      for (const e of svc.log.slice(-50)) res.write(`data: ${JSON.stringify(e)}\n\n`);
      const on = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      svc.on('event', on);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        svc.off('event', on);
        clearInterval(ping);
      });
      return;
    }
    if (url.pathname === '/api/vault' && req.method === 'POST') {
      const b = await body(req);
      const r = await svc.createVault({
        threshold: BigInt(String(b['threshold'] ?? 2)),
        inactivity: BigInt(String(b['inactivity'] ?? 600)),
        veto: BigInt(String(b['veto'] ?? 180)),
      });
      return json(res, r.ok ? 200 : 400, r);
    }
    if (url.pathname === '/api/act' && req.method === 'POST') {
      const b = await body(req);
      const r = await svc.act(String(b['action']), (b['params'] as Record<string, unknown>) ?? {});
      return json(res, 200, r);
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
    return serveStatic(req, res);
  } catch (e) {
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`keeproxyd on http://${HOST}:${PORT} (network: ${svc.network}, vault: ${svc.address ?? 'none'})`);
});

const shutdown = async () => {
  server.close();
  await svc.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
