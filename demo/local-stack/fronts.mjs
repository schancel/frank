// Loopback HTTPS fronts for the local stack: one TLS-terminating reverse proxy per participant
// (relay-a, relay-b, bot) and a static HTTPS server for the built app. Each has its own leaf
// certificate from the stack's throwaway CA.
//
// The proxies are transparent: request and response heads and bodies pass through unchanged
// (no added CORS, no rewriting), so what the browser sees is what the process behind produced.
// A participant that is not running answers 502 from the front.
//
// Every proxied exchange outside /chain-rpc/ is appended to logs/wire.jsonl with base64 bodies,
// so the exact bytes of directory, message and inbox requests can be inspected afterwards.
import { createServer as createHttps } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { FRONTS, HOST, P, PORTS } from './config.mjs'

const tls = name => ({ key: readFileSync(join(P.tls, `${name}.key`)), cert: readFileSync(join(P.tls, `${name}.pem`)) })
const CAPTURE_LIMIT = 1 << 20
const AUTH_HEADER = /^(authorization|cookie|x-frank-mailbox-(signature|token))$/i

function capture(record) {
  try {
    appendFileSync(P.wire, JSON.stringify(record) + '\n')
  } catch {
    // capture is best effort and must never disturb the proxied exchange
  }
}
const publicHeaders = headers =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, AUTH_HEADER.test(k) ? '(withheld)' : v]))

for (const front of FRONTS) {
  const server = createHttps(tls(front.name), (req, res) => {
    const wanted = !req.url.startsWith('/chain-rpc/')
    const reqChunks = [],
      resChunks = []
    let reqSize = 0,
      resSize = 0
    const up = httpRequest({ host: HOST, port: front.upstream, method: req.method, path: req.url, headers: req.headers }, upRes => {
      res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.rawHeaders)
      upRes.on('data', c => {
        if (wanted && (resSize += c.length) <= CAPTURE_LIMIT) resChunks.push(c)
        res.write(c)
      })
      upRes.on('end', () => {
        res.end()
        console.log(`${new Date().toISOString()} ${front.name} ${req.method} ${req.url} -> ${upRes.statusCode}`)
        if (wanted)
          capture({
            t: new Date().toISOString(),
            front: front.name,
            method: req.method,
            path: req.url,
            requestHeaders: publicHeaders(req.headers),
            requestBytes: reqSize,
            requestBase64: reqSize <= CAPTURE_LIMIT ? Buffer.concat(reqChunks).toString('base64') : null,
            status: upRes.statusCode,
            responseHeaders: publicHeaders(upRes.headers),
            responseBytes: resSize,
            responseBase64: resSize <= CAPTURE_LIMIT ? Buffer.concat(resChunks).toString('base64') : null,
          })
      })
    })
    up.on('error', error => {
      console.log(`${new Date().toISOString()} ${front.name} ${req.method} ${req.url} -> 502 (${error.code ?? error.message})`)
      if (wanted) capture({ t: new Date().toISOString(), front: front.name, method: req.method, path: req.url, status: 502, upstreamError: error.code ?? error.message })
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('upstream unavailable')
    })
    req.on('data', c => {
      if (wanted && (reqSize += c.length) <= CAPTURE_LIMIT) reqChunks.push(c)
      up.write(c)
    })
    req.on('end', () => up.end())
  })
  // WebSocket and other upgrades: replay the request head to the upstream and splice the sockets.
  server.on('upgrade', (req, socket, head) => {
    const upstream = connect(front.upstream, HOST, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
      console.log(`${new Date().toISOString()} ${front.name} UPGRADE ${req.url.startsWith('/chain-rpc/') ? '/chain-rpc/…' : req.url}`)
    })
    const close = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', close)
    socket.on('error', close)
  })
  server.listen(front.listen, HOST, () => console.log(`${front.name} https://${HOST}:${front.listen} -> http://${HOST}:${front.upstream}`))
}

// The app: the production build plus the operator's `directory/` folder. Like the shipped nginx
// config, a missing file is a 404 (the router is hash-mode, so there is no SPA fallback).
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}
createHttps(tls('app'), (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'https://app.invalid').pathname)
  const operator = /^\/directory\/([a-z-]+\.json)$/.exec(path)
  const root = operator ? P.appDirectory : P.appDist
  let file = resolve(root, operator ? operator[1] : '.' + path)
  if (file !== root && !file.startsWith(root + '/')) return res.writeHead(403).end()
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) {
    console.log(`${new Date().toISOString()} app ${req.method} ${path} -> 404`)
    return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  }
  console.log(`${new Date().toISOString()} app ${req.method} ${path} -> 200`)
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file))
}).listen(PORTS.httpsApp, HOST, () => console.log(`app https://${HOST}:${PORTS.httpsApp} -> ${P.appDist} (+ ${P.appDirectory} at /directory/)`))
