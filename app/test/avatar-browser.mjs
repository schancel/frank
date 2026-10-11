// Real browser image-pipeline regression. No app server, account, relay, or user avatar is used.
// node app/test/avatar-browser.mjs [--source-ref=<git revision>] (the old revision must fail).
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, readdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transform } from 'esbuild'

const reference = process.argv
  .find(value => value.startsWith('--source-ref='))
  ?.split('=')[1]
const source = reference
  ? execFileSync(
      'git',
      ['show', `${reference}:app/src/utils/avatar-resize.ts`],
      { encoding: 'utf8' },
    )
  : await readFile(
      new URL('../src/utils/avatar-resize.ts', import.meta.url),
      'utf8',
    )
const compiled = await transform(source, { loader: 'ts', format: 'cjs' })
const directory = await mkdtemp(join(tmpdir(), 'frank-avatar-browser-'))
const chrome = spawn(
  process.env.AVATAR_CHROME ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-debugging-pipe',
    `--user-data-dir=${directory}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
)
let sequence = 0
let buffer = ''
const pending = new Map()
chrome.stdio[4].on('data', data => {
  buffer += data.toString()
  for (;;) {
    const end = buffer.indexOf('\0')
    if (end < 0) break
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    const promise = pending.get(message.id)
    if (promise) {
      pending.delete(message.id)
      if (message.error) promise.reject(new Error(message.error.message))
      else promise.resolve(message.result)
    }
  }
})
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    chrome.stdio[3].write(
      JSON.stringify({ id, method, params, sessionId }) + '\0',
    )
  })
}
const timeout = setTimeout(() => chrome.kill('SIGTERM'), 30000)
chrome.once('exit', () => {
  for (const promise of pending.values())
    promise.reject(new Error('Avatar test browser exited'))
})
try {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  async function evaluate(expression) {
    const result = await call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      )
    return result.result.value
  }
  await evaluate(
    `(() => { const module = {exports:{}}; ${compiled.code}; globalThis.avatarTools = module.exports; })()`,
  )
  const assets = new URL('../src/assets/avatars/', import.meta.url)
  for (const name of (await readdir(assets)).filter(name =>
    name.endsWith('.png'),
  )) {
    const bytes = await readFile(new URL(name, assets))
    const input = `data:image/png;base64,${bytes.toString('base64')}`
    const result = await evaluate(`(async () => {
      const input = ${JSON.stringify(input)};
      const original = new Image(); original.src = input; await original.decode();
      const bundled = avatarTools.resizeAndCompressImage(original);
      const bundledImage = new Image(); bundledImage.src = bundled; await bundledImage.decode();
      const blob = await (await fetch(input)).blob();
      const uploaded = await avatarTools.compressAvatarFile(new File([blob], 'original.png', {type: 'image/png'}));
      const decoded = new Image(); decoded.src = uploaded; await decoded.decode();
      const retained = await avatarTools.compressAvatarDataUrl(uploaded);
      const small = document.createElement('canvas'); small.width = small.height = 80;
      const oldSmall = small.toDataURL('image/png');
      return {name: ${JSON.stringify(
        name,
      )}, originalWidth: original.naturalWidth,
        width: decoded.naturalWidth, height: decoded.naturalHeight, bytes: uploaded.length,
        bundledWidth: bundledImage.naturalWidth, bundledBytes: bundled.length, retained: retained === uploaded,
        smallUnchanged: await avatarTools.compressAvatarDataUrl(oldSmall) === oldSmall};
    })()`)
    console.log(JSON.stringify(result))
    assert.equal(result.originalWidth, 960)
    assert.equal(
      result.width,
      512,
      'large profile uploads retain 512 pixels of source detail',
    )
    assert.equal(result.height, 512)
    assert.equal(result.bundledWidth, 512)
    assert.ok(result.bytes <= 65536 && result.bundledBytes <= 65536)
    assert.equal(
      result.retained,
      true,
      'saving a valid avatar does not recompress it',
    )
    assert.equal(
      result.smallUnchanged,
      true,
      'stored thumbnails are preserved rather than upscaled',
    )
  }
  console.log(
    'PASS: real bundled selection, original file upload, encoded limit and repeat preservation',
  )
} finally {
  clearTimeout(timeout)
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve))
    chrome.kill('SIGTERM')
    await exited
  }
  console.log(`Blank test browser profile retained: ${directory}`)
}
