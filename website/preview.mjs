import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { root, pages } from './build.mjs';

// Local preview only. Production is static files on Pages, never the harness server.
export function preview(prefix = '/') {
  const allowed = new Set([...pages, 'styles.css', 'icon.svg', '.nojekyll']);
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const file = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || 'index.html' : '';
    if (!allowed.has(file) || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404); response.end('Not found'); return;
    }
    try {
      const body = await readFile(resolve(root, 'dist', file));
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/svg+xml';
      response.writeHead(200, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404); response.end('Build the site first: node website/build.mjs');
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = preview();
  const port = Number(process.env.PORT ?? 4173);
  server.listen(port, '127.0.0.1', () => console.log(`Website preview: http://127.0.0.1:${port}`));
}
