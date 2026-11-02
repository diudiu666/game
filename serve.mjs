/**
 * 极简静态服务器（仅开发用）
 * 用法: node serve.mjs [port]
 */
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
// 正式服固定 5173，这里默认 5174，两者可以同时开着不打架
const port = Number(process.argv[2] || 5174);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = normalize(join(root, url === '/' ? '/index.html' : url));

  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const st = statSync(file);
    if (st.isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + url);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`✗ 端口 ${port} 已被占用（正式服固定用 5173，这个静态服默认 5174）`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`抢地盘 dev server（仅静态，无联机） → http://localhost:${port}`);
});
