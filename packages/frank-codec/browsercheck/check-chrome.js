/* eslint-env node */
// Loads dist/browsercheck.html in headless Chrome (a real browser engine) and reads the JSON
// result the page wrote into the DOM. Exit 0 = pass, 1 = fail, 3 = no browser found (NOT verified).
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const candidates = [
  process.env.FRANK_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const chrome = candidates.find(p => fs.existsSync(p))
if (!chrome) {
  console.error(
    'no Chrome/Chromium found (set FRANK_CHROME); real-browser check NOT run',
  )
  process.exit(3)
}
const page = path.resolve(__dirname, '../dist/browsercheck.html')
const userDir = fs.mkdtempSync(
  path.join(require('os').tmpdir(), 'frank-chrome-'),
)
const run = spawnSync(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--allow-file-access-from-files',
    `--user-data-dir=${userDir}`,
    '--virtual-time-budget=20000',
    '--dump-dom',
    'file://' + page,
  ],
  { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 },
)
const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(run.stdout || '')
if (!m) {
  console.error(
    'no result in the page DOM',
    run.status,
    (run.stderr || '').slice(0, 500),
  )
  process.exit(1)
}
const text = m[1]
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
const result = JSON.parse(text)
console.log('chrome check:', JSON.stringify(result))
process.exit(result.ok ? 0 : 1)
