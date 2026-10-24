// POPUP_PLAYWRIGHT=/external/node_modules/playwright node app/test/browser/extension-popup-shell.mjs
// Uses a disposable browser profile and the generated Safari package; no account or relay.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createPwaPreviewServer } from '../../scripts/serve-pwa.mjs'

const require = createRequire(import.meta.url)
const { webkit, chromium } = require(process.env.POPUP_PLAYWRIGHT ||
  'playwright')
const directory = fileURLToPath(
  new URL('../../dist/extensions/safari/', import.meta.url),
)
const server = createPwaPreviewServer(() => directory)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
try {
  for (const [name, type] of [
    ['webkit', webkit],
    ['chromium', chromium],
  ]) {
    const browser = await type.launch(
      name === 'chromium' && process.env.CHROME_BIN
        ? { executablePath: process.env.CHROME_BIN }
        : {},
    )
    try {
      const page = await browser.newPage({
        viewport: { width: 800, height: 800 },
      })
      await page.route('**/*', route =>
        route
          .request()
          .url()
          .startsWith(origin + '/')
          ? route.continue()
          : route.abort(),
      )
      await page.goto(origin + '/popup.html')
      const child = page.frame({ url: /index\.html/ })
      assert.ok(child, 'generated shell must load its app frame')
      await child.waitForFunction(
        () => !!document.querySelector('#q-app')?.children.length,
      )
      const state = await page.evaluate(() => ({
        width: document.querySelector('iframe').getBoundingClientRect().width,
        height: document.querySelector('iframe').getBoundingClientRect().height,
        host: typeof window.frankPopupHost?.requestSyncSender,
        children: document.body.children.length,
      }))
      assert.deepEqual(state, {
        width: 400,
        height: 600,
        host: 'function',
        children: 1,
      })
      await child.evaluate(() =>
        document
          .querySelector('#q-app')
          .__vue_app__.config.globalProperties.$router.push(
            '/account-sync/receive',
          ),
      )
      const input = child.locator('input').first()
      await input.fill('123456')
      assert.equal(await input.inputValue(), '123456')
      console.log(
        `${name}: generated popup size, app boot, route navigation and PIN typing pass`,
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve))
}
