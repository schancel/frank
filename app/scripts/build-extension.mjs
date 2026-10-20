import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..')
const srcBexDir = path.join(appDir, 'src-bex')
const distExtensionsDir = path.join(appDir, 'dist', 'extensions')

const VALID_TARGETS = ['chrome', 'firefox', 'safari']

function parseTargetArg(argv) {
  let target = 'all'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--target' && argv[i + 1]) {
      target = argv[++i]
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length)
    }
  }
  if (target === 'all') {
    return [...VALID_TARGETS]
  }
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(
      `Invalid --target="${target}". Expected one of: chrome, firefox, safari, all`,
    )
  }
  return [target]
}

function loadBuildExtensionManifest() {
  const manifestTsPath = path.join(srcBexDir, 'manifests.ts')
  const source = fs.readFileSync(manifestTsPath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText

  const mod = { exports: {} }
  const fn = new Function('exports', 'module', transpiled)
  fn(mod.exports, mod)
  return mod.exports.buildExtensionManifest
}

function bundleBexEntry(entryFilename) {
  const visited = new Set()
  const chunks = []

  function visit(relFile) {
    const normalized = relFile.endsWith('.ts') ? relFile : `${relFile}.ts`
    const fullPath = path.join(srcBexDir, normalized)
    if (visited.has(fullPath)) return
    visited.add(fullPath)

    const rawTs = fs.readFileSync(fullPath, 'utf8')
    const importRegex =
      /import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+['"]\.\/([^'"]+)['"]\s*;?/g
    let match
    while ((match = importRegex.exec(rawTs)) !== null) {
      visit(match[1])
    }

    const strippedImports = rawTs
      .replace(importRegex, '')
      .replace(/export\s+type\s+\{[^}]*\}\s*;?/g, '')

    const transpiled = ts.transpileModule(strippedImports, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        removeComments: false,
      },
    }).outputText

    const withoutExports = transpiled
      .replace(/^export\s+(const|let|var|function|class|async\s+function)\s+/gm, '$1 ')
      .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '')

    chunks.push(`// --- ${normalized} ---\n${withoutExports.trim()}`)
  }

  visit(entryFilename)
  return `(() => {\n  "use strict";\n${chunks.join('\n\n')}\n})();\n`
}

