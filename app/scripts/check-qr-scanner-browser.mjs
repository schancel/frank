// npm install --prefix /tmp/frank-qr-browser playwright
// FRANK_BROWSER_TEST_PACKAGE=/tmp/frank-qr-browser/package.json node app/scripts/check-qr-scanner-browser.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(
  process.env.FRANK_BROWSER_TEST_PACKAGE || import.meta.url,
)
const { firefox } = require('playwright')
const server = await createServer({
  configFile: false,
  resolve: {
    alias: {
      vue: fileURLToPath(
        new URL(
          '../../node_modules/vue/dist/vue.esm-bundler.js',
          import.meta.url,
        ),
      ),
    },
  },
  optimizeDeps: { include: ['vue', 'quasar', 'qrcode.vue', '@zxing/browser'] },
  root: fileURLToPath(new URL('../test/qr-scanner/', import.meta.url)),
  plugins: [(await import('@vitejs/plugin-vue')).default()],
  server: {
    host: '127.0.0.1',
    port: 0,
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
  },
})
await server.listen()
const browser = await firefox.launch()
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 760 } })
  const external = []
  page.on('request', r => {
    if (!r.url().startsWith(server.resolvedUrls.local[0]))
      external.push(r.url())
  })
  await page.goto(server.resolvedUrls.local[0])
  await page.waitForFunction(() => !!window.qrFixture)
  assert.equal(
    await page.evaluate(() => typeof window.BarcodeDetector),
    'undefined',
  )
  for (const address of [
    '0x1234567890123456789012345678901234567890',
    'So11111111111111111111111111111111111111112',
    '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    'ecash:qq9h6dyt9t4vczxhafyvt94tsxse4ksxk58hl6fx6j',
  ]) {
    await page.evaluate(value => window.qrFixture.scan(value), address)
    await page.waitForFunction(
      value => document.querySelector('#scanned')?.textContent === value,
      address,
    )
    assert.equal(await page.evaluate(() => window.qrFixture.stopped()), true)
    await page.waitForSelector('.q-dialog', { state: 'detached' })
  }
  assert.deepEqual(external, [])
  console.log(
    'PASS: Firefox real JavaScript QR decode through camera dialog; four existing writer address shapes, native detector disabled, local assets, tracks stopped, mobile viewport.',
  )
} finally {
  await browser.close()
  await server.close()
}
