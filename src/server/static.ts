import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse): void {
  const root = resolve(distDir)
  if (!existsSync(join(root, 'index.html'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><body style="background:#111;color:#ddd;font-family:monospace;padding:2rem">' +
        '<h1>TriTetris server</h1><p>Client build not found. Run <code>npm run build</code> first, ' +
        'or use <code>npm run dev:client</code> (Vite on :5173) during development.</p></body>',
    )
    return
  }
  const urlPath = (req.url ?? '/').split('?')[0]
  let filePath = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath))
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end()
    return
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(root, 'index.html') // SPA fallback
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(res)
}