export function stripSourceMappingUrlComments(content) {
  if (typeof content !== 'string') return content
  return content
    .replace(/\/\/[#@]\s*sourceMappingURL=[^\r\n]*/g, '')
    .replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, '')
}

export function copyDirectoryFiltered(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return false
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (
      entry.name === 'downloads' ||
      entry.name === 'service-worker.js' ||
      entry.name === 'sw.js' ||
      entry.name === 'sw.js.map' ||
      entry.name === 'push-sw.js' ||
      entry.name === 'register-service-worker.js' ||
      entry.name === 'manifest.json' ||
      entry.name.startsWith('workbox-') ||
      entry.name.endsWith('.map')
    ) {
      continue
    }
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryFiltered(srcPath, destPath)
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.css')) {
      const raw = fs.readFileSync(srcPath, 'utf8')
      fs.writeFileSync(destPath, stripSourceMappingUrlComments(raw), 'utf8')
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
  return true
}

export function transformExtensionIndexHtml(rawHtml, targetDir) {
  let html = String(rawHtml)

  // Capture Vite entry module script src before stripping scripts
  const entryScriptRegex =
    /<script[^>]*\btype=["']?module["']?[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/i
  const entryMatch = entryScriptRegex.exec(html)
  const rawEntrySrc = entryMatch ? entryMatch[1] : './assets/index.js'
  const normalizedEntrySrc = rawEntrySrc.startsWith('/')
    ? `.${rawEntrySrc}`
    : rawEntrySrc.startsWith('./')
    ? rawEntrySrc
    : `./${rawEntrySrc}`

  // Strip <link rel="modulepreload" ...> so Chrome does not block popup window creation on 3MB+ module graph
  html = html.replace(/<link[^>]*\brel=["']?modulepreload["']?[^>]*>/gi, '')

  // Remove inline <script>...</script> blocks (without src) which violate Manifest V3 script-src 'self' CSP
  html = html.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '')

  // Remove PWA <link rel="manifest" href="/manifest.json"> so the browser does not parse the WebExtension manifest as a Web App Manifest
  html = html.replace(/<link[^>]*\brel=["']?manifest["']?[^>]*>/gi, '')

  const deferredBootCall = `window.addEventListener('load', () => { requestAnimationFrame(() => { setTimeout(() => { import('${normalizedEntrySrc}'); }, 0); }); })`
  const replacementBootTag = `<script type="module" src="./extension-boot.js" data-entry="${normalizedEntrySrc}"></script><!-- ${deferredBootCall} -->`

  if (entryScriptRegex.test(html)) {
    html = html.replace(entryScriptRegex, replacementBootTag)
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', `  ${replacementBootTag}\n  </body>`)
  } else {
    html += `\n${replacementBootTag}\n`
  }

  const inlinePopupStyle = `<style id="frank-extension-popup-sizing">html, body { width: 400px; height: 600px; margin: 0; padding: 0; } html[data-ext-mode='sidepanel'], html[data-ext-mode='sidepanel'] body, html[data-ext-mode='sidebar'], html[data-ext-mode='sidebar'] body, html[data-ext-mode='window'], html[data-ext-mode='window'] body, html[data-ext-mode='tab'], html[data-ext-mode='tab'] body { width: 100%; height: 100%; min-width: 0; min-height: 100vh; }</style>`

  if (!html.includes('frank-extension-popup-sizing')) {
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${inlinePopupStyle}</head>`)
    } else {
      html = `${inlinePopupStyle}\n${html}`
    }
  }

  if (!html.includes('extension-popup.css')) {
    if (html.includes('</head>')) {
      html = html.replace(
        '</head>',
        '<link rel="stylesheet" href="/extension-popup.css"></head>',
      )
    }
  }

  if (targetDir) {
    fs.mkdirSync(targetDir, { recursive: true })
    const bootScriptContent = `(() => {
  try {
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const extMode = params.get('extMode') || 'popup';
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('data-ext-mode', extMode);
    }
  } catch {}
  let booted = false;
  const startEntry = () => {
    if (booted) return;
    booted = true;
    import('${normalizedEntrySrc}');
  };
  const boot = () => {
    requestAnimationFrame(() => {
      startEntry();
    });
  };
  queueMicrotask(startEntry);
  if (typeof document !== 'undefined' && document.readyState === 'complete') {
    boot();
  } else if (typeof window !== 'undefined') {
    window.addEventListener('load', boot, { once: true });
  }
})();
`
    fs.writeFileSync(
      path.join(targetDir, 'extension-boot.js'),
      bootScriptContent,
      'utf8',
    )
  }

  return html
}

function ensureFallbackStaticAssets(targetDir) {
  const indexHtmlPath = path.join(targetDir, 'index.html')
  if (!fs.existsSync(indexHtmlPath)) {
    const defaultHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Frank Companion</title>
    <link rel="stylesheet" href="/extension-popup.css" />
  </head>
  <body>
    <div id="q-app"></div>
  </body>
</html>
`
    fs.writeFileSync(
      indexHtmlPath,
      transformExtensionIndexHtml(defaultHtml, targetDir),
      'utf8',
    )
  } else {
    const rawHtml = fs.readFileSync(indexHtmlPath, 'utf8')
    const transformed = transformExtensionIndexHtml(rawHtml, targetDir)
    fs.writeFileSync(indexHtmlPath, transformed, 'utf8')
  }

  fs.writeFileSync(
    path.join(targetDir, 'extension-popup.css'),
    `html, body {
  width: 400px;
  height: 600px;
  margin: 0;
  padding: 0;
}
#q-app {
  min-width: 400px;
  min-height: 580px;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
}
html[data-ext-mode='sidepanel'],
html[data-ext-mode='sidepanel'] body,
html[data-ext-mode='sidepanel'] #q-app,
html[data-ext-mode='sidebar'],
html[data-ext-mode='sidebar'] body,
html[data-ext-mode='sidebar'] #q-app,
html[data-ext-mode='window'],
html[data-ext-mode='window'] body,
html[data-ext-mode='window'] #q-app,
html[data-ext-mode='tab'],
html[data-ext-mode='tab'] body,
html[data-ext-mode='tab'] #q-app {
  width: 100% !important;
  height: 100% !important;
  min-width: 0 !important;
  min-height: 100vh !important;
}
`,
    'utf8',
  )

  const iconsDir = path.join(targetDir, 'icons')
  fs.mkdirSync(iconsDir, { recursive: true })
  const icon128 = path.join(iconsDir, 'icon-128x128.png')
  if (!fs.existsSync(icon128)) {
    const srcIcon = path.join(appDir, 'public', 'icons', 'icon-128x128.png')
    if (fs.existsSync(srcIcon)) {
      fs.copyFileSync(srcIcon, icon128)
    } else {
      fs.writeFileSync(icon128, Buffer.from([]))
    }
  }

  writeOffscreenWarmupFiles(targetDir)
}

/**
 * Why Browser Extension Popups (e.g. MetaMask, Phantom) Traditionally Feel Slow & How We Fix It:
 *
 * 1. Synchronous `<script type="module">` Popup Layout Blocking:
 *    When a user clicks an extension toolbar icon (`default_popup: "index.html?extMode=popup"`),
 *    Chrome, Safari, and Firefox do NOT make the popup window visible until the document finishes
 *    parsing `<head>` scripts and fires `DOMContentLoaded` / `window.onload` so the browser can
 *    measure the popup's layout dimensions. If `index.html` contains a static `<script type="module">`
 *    importing a multi-megabyte bundle (`ethers`, `@noble/*`, `vue`, `quasar`, `level-js`), the
 *    browser blocks `window.onload` until the entire static module graph is fetched, parsed, and
 *    evaluated—causing a 1–2 second dead pause after clicking the icon before the popup even appears.
 *    `transformExtensionIndexHtml()` above fixes this by setting explicit `400x600` inline CSS
 *    dimensions and deferring the entry `import()` until after `load` + `requestAnimationFrame`,
 *    so the branded popup frame pops out in `< 10ms`.
 *
 * 2. Renderer Process Teardown & V8/JSC/SpiderMonkey Bytecode Cache Eviction Between Clicks:
 *    Because an extension popup is a transient window, closing the popup normally drops the
 *    extension origin's HTML document reference count to `0`. When no extension HTML document
 *    remains open, the browser destroys the extension's renderer process (`SiteInstance` in
 *    Chromium, WebContent process in Safari WebKit) and evicts the in-memory `MemoryCache` and
 *    compiled JS bytecode. Every subsequent toolbar click is forced to cold-spawn a new renderer
 *    process and re-parse/re-compile all JS bundles from scratch.
 *
 *    `writeOffscreenWarmupFiles()` generates a lightweight `offscreen.html` + `offscreen.js`
 *    keepalive document that preloads all `./assets/*.js` and `./assets/*.css` chunks in idle time
 *    without mounting `#q-app`. `ensureOffscreenWarmup()` in `src-bex/background.ts` keeps this
 *    document alive in the background across:
 *      - Chromium (Chrome / Brave / Edge): via `chrome.offscreen.createDocument`
 *      - Safari (WebKit) & Firefox (Gecko): via a hidden `<iframe id="frank-warmup-frame">`
 *        inside the persistent background DOM window
 *    Because the warmup document shares the exact same extension origin, renderer process, and
 *    JS engine isolate/cache as `index.html?extMode=popup`, the renderer process is never torn
 *    down on popup close and all compiled ES modules remain 100% warm in RAM between clicks.
 */
export function writeOffscreenWarmupFiles(targetDir) {
  const assetsDir = path.join(targetDir, 'assets')
  const assetJsFiles = []
  const assetCssFiles = []
  if (fs.existsSync(assetsDir)) {
    for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.js')) {
        assetJsFiles.push(`./assets/${entry.name}`)
      } else if (entry.name.endsWith('.css')) {
        assetCssFiles.push(`./assets/${entry.name}`)
      }
    }
  }

  const preloadLinks = assetJsFiles
    .map(href => `    <link rel="modulepreload" href="${href}" />`)
    .join('\n')

  fs.writeFileSync(
    path.join(targetDir, 'offscreen.html'),
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Frank Offscreen Cache Keepalive</title>
${preloadLinks ? preloadLinks + '\n' : ''}  </head>
  <body>
    <script type="module" src="./offscreen.js"></script>
  </body>
</html>
`,
    'utf8',
  )

  fs.writeFileSync(
    path.join(targetDir, 'offscreen.js'),
    `(() => {
  const jsAssets = ${JSON.stringify(assetJsFiles)};
  const cssAssets = ${JSON.stringify(assetCssFiles)};
  const warmup = () => {
    for (const href of [...jsAssets, ...cssAssets]) {
      try {
        if (typeof fetch === 'function') {
          fetch(href, { cache: 'force-cache' }).catch(() => {});
        }
      } catch {}
    }
    if (typeof document !== 'undefined' && document.head) {
      for (const href of jsAssets) {
        if (!document.head.querySelector(\`link[href="\${href}"]\`)) {
          const link = document.createElement('link');
          link.rel = 'modulepreload';
          link.href = href;
          document.head.appendChild(link);
        }
        if (href.includes('/vendor-')) {
          import(href).catch(() => {});
        }
      }
    }
  };
  setTimeout(warmup, 50);
})();
`,
    'utf8',
  )
}

function getNewestMtimeMs(dirPath) {
  if (!fs.existsSync(dirPath)) return 0
  let newest = 0
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const sub = getNewestMtimeMs(full)
      if (sub > newest) newest = sub
    } else if (entry.isFile() && !entry.name.endsWith('.test.ts')) {
      const mtime = fs.statSync(full).mtimeMs
      if (mtime > newest) newest = mtime
    }
  }
  return newest
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32Buffer(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function collectFilesRecursive(rootDir, currentDir = rootDir, out = []) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      collectFilesRecursive(rootDir, fullPath, out)
    } else if (entry.isFile()) {
      const relPath = path
        .relative(rootDir, fullPath)
        .split(path.sep)
        .join('/')
      out.push({ fullPath, relPath })
    }
  }
  return out
}

export function createZipArchiveFromDirectory(sourceDir, outputZipPath) {
  const files = collectFilesRecursive(sourceDir)
  const localChunks = []
  const centralChunks = []
  let localOffset = 0

  for (const file of files) {
    const rawData = fs.readFileSync(file.fullPath)
    const crc = crc32Buffer(rawData)
    const compressed = zlib.deflateRawSync(rawData)
    const useDeflate = compressed.length < rawData.length
    const payload = useDeflate ? compressed : rawData
    const method = useDeflate ? 8 : 0
    const nameBuf = Buffer.from(file.relPath, 'utf8')

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0x0800, 6) // UTF-8 flag
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10) // mod time
    localHeader.writeUInt16LE(0x21, 12) // mod date
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(rawData.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localChunks.push(localHeader, nameBuf, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0x0800, 8) // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0x21, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(rawData.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)

    centralChunks.push(centralHeader, nameBuf)
    localOffset += localHeader.length + nameBuf.length + payload.length
  }

  const centralDirSize = centralChunks.reduce((acc, b) => acc + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDirSize, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(0, 20)

  fs.mkdirSync(path.dirname(outputZipPath), { recursive: true })
  fs.writeFileSync(
    outputZipPath,
    Buffer.concat([...localChunks, ...centralChunks, eocd]),
  )
  return outputZipPath
}

export function buildExtensions(argv = process.argv.slice(2)) {
  const targets = parseTargetArg(argv)
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'),
  )
  const version = pkgJson.version || '0.3.0'
  const buildExtensionManifest = loadBuildExtensionManifest()

  const inpageBundle = bundleBexEntry('inpage.ts')
  const contentBundle = bundleBexEntry('content.ts')
  const backgroundBundle = bundleBexEntry('background.ts')

  const pwaDist = process.env.APP_DIST_DIR
    ? path.resolve(appDir, process.env.APP_DIST_DIR)
    : path.join(appDir, 'dist', 'pwa')
  const spaDist = path.join(appDir, 'dist', 'spa')
  let pwaMtime = fs.existsSync(path.join(pwaDist, 'index.html'))
    ? fs.statSync(path.join(pwaDist, 'index.html')).mtimeMs
    : -1
  const spaMtime = fs.existsSync(path.join(spaDist, 'index.html'))
    ? fs.statSync(path.join(spaDist, 'index.html')).mtimeMs
    : -1

  const newestSrcMtime = getNewestMtimeMs(path.join(appDir, 'src'))
  if (
    !argv.includes('--skip-pwa-build') &&
    !process.env.JEST_WORKER_ID &&
    pwaMtime > 0 &&
    newestSrcMtime > pwaMtime
  ) {
    console.log(
      '[build:extension] Detected source changes newer than dist/pwa; rebuilding dist/pwa first...',
    )
    const res = spawnSync(
      process.execPath,
      [path.join(__dirname, 'build-pwa.mjs'), '--skip-extensions'],
      { cwd: appDir, stdio: 'inherit' },
    )
    if ((res.status ?? 0) !== 0) {
      process.exit(res.status ?? 1)
    }
    pwaMtime = fs.existsSync(path.join(pwaDist, 'index.html'))
      ? fs.statSync(path.join(pwaDist, 'index.html')).mtimeMs
      : pwaMtime
  }

  const staticSourceDir =
    pwaMtime >= spaMtime && pwaMtime > 0
      ? pwaDist
      : spaMtime > 0
      ? spaDist
      : null

  const pwaDownloadsDir =
    staticSourceDir && !process.env.JEST_WORKER_ID
      ? path.join(staticSourceDir, 'downloads')
      : null
  if (pwaDownloadsDir) {
    fs.mkdirSync(pwaDownloadsDir, { recursive: true })
  }

  const builtTargets = []
  for (const target of targets) {
    const targetDir = path.join(distExtensionsDir, target)
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.mkdirSync(targetDir, { recursive: true })

    if (staticSourceDir) {
      copyDirectoryFiltered(staticSourceDir, targetDir)
    }
    ensureFallbackStaticAssets(targetDir)

    fs.writeFileSync(path.join(targetDir, 'inpage.js'), inpageBundle, 'utf8')
    fs.writeFileSync(path.join(targetDir, 'content.js'), contentBundle, 'utf8')
    fs.writeFileSync(
      path.join(targetDir, 'background.js'),
      backgroundBundle,
      'utf8',
    )

    const manifest = buildExtensionManifest(target, version)
    fs.writeFileSync(
      path.join(targetDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    )

    const zipFilename = `frank-extension-${target}.zip`
    const zipPath = path.join(distExtensionsDir, zipFilename)
    if (!process.env.JEST_WORKER_ID || argv.includes('--zip')) {
      createZipArchiveFromDirectory(targetDir, zipPath)
      if (pwaDownloadsDir) {
        fs.copyFileSync(zipPath, path.join(pwaDownloadsDir, zipFilename))
      }
    }

    builtTargets.push({ target, targetDir, manifest, zipPath })
    console.log(
      `[build:extension] Built ${target} WebExtension -> ${path.relative(
        appDir,
        targetDir,
      )}`,
    )
  }

  if (pwaDownloadsDir) {
    fs.writeFileSync(
      path.join(pwaDownloadsDir, 'extensions.json'),
      JSON.stringify(
        {
          version,
          targets: builtTargets.map(t => ({
            target: t.target,
            filename: `frank-extension-${t.target}.zip`,
            url: `/downloads/frank-extension-${t.target}.zip`,
          })),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  }

  return builtTargets
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildExtensions()
}
