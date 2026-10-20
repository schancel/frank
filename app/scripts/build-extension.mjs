import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

export function copyDirectoryFiltered(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return false
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (
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
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
  return true
}

function ensureFallbackStaticAssets(targetDir) {
  const indexHtmlPath = path.join(targetDir, 'index.html')
  if (!fs.existsSync(indexHtmlPath)) {
    fs.writeFileSync(
      indexHtmlPath,
      `<!DOCTYPE html>
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
`,
      'utf8',
    )
  } else {
    let html = fs.readFileSync(indexHtmlPath, 'utf8')
    // Remove inline <script>...</script> blocks (without src) which violate Manifest V3 script-src 'self' CSP
    html = html.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '')
    // Remove PWA <link rel="manifest" href="/manifest.json"> so the browser does not parse the WebExtension manifest as a Web App Manifest
    html = html.replace(/<link[^>]*\brel=["']?manifest["']?[^>]*>/gi, '')
    if (!html.includes('extension-popup.css')) {
      html = html.replace(
        '</head>',
        '<link rel="stylesheet" href="/extension-popup.css"></head>',
      )
    }
    fs.writeFileSync(indexHtmlPath, html, 'utf8')
  }

  fs.writeFileSync(
    path.join(targetDir, 'extension-popup.css'),
    `html, body, #q-app {
  min-width: 400px !important;
  min-height: 580px !important;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
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

  const pwaDist = path.join(appDir, 'dist', 'pwa')
  const spaDist = path.join(appDir, 'dist', 'spa')
  const pwaMtime = fs.existsSync(path.join(pwaDist, 'index.html'))
    ? fs.statSync(path.join(pwaDist, 'index.html')).mtimeMs
    : -1
  const spaMtime = fs.existsSync(path.join(spaDist, 'index.html'))
    ? fs.statSync(path.join(spaDist, 'index.html')).mtimeMs
    : -1
  const staticSourceDir =
    pwaMtime >= spaMtime && pwaMtime > 0
      ? pwaDist
      : spaMtime > 0
      ? spaDist
      : null

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
    builtTargets.push({ target, targetDir, manifest })
    console.log(
      `[build:extension] Built ${target} WebExtension -> ${path.relative(
        appDir,
        targetDir,
      )}`,
    )
  }

  return builtTargets
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildExtensions()
}
