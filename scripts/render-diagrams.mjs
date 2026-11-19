// Renders docs/diagrams/*.excalidraw to PNG with Excalidraw's own exporter.
// Excalidraw renders in a browser, so this serves a page on 127.0.0.1:8799;
// open it and every scene is drawn and saved next to its source.
//
//   node scripts/render-diagrams.mjs     then open http://127.0.0.1:8799

import { createServer } from 'node:http';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve('docs/diagrams');
const PORT = 8799;
const UTILS = 'https://unpkg.com/@excalidraw/utils@0.1.2/dist/excalidraw-utils.min.js';
const FONTS = 'https://unpkg.com/@excalidraw/excalidraw@0.17.6/dist/excalidraw-assets';

const page = `<!doctype html><meta charset="utf-8"><title>render diagrams</title>
<style>
@font-face { font-family: Virgil; src: url(${FONTS}/Virgil.woff2); }
@font-face { font-family: Cascadia; src: url(${FONTS}/Cascadia.woff2); }
body { font: 14px system-ui; margin: 24px; } img { max-width: 100%; border: 1px solid #ddd; margin: 8px 0 24px; }
</style>
<p id="s">loading…</p>
<script src="${UTILS}"></script>
<script>
(async () => {
  const say = (t) => (document.getElementById('s').textContent = t);
  await Promise.all([document.fonts.load('20px Virgil'), document.fonts.load('20px Cascadia')]);
  const names = await (await fetch('/scenes')).json();
  for (const name of names) {
    say('rendering ' + name);
    const scene = await (await fetch('/scene/' + name)).json();
    const blob = await ExcalidrawUtils.exportToBlob({
      elements: scene.elements,
      appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false, exportPadding: 40 },
      files: {},
      mimeType: 'image/png',
      getDimensions: (w, h) => ({ width: w * 2, height: h * 2, scale: 2 }),
    });
    await fetch('/png/' + name, { method: 'POST', body: blob });
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    document.body.append(name, img);
  }
  await fetch('/done', { method: 'POST' });
  say('done: ' + names.join(', '));
})().catch((e) => { document.getElementById('s').textContent = 'error: ' + e; fetch('/done', { method: 'POST', body: String(e) }); });
</script>`;

const scenes = () => readdirSync(DIR).filter((f) => f.endsWith('.excalidraw')).map((f) => f.slice(0, -'.excalidraw'.length));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const name = decodeURIComponent(url.pathname.split('/')[2] ?? '');
  if (name && !scenes().includes(name)) return res.writeHead(404).end();
  if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (url.pathname === '/scenes') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(scenes()));
  if (url.pathname.startsWith('/scene/')) {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(join(DIR, `${name}.excalidraw`)));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (url.pathname.startsWith('/png/')) {
    writeFileSync(join(DIR, `${name}.png`), Buffer.concat(chunks));
    console.log(`docs/diagrams/${name}.png  ${Buffer.concat(chunks).length} bytes`);
    return res.writeHead(204).end();
  }
  if (url.pathname === '/done') {
    const err = Buffer.concat(chunks).toString();
    console.log(err ? `failed: ${err}` : 'all diagrams rendered');
    res.writeHead(204).end();
    server.close();
    process.exitCode = err ? 1 : 0;
    return;
  }
  res.writeHead(404).end();
});
server.listen(PORT, '127.0.0.1', () => console.log(`open http://127.0.0.1:${PORT} to render ${scenes().length} diagrams`));
