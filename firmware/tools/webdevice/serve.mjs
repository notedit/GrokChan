#!/usr/bin/env node
// Static server for the web device (no dependencies, Node >= 18):
//   node tools/webdevice/serve.mjs [port=8090]      ->  http://127.0.0.1:8090/
// Serves tools/webdevice/web/ plus the shared tools/preview/face_draw.js. Then point the page at a
// bridge (wrangler dev: ws://127.0.0.1:8787) and paste a device token. For a same-origin setup with no
// token pasting, use the bridge's own /sim route instead (SIM_UI_ENABLED=true).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, 'web');
const shared = { '/face_draw.js': join(here, '..', 'preview', 'face_draw.js') };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.sha256': 'text/plain' };
const port = Number(process.argv[2] || process.env.PORT || 8090);

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = shared[p] || normalize(join(webRoot, p));
    if (!shared[p] && !file.startsWith(webRoot + sep)) { res.writeHead(403).end('forbidden'); return; }
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`webdevice: http://127.0.0.1:${port}/  (127.0.0.1 only)`));
