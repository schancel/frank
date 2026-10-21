// Real Vue/Quasar chat bubbles with the real message footer, in a new blank browser profile.
// BUBBLE_FOOTER_PLAYWRIGHT=/external/prefix/node_modules/playwright node app/test/chat-bubble-footer-browser.mjs [--out=<dir>] [--source-ref=<revision>]
// BUBBLE_FOOTER_CHROME=<chrome binary> uses that browser instead of Playwright's download.
// --source-ref renders the footer component and app.scss from an earlier revision, to show the
// regression; --out keeps one screenshot per viewport. No app server, account, relay or chain.
//
// The footer of a bubble is one row: the time, amount and any status on the left, shortened with
// an ellipsis when too long, and the actions (retry, discard, menu) at the right. The actions never
// drop onto a line of their own while the row has room for them.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import * as sass from 'sass'
import {
  parse,
  compileScript,
  compileTemplate,
  compileStyle,
} from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.BUBBLE_FOOTER_PLAYWRIGHT ||
  'playwright')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argument = name =>
  process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const reference = argument('source-ref')
const out = argument('out')
const fromReference = relative =>
  execFileSync('git', ['show', `${reference}:${relative}`], {
    cwd: root,
    encoding: 'utf8',
  })
const footerFiles = [
  'app/src/components/chat/messages/ChatMessageSuffix.vue',
  'app/src/components/chat/messages/ChatMessageSuffixButtons.vue',
]
const styles = []
const stubs = {
  'src/stores/chats':
    'export const useChatStore = () => ({messages: {}, conversations: {}})',
  'src/stores/chats-self-notes':
    'export const blockingMessage = () => undefined',
  'src/utils/message-items':
    'export const messageItems = {previewText: () => ""}',
}
const bundle = await build({
  stdin: {
    contents: `import {createApp, h, nextTick} from 'vue'; import * as q from 'quasar'; import messages from './app/src/i18n/en-us/index.ts'; import Suffix from './app/src/components/chat/messages/ChatMessageSuffix.vue';
    const bubble = (size, m) => h('div', {class: 'bubble', 'data-case': m.name, style: 'width:100%'}, [h(q.QChatMessage, {sent: m.outbound, size, bgColor: m.outbound ? 'message-sent' : 'message-received', textColor: m.outbound ? 'message-sent-text' : 'message-received-text'}, () => h('div', {class: 'chat-message-body'}, [h('span', {class: 'chat-message-text', innerHTML: '<p>' + m.text + '</p>'}), h(Suffix, {inline: true, stamp: '07:38:55', stampDatetime: '2026-10-21T07:38:55Z', amount: '0.4688 MONT', outbound: m.outbound, status: m.status, waitingForPreviousPayment: !!m.waiting, waitingBlocks: m.blocks ?? -1, failureReason: m.failureReason ?? '', paymentSummary: m.summary ?? ''})]))]);
    globalThis.mountBubbles = async (width, size, cases) => {
      globalThis.previousApp?.unmount();
      document.body.innerHTML = '<main id="host"></main>';
      const host = document.getElementById('host'); host.style.width = width + 'px';
      const app = createApp({render: () => h('div', {class: 'q-pa-md column'}, cases.map(m => bubble(size, m)))});
      app.use(q.Quasar, {components: Object.fromEntries(Object.entries(q).filter(([name]) => /^Q[A-Z]/.test(name)))});
      app.config.globalProperties.$t = (key, params = {}) => String(key.split('.').reduce((value, part) => value?.[part], messages) ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name]));
      app.mount(host); globalThis.previousApp = app; await nextTick(); await document.fonts.ready; await new Promise(requestAnimationFrame);
    };`,
    resolveDir: root,
    sourcefile: 'chat-bubble-footer-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  define: {
    'process.env.NODE_ENV': '"production"',
    '__VUE_OPTIONS_API__': 'true',
    '__VUE_PROD_DEVTOOLS__': 'false',
    '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false',
  },
  plugins: [
    {
      name: 'vue-and-store-inputs',
      setup(builder) {
        builder.onResolve({ filter: /^src\// }, args =>
          stubs[args.path]
            ? { path: args.path, namespace: 'stub' }
            : { path: resolve(root, 'app', args.path) },
        )
        builder.onResolve({ filter: /stores\/chats(-self-notes)?$/ }, args => ({
          path: `src/stores/${args.path.split('/').pop()}`,
          namespace: 'stub',
        }))
        builder.onResolve({ filter: /utils\/message-items$/ }, () => ({
          path: 'src/utils/message-items',
          namespace: 'stub',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: stubs[args.path],
          loader: 'ts',
          resolveDir: root,
        }))
        builder.onLoad({ filter: /\.vue$/ }, async args => {
          const relative = args.path.slice(root.length + 1)
          const source =
            reference && footerFiles.includes(relative)
              ? fromReference(relative)
              : await readFile(args.path, 'utf8')
          const descriptor = parse(source).descriptor
          const id = relative.split('/').pop().replace('.vue', '').toLowerCase()
          const script = compileScript(descriptor, { id })
          const template = compileTemplate({
            source: descriptor.template.content,
            filename: args.path,
            id,
            scoped: true,
            compilerOptions: { bindingMetadata: script.bindings },
          })
          if (template.errors.length) throw new Error(String(template.errors))
          for (const style of descriptor.styles)
            styles.push(
              compileStyle({
                source: style.content,
                filename: args.path,
                id: `data-v-${id}`,
                scoped: style.scoped,
              }).code,
            )
          return {
            contents:
              script.content.replace('export default', 'const component =') +
              '\n' +
              template.code +
              `\ncomponent.render = render; component.__scopeId = 'data-v-${id}'; export default component;`,
            loader: 'ts',
            resolveDir: dirname(args.path),
          }
        })
      },
    },
  ],
})

const cssDirectory = join(root, 'app/src/css')
const appScss = reference
  ? fromReference('app/src/css/app.scss')
  : await readFile(join(cssDirectory, 'app.scss'), 'utf8')
const appCss = sass.compileString(appScss, { loadPaths: [cssDirectory] }).css
const quasarCss = await readFile(
  join(root, 'node_modules/quasar/dist/quasar.prod.css'),
  'utf8',
)
const iconCss = await readFile(
  join(root, 'node_modules/@quasar/extras/material-icons/material-icons.css'),
  'utf8',
)
const font = await readFile(
  join(
    root,
    'node_modules/@quasar/extras/material-icons/web-font/flUhRq6tzZclQEJ-Vdg-IuiaDsNcIhQ8tQ.woff2',
  ),
)
const css = [
  quasarCss,
  iconCss.replace(
    /url\([^)]*\)/g,
    `url(data:font/woff2;base64,${font.toString('base64')})`,
  ),
  appCss,
  ...styles,
  'body{margin:0;font-family:Inter,-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;background:var(--q-chat-background)}',
].join('\n')

