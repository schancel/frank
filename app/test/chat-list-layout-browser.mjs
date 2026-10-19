// Real Vue/Quasar layout with synthetic store inputs, in a new blank browser profile.
// node app/test/chat-list-layout-browser.mjs [--source-ref=<revision>]
// No app server, account, relay, chain or owner browser profile is used.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  parse,
  compileScript,
  compileTemplate,
  compileStyle,
} from '@vue/compiler-sfc'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const reference = process.argv
  .find(arg => arg.startsWith('--source-ref='))
  ?.slice(13)
const rowPath = 'app/src/components/chat/ChatListItem.vue'
const styles = []
const storeInputs = {
  'src/utils/chat-deletion-navigation':
    'export const useChatDeletionNavigation = () => async () => {}',
  'src/stores/chats':
    'export const useChatStore = () => ({getLatestMessage: () => ({text: "A message preview that stays inside the conversation row", outbound: false})})',
  'src/stores/contacts':
    'export const useContactStore = () => ({getContactProfile: () => globalThis.profile, isCurated: () => globalThis.profile.curated ?? false})',
  'src/stores/my-profile':
    'export const useProfileStore = () => ({profile: {}})',
  'src/utils/avatar':
    'export const profileAvatar = () => "data:image/svg+xml," + encodeURIComponent(\'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="gray"/></svg>\')',
  'src/utils/own-address':
    'import {ref} from "vue"; export const useReactiveOwnCanonicalAddress = () => ref(null); export const sameCanonicalAddress = (a,b) => !!a && a === b',
  'src/utils/chain-address':
    'export const isChainAddress = address => address.startsWith("0x"); export const toChainDisplayAddress = value => value',
  'src/utils/routes':
    'export const openChat = () => {}; export const openContactProfile = () => {}',
  'src/utils/notifications': 'export const addressCopiedNotify = () => {}',
  'src/utils/chat-attribution':
    'export const conversationSenders = () => new Map(); export const isGroupConversation = () => false; export const senderOf = () => undefined',
  'src/utils/curated-bots':
    'export const inferCuratedBotAttributes = () => ({})',
}
const bundle = await build({
  stdin: {
    contents: `import {createApp, nextTick} from 'vue'; import * as quasar from 'quasar'; import messages from './app/src/i18n/en-us/index.ts'; import Row from './${rowPath}';
    globalThis.mountRow = async (width, profile, unread, value) => {
      globalThis.profile = profile;
      globalThis.previousApp?.unmount();
      document.body.innerHTML = '<main id="host"></main>';
      const host = document.getElementById('host'); host.style.width = width + 'px';
      const app = createApp(Row, {compact: false, chatAddress: '0x1111111111111111111111111111111111111111', numUnread: unread, valueUnread: value, timestamp: 1717171717000});
      app.use(quasar.Quasar, {components: Object.fromEntries(Object.entries(quasar).filter(([name]) => /^Q[A-Z]/.test(name)))});
      app.config.globalProperties.$status = {setup: true}; app.config.globalProperties.$route = {params: {}};
      app.config.globalProperties.$t = (key, params = {}) => String(key.split('.').reduce((value, part) => value?.[part], messages) ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
      app.mount(host); globalThis.previousApp = app; await nextTick(); await new Promise(requestAnimationFrame);
    };`,
    resolveDir: root,
    sourcefile: 'chat-list-layout-entry.ts',
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
      name: 'production-vue-and-store-inputs',
      setup(builder) {
        builder.onResolve({ filter: /^src\// }, args => {
          if (storeInputs[args.path])
            return { path: args.path, namespace: 'store-input' }
          return { path: resolve(root, 'app', args.path) }
        })
        builder.onLoad({ filter: /.*/, namespace: 'store-input' }, args => ({
          contents: storeInputs[args.path],
          loader: 'ts',
          resolveDir: root,
        }))
        builder.onLoad({ filter: /DeleteChatDialog\.vue$/ }, () => ({
          contents: 'export default {render: () => null}',
          loader: 'js',
        }))
        builder.onLoad({ filter: /\.vue$/ }, async args => {
          const relative = args.path.slice(root.length + 1)
          const source =
            reference && relative === rowPath
              ? execFileSync('git', ['show', `${reference}:${relative}`], {
                  cwd: root,
                  encoding: 'utf8',
                })
              : await readFile(args.path, 'utf8')
          const descriptor = parse(source).descriptor
          const id =
            relative === rowPath ? 'chat-row-layout' : 'chat-badge-layout'
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
const css = await readFile(
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
const directory = await mkdtemp(join(tmpdir(), 'frank-chat-list-layout-'))
const chrome = spawn(
  process.env.CHAT_LAYOUT_CHROME ??
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
let sequence = 0,
  buffer = ''
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
    promise.reject(new Error('Layout browser exited'))
})
try {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  const evaluate = async expression => {
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
    `document.head.innerHTML = '<style></style>'; document.head.firstChild.textContent = ${JSON.stringify(
      css +
        '\n' +
        iconCss.replace(
          /url\([^)]*\)/g,
          `url(data:font/woff2;base64,${font.toString('base64')})`,
        ) +
        '\n' +
        styles.join('\n') +
        '\nbody{margin:0;font-family:Inter,-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif}',
    )} `,
  )
  await evaluate(bundle.outputFiles[0].text)
  for (const viewport of [390, 1280]) {
    await call(
      'Emulation.setDeviceMetricsOverride',
      { width: viewport, height: 800, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    for (const width of [200, 240, 280, 360])
      for (const profile of [
        { accountType: 3 },
        { accountType: 2, botRole: 5, curated: true },
        { accountType: 1, botRole: 6 },
        { accountType: 0 },
      ])
        for (const unread of [12345, 0]) {
          const result = await evaluate(`(async () => {
        await mountRow(${width}, {name: 'A very long contact display name that must remain readable', ...${JSON.stringify(
            profile,
          )}}, ${unread}, ${unread ? "'123,456.789 AVU'" : "''"});
        await document.fonts.ready;
        const rect = selector => {const element=document.querySelector(selector); if(!element) return null; const r=element.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
        const row=document.querySelector('.chat-list-row'), name=document.querySelector('.chat-list-name');
        return {viewport:${viewport},width:${width},profile:${JSON.stringify(
            profile,
          )},unread:${unread}, row:rect('.chat-list-row'),name:rect('.chat-list-name'),badge:rect('.account-badge'),metadata:rect('.chat-list-metadata'), value:rect('[data-testid="chat-unread-value"]'), overflow:row.scrollWidth>row.clientWidth, fullName:name.title, nameStyle:{overflow:getComputedStyle(name).overflow,textOverflow:getComputedStyle(name).textOverflow}, compactAvatar:rect('.q-avatar')};
      })()`)
          console.log(JSON.stringify(result))
          assert.ok(
            result.name.width >= 60,
            'name retains readable width with count and amount',
          )
          assert.equal(
            result.overflow,
            false,
            'row does not overflow horizontally',
          )
          assert.ok(result.metadata.width <= 72.5, 'unread column is bounded')
          if (result.metadata.width)
            assert.ok(
              result.name.right <= result.metadata.left + 0.5,
              'name never overlaps unread column',
            )
          if (result.badge) {
            assert.ok(
              result.badge.top >= result.name.bottom - 0.5,
              'badge never overlaps the name line',
            )
            assert.ok(
              result.badge.right <=
                (result.metadata.width
                  ? result.metadata.left
                  : result.row.right) +
                  0.5,
              'badge stays out of unread column',
            )
          }
          if (result.value)
            assert.ok(
              result.value.right <= result.row.right + 0.5,
              'full unread value stays inside row',
            )
          assert.equal(result.nameStyle.textOverflow, 'ellipsis')
          assert.ok(
            result.fullName.startsWith('A very long'),
            'full name remains available on hover',
          )
        }
  }
  console.log(
    'PASS: real Vue/Quasar rows at 200/240/280/360px in mobile and desktop viewports',
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
