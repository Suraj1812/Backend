import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const assets = new Map([
  ['/', ['examples/browser-demo.html', 'text/html; charset=utf-8']],
  ['/docs/index.html', ['docs/index.html', 'text/html; charset=utf-8']],
  ['/docs/docs.css', ['docs/docs.css', 'text/css; charset=utf-8']],
  ['/docs/openapi.json', ['docs/openapi.json', 'application/json']],
  ['/output/pdf/frontend-api-guide.pdf', ['output/pdf/frontend-api-guide.pdf', 'application/pdf']],
]);
createServer(async (request, response) => {
  const asset = assets.get(new URL(request.url, 'http://localhost:5500').pathname);
  if (request.method !== 'GET' || !asset) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    response.writeHead(200, {
      'Content-Type': asset[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(await readFile(asset[0]));
  } catch {
    response.writeHead(503);
    response.end('Run npm run build first.');
  }
}).listen(5500, '127.0.0.1', () =>
  console.log('Local frontend calling the live API: http://localhost:5500'),
);