const cases = [
  {
    name: 'sent',
    text: 'Test',
    outbound: true,
    status: 'confirmed',
    summary: 'mempool',
  },
  {
    name: 'pending-long',
    text: 'Test',
    outbound: true,
    status: 'pending',
    waiting: true,
  },
  {
    name: 'pending-blocks',
    text: 'Test',
    outbound: true,
    status: 'pending',
    waiting: true,
    blocks: 12,
  },
  {
    name: 'failed',
    text: 'Test',
    outbound: true,
    status: 'error',
    failureReason: 'rejected',
  },
  { name: 'incoming', text: 'Test', outbound: false, status: 'confirmed' },
  {
    name: 'pending-long-text',
    text: 'A longer message whose last line leaves little room beside it for the footer',
    outbound: true,
    status: 'pending',
    waiting: true,
  },
]
// The chat column width and QChatMessage size as ChatMessage.bubbleSize picks them.
const viewports = [
  { name: 'desktop', width: 1280, height: 800, chat: 900, size: '6' },
  { name: 'mobile-390', width: 390, height: 844, chat: 390, size: '9' },
  { name: 'popup-400x600', width: 400, height: 600, chat: 400, size: '9' },
  // Too narrow for time, amount and actions side by side: only here may the actions wrap.
  {
    name: 'too-narrow-200',
    width: 200,
    height: 900,
    chat: 200,
    size: '9',
    tooNarrow: true,
  },
]

