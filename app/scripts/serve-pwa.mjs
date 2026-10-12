import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultDirectory = fileURLToPath(new URL('../dist/pwa/', import.meta.url))
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

// Local preview only. Production hosting must supply HTTPS and equivalent headers.
export function createPwaPreviewServer(directory = () => defaultDirectory) {
  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, {
        'Allow': 'GET, HEAD',
        'Cache-Control': 'no-store',
      })
      response.end()
      return
    }
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, 'http://localhost').pathname,
      )
      const root = resolve(directory())
      const filename = resolve(
        root,
        `.${pathname === '/' ? '/index.html' : pathname}`,
      )
      if (!filename.startsWith(root + sep)) {
        response.writeHead(403)
        response.end()
        return
      }
      const body = await readFile(filename)
      response.writeHead(200, {
        'Content-Type':
          mimeTypes[extname(filename)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': /^\/assets\/[^/]+-[\w-]{8,}\.[\w]+$/.test(pathname)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch {
      response.writeHead(404, { 'Cache-Control': 'no-store' })
      response.end()
    }
  })
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const portIndex = process.argv.indexOf('--port')
  const port = portIndex < 0 ? 38770 : Number(process.argv[portIndex + 1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535')
  }
  createPwaPreviewServer().listen(port, '127.0.0.1', () => {
    console.log(`PWA preview: http://127.0.0.1:${port}`)
  })
}
