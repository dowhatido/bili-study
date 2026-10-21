import http from 'node:http';
import { PROJECT_ROOT, inspectRuntime, isMain, readRuntimeFile } from './check.mjs';

const HOST = '127.0.0.1';
const PORT = 4174;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function reply(response, status, text, method, headers = {}) {
  const body = Buffer.from(text);
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...headers });
  response.end(method === 'HEAD' ? undefined : body);
}

export async function startPreview() {
  const snapshot = await inspectRuntime();
  const allowlist = new Set(snapshot.files.keys());
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== `${HOST}:${PORT}` || request.headers['sec-fetch-site'] === 'cross-site') {
        reply(response, 403, '不允许此来源访问。', request.method);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        reply(response, 405, '仅允许 GET 和 HEAD。', request.method, { Allow: 'GET, HEAD' });
        return;
      }
      // Inspect the raw request-target: URL normalization must not hide traversal attempts.
      const pathname = (request.url ?? '').split('?')[0];
      if (!pathname.startsWith('/') || /[\\%#\u0000-\u0020\u007f]/u.test(pathname)
        || pathname.includes('//') || pathname.split('/').some((part) => part === '.' || part === '..')) {
        reply(response, 400, '路径格式不正确。', request.method);
        return;
      }
      // Browser fallback only: no file lookup and no expansion of the runtime allowlist.
      if (pathname === '/favicon.ico') {
        response.writeHead(204, SECURITY_HEADERS);
        response.end();
        return;
      }
      const relative = pathname === '/' ? 'app.html' : pathname.slice(1);
      if (!allowlist.has(relative)) {
        reply(response, 404, '未找到运行资源。', request.method);
        return;
      }
      const body = await readRuntimeFile(relative, PROJECT_ROOT);
      const extension = relative.slice(relative.lastIndexOf('.'));
      if (!MIME[extension]) {
        reply(response, 404, '未找到运行资源。', request.method);
        return;
      }
      response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extension], 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      // Missing/changed/symlinked files are not exposed, and filesystem diagnostics stay private.
      if (!response.headersSent) reply(response, 404, '运行资源不可读取。', request.method);
      else response.destroy();
    }
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

if (isMain(import.meta.url)) {
  try {
    const server = await startPreview();
    console.log(`本机预览：http://${HOST}:${PORT}/app.html`);
    console.log(`侧栏预览：http://${HOST}:${PORT}/panel.html`);
    console.log('仅提供运行资源；扩展权限和后台功能需在浏览器加载扩展后验收。按 Ctrl+C 停止。');
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.on('error', () => { console.error('预览服务发生错误，已停止。'); process.exitCode = 1; stop(); });
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '预览启动失败：127.0.0.1:4174 已被占用，未干预已有进程。' : '预览启动失败，请先运行 npm run check 检查运行资源。');
    process.exitCode = 1;
  }
}
