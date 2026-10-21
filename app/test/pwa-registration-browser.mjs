// Shipped registration entry + real Workbox workers, isolated loopback origin and fresh profiles.
// FRANK_BROWSER_TEST_PACKAGE=/tmp/frank-composer-browser/package.json node app/test/pwa-registration-browser.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { createPwaPreviewServer } from '../scripts/serve-pwa.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(
  process.env.FRANK_BROWSER_TEST_PACKAGE || import.meta.url,
)
const { chromium, webkit } = require('playwright')
const pwaRequire = createRequire(resolve(root, 'app/src-pwa/package.json'))
const { generateSW } = pwaRequire('workbox-build')
const reference = process.argv
  .find(arg => arg.startsWith('--source-ref='))
  ?.slice(13)
const entry = 'app/src-pwa/register-service-worker.js'
const source = reference
  ? execFileSync('git', ['show', `${reference}:${entry}`], {
      cwd: root,
      encoding: 'utf8',
    })
  : await readFile(resolve(root, entry), 'utf8')
const bundle = await build({
  stdin: {
    contents: source,
    resolveDir: resolve(root, 'app/src-pwa'),
    loader: 'js',
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  define: { 'import.meta.env.QUASAR_SERVICE_WORKER_FILE': '"/sw.js"' },
  plugins: [
    {
      name: 'notice-and-push-boundaries',
      setup(builder) {
        builder.onResolve(
          { filter: /^(quasar|src\/utils\/webpush-sync)$/ },
          args => ({ path: args.path, namespace: 'host' }),
        )
        builder.onLoad({ filter: /.*/, namespace: 'host' }, args => ({
          contents:
            args.path === 'quasar'
              ? `export const Notify={create(options){
            window.noticeCount=(window.noticeCount||0)+1;
            const notice=document.createElement('aside'); notice.id='update-notice';
            const dismiss=()=>{notice.remove();options.onDismiss()};
            for(const action of options.actions){const button=document.createElement('button');button.textContent=action.label;button.onclick=()=>{action.handler();dismiss()};notice.append(button)}
            document.body.append(notice);return dismiss;
          }}`
              : 'export const ensureBrowserPushSubscription = async () => null; export const syncRelayNotificationPolicy = async () => {}',
          loader: 'js',
        }))
      },
    },
  ],
})
const directory = await mkdtemp(join(tmpdir(), 'frank-pwa-registration-'))
for (const release of [1, 2]) {
  const path = join(directory, String(release))
  await mkdir(path)
  await writeFile(
    join(path, 'index.html'),
    `<!doctype html><title>Release ${release}</title><body data-release="${release}"><script src="/app.js"></script></body>`,
  )
  await writeFile(join(path, 'app.js'), bundle.outputFiles[0].text)
  await generateSW({
    globDirectory: path,
    globPatterns: ['index.html', 'app.js'],
    swDest: join(path, 'sw.js'),
    clientsClaim: true,
    skipWaiting: false,
    cleanupOutdatedCaches: true,
    navigateFallback: '/index.html',
    maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
  })
}
for (const [name, engine, options] of [
  [
    'chromium',
    chromium,
    {
      executablePath:
        process.env.CHAT_LAYOUT_CHROME ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
  ],
  ['webkit', webkit, {}],
]) {
  if (process.env.COMPOSER_BROWSER && process.env.COMPOSER_BROWSER !== name)
    continue
  for (const suppressControllerChange of [false, true]) {
    let release = 1
    const server = createPwaPreviewServer(() =>
      join(directory, String(release)),
    )
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    let browser
    try {
      browser = await engine.launch(options)
      const page = await browser.newPage()
      if (suppressControllerChange) {
        await page.addInitScript(() => {
          const add = navigator.serviceWorker.addEventListener.bind(
            navigator.serviceWorker,
          )
          navigator.serviceWorker.addEventListener = (type, ...args) => {
            if (type !== 'controllerchange') add(type, ...args)
          }
        })
      }
      await page.goto(`http://127.0.0.1:${server.address().port}`)
      await page.waitForFunction(() =>
        Boolean(navigator.serviceWorker.controller),
      )
      assert.equal(
        await page.locator('#update-notice').count(),
        0,
        'first installation is not an update',
      )
      await page.reload()
      await page.waitForFunction(() => Boolean(window.checkForAppUpdate))
      await page.evaluate(() => window.checkForAppUpdate())
      assert.equal(
        await page.locator('#update-notice').count(),
        0,
        'reload does not offer the same release',
      )
      release = 2
      await page.evaluate(() => window.checkForAppUpdate())
      await page.getByText('Update now', { exact: true }).waitFor()
      await page.getByText('Update now', { exact: true }).click()
      await page.waitForFunction(() => document.body.dataset.release === '2')
      await page.waitForFunction(() => Boolean(window.checkForAppUpdate))
      await page.evaluate(() => window.checkForAppUpdate())
      assert.equal(
        await page.locator('#update-notice').count(),
        0,
        'accepted release does not prompt again',
      )
      assert.equal(
        await page.evaluate(() =>
          navigator.serviceWorker
            .getRegistration()
            .then(reg => Boolean(reg.waiting)),
        ),
        false,
      )
      console.log(
        `PASS ${name} (controllerchange suppressed: ${suppressControllerChange}): first install silent; real release update activates and reloads; no repeated notice`,
      )
    } finally {
      await browser?.close()
      await new Promise(resolve => server.close(resolve))
    }
  }
}
