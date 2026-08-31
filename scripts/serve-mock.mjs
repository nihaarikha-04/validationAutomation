// Serves mock-site/ over http so the extension's content scripts apply.
// http rather than file:// because content scripts need "Allow access to file URLs" otherwise.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../mock-site/', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8080);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.csv': 'text/csv' };

createServer(async (request, response) => {
  const requested = new URL(request.url ?? '/', 'http://localhost').pathname;
  const relative = normalize(requested === '/' ? 'index.html' : requested.slice(1));

  if (relative.startsWith('..')) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(join(ROOT, relative));
    response.writeHead(200, { 'content-type': TYPES[extname(relative)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Mock store on http://localhost:${PORT}`);
});