// Playwright's own new, empty profile; nothing of the owner's browser is used.
const browser = await chromium.launch({
  executablePath: process.env.BUBBLE_FOOTER_CHROME || undefined,
})
const failures = []
try {
  if (out) await mkdir(out, { recursive: true })
  for (const viewport of viewports) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
    })
    await page.setContent(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body class="body--light"></body></html>',
    )
    await page.addStyleTag({ content: css })
    await page.evaluate(bundle.outputFiles[0].text)
    await page.evaluate(
      ([width, size, list]) => globalThis.mountBubbles(width, size, list),
      [viewport.chat, viewport.size, cases],
    )
    const measured = await page.evaluate(() =>
      [...document.querySelectorAll('.bubble')].map(element => {
        const box = selector => {
          const found = element.querySelector(selector)
          if (!found) return null
          const r = found.getBoundingClientRect()
          return r.width || r.height
            ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
            : null
        }
        const footer = element.querySelector('[data-testid="outgoing-footer"]')
        const actions = footer?.lastElementChild
        const actionRect = actions?.getBoundingClientRect()
        // Status, time and amount: what the footer shows apart from its actions.
        const meta = [...footer.querySelectorAll('[data-testid^="outgoing-"]')]
          .filter(child => !child.closest('button') && child !== footer)
          .map(child => child.getBoundingClientRect())
          .filter(r => r.width > 0)
        return {
          name: element.dataset.case,
          bubble: box('.q-message-text'),
          footer: box('[data-testid="outgoing-footer"]'),
          actions:
            actionRect && actionRect.width
              ? {
                  left: actionRect.left,
                  right: actionRect.right,
                  top: actionRect.top,
                  bottom: actionRect.bottom,
                }
              : null,
          metaTop: Math.min(...meta.map(r => r.top)),
          metaBottom: Math.max(...meta.map(r => r.bottom)),
          metaRight: Math.max(...meta.map(r => r.right)),
        }
      }),
    )
    for (const result of measured) {
      console.log(JSON.stringify({ viewport: viewport.name, ...result }))
      const where = `${viewport.name} ${result.name}`
      if (
        result.footer.right > result.bubble.right + 0.5 ||
        result.footer.left < result.bubble.left - 0.5
      )
        failures.push(`${where}: footer sticks out of the bubble`)
      if (result.metaBottom - result.metaTop > 24)
        failures.push(
          `${where}: time, amount and status span more than one line`,
        )
      if (result.actions) {
        if (!viewport.tooNarrow && result.actions.top >= result.metaBottom - 2)
          failures.push(`${where}: actions dropped below the time and amount`)
        if (
          result.actions.top < result.metaBottom - 2 &&
          result.actions.left < result.metaRight - 0.5
        )
          failures.push(`${where}: actions overlap the time and amount`)
      }
    }
    if (out)
      await page.screenshot({
        path: join(out, `${viewport.name}.png`),
        fullPage: true,
      })
    await page.close()
  }
} finally {
  await browser.close()
}
for (const failure of failures) console.log(`FAIL: ${failure}`)
assert.deepEqual(failures, [], 'every bubble keeps its footer on one row')
console.log(
  'PASS: footer is one row (meta left, actions right) at desktop, 390px and the 400x600 popup',
)
