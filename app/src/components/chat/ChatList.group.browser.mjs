// Real Vue/Quasar/Router toolbar and group page with synthetic store inputs.
// node app/src/components/chat/ChatList.group.browser.mjs [--source-ref=<revision>]
// No app server, account, relay, chain or owner browser profile is used.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const reference = process.argv
  .find(arg => arg.startsWith('--source-ref='))
  ?.slice(13)
const baselinePaths = [
  'app/src/components/chat/ChatList.vue',
  'app/src/components/dialogs/NewGroupDialog.vue',
]
const styles = []
const storeInputs = {
  'src/utils/avu-units': `export const formatAvu=()=>''`,
  'src/stores/settings': `export const useSettingsStore=()=>({})`,
  'src/stores/chats': `import {reactive} from 'vue'; const store=reactive({getSortedChatOrder:[], getGroupHomeRelay:()=> 'https://relay.example', setActiveConversation:id=>globalThis.selected=id, createGroupConversation:async args=>{globalThis.created=args;return {id:'created-group'}}}); export const useChatStore=()=>store`,
  'pinia': `import {toRefs} from 'vue'; export const storeToRefs=toRefs`,
  'src/stores/contacts': `export const useContactStore=()=>({contacts:{'0x1111111111111111111111111111111111111111':{profile:{name:'Alice'}}},isContact:()=>false,getContact:()=>undefined,refreshPeerProfiles:()=>{}})`,
  'src/accounts/session': `export const accountSession={state:{status:'ready',revision:1}}`,
  'src/utils/messaging-state': `export const messagingState={status:'ready'}`,
  '@frank/wallet/chain': `export const activeChain={capabilities:{directMessages:true},chainIdentifier:'monad-testnet',unit:'MONT'}`,
  'src/utils/stamp-display': `export const nativeAmountAvu=()=>undefined`,
  'src/utils/message-receipts': `export const verifiedReceiptsReader=()=>()=>[]`,
  'src/utils/notifications': `export const errorNotify=()=>{}`,
  'src/utils/chain-address': `export const isChainAddress=a=>/^0x[0-9a-f]{40}$/i.test(a);export const toChainDisplayAddress=a=>a.toLowerCase()`,
  'src/utils/own-address': `export const sameCanonicalAddress=(a,b)=>a.toLowerCase()===b.toLowerCase()`,
}
const bundle = await build({
  stdin: {
    contents: `import {createApp,h,nextTick} from 'vue'; import {createRouter,createMemoryHistory,RouterView} from 'vue-router'; import * as q from 'quasar'; import messages from './app/src/i18n/en-us/index.ts'; import ChatList from './app/src/components/chat/ChatList.vue'; import NewGroup from './app/src/pages/NewGroup.vue';
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/chat',component:ChatList},{path:'/new-group',component:NewGroup},{path:'/chat/:address',component:{template:'<div>Group conversation</div>'}}]});
    const app=createApp({render:()=>h(q.QLayout,()=>h(RouterView,{style:"height:100vh;flex:none"}))}); app.use(router);app.use(q.Quasar,{components:Object.fromEntries(Object.entries(q).filter(([name])=>/^Q[A-Z]/.test(name)))});app.config.globalProperties.$status={setup:true};app.config.globalProperties.$t=(key,params={})=>Object.entries(params).reduce((text,[name,value])=>text.replaceAll('{'+name+'}',String(value)),String(key.split('.').reduce((value,part)=>value?.[part],messages)??key));globalThis.router=router;globalThis.ready=(async()=>{await router.push('/chat');await router.isReady();document.body.innerHTML='<main id="host"></main>';app.mount('#host');await nextTick()})();`,
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
        builder.onResolve({ filter: /.*/ }, args => {
          let key = args.path
          if (args.path.startsWith('.')) {
            const abs = resolve(args.resolveDir, args.path)
            if (reference && baselinePaths.includes(abs.slice(root.length + 1)))
              return { path: abs }
            if (abs.startsWith(join(root, 'app/src/')))
              key =
                'src/' +
                abs
                  .slice(join(root, 'app/src/').length)
                  .replace(/\.(ts|vue)$/, '')
          }
          if (storeInputs[key]) return { path: key, namespace: 'store-input' }
          if (args.path.startsWith('src/'))
            return { path: resolve(root, 'app', args.path + '.ts') }
        })
        builder.onLoad({ filter: /.*/, namespace: 'store-input' }, args => ({
          contents: storeInputs[args.path],
          loader: 'ts',
          resolveDir: root,
        }))
        builder.onLoad({ filter: /ChatListItem\.vue$/ }, () => ({
          contents: 'export default {render: () => null}',
          loader: 'js',
        }))
        builder.onLoad({ filter: /\.vue$/ }, async args => {
          const relative = args.path.slice(root.length + 1)
          const source =
            reference && baselinePaths.includes(relative)
              ? execFileSync('git', ['show', `${reference}:${relative}`], {
                  cwd: root,
                  encoding: 'utf8',
                })
              : await readFile(args.path, 'utf8')
          const descriptor = parse(source).descriptor
          const id = relative.replace(/[^a-zA-Z0-9]/g, '-')
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
  await evaluate('ready')
  for (const width of [320, 390, 590, 1280]) {
    await call(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 800, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await evaluate(`router.replace('/chat')`)
    await evaluate('new Promise(resolve=>setTimeout(resolve,150))')
    const result = await evaluate(
      `(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {width:${width},search:rect('.chat-search-box'),actions:[...document.querySelectorAll('.chat-toolbar-action')].map(e=>({width:e.offsetWidth,height:e.offsetHeight})),bar:rect('[data-testid="chat-list-toolbar"]'),filters:rect('[data-test="screener-filter-bar"]'),overflow:document.documentElement.scrollWidth>innerWidth}})()`,
    )
    console.log(JSON.stringify(result))
    if (!reference) {
      assert.equal(result.overflow, false)
      assert.ok(result.search.width >= 150)
      assert.ok(result.actions.every(a => a.width === 44 && a.height === 44))
      assert.ok(result.filters.top - result.bar.bottom >= 8)
    }
    await evaluate(
      `document.querySelector('[data-testid="screener-filter-chip"]').click()`,
    )
    assert.equal(
      await evaluate(
        `!!document.querySelector('[data-test="screener-empty"]')`,
      ),
      true,
    )
    await evaluate(
      `document.querySelector('[data-test="all-chats-filter-chip"]').click()`,
    )
    const shot = await call(
      'Page.captureScreenshot',
      { format: 'png' },
      sessionId,
    )
    await writeFile(
      join(directory, `toolbar-${width}.png`),
      Buffer.from(shot.data, 'base64'),
    )
    await evaluate(
      `document.querySelector('[data-testid="new-group-btn"]').click()`,
    )
    await evaluate('new Promise(resolve=>setTimeout(resolve,150))')
    if (reference) {
      await evaluate('new Promise(resolve=>setTimeout(resolve,300))')
      console.log(
        'BASELINE group click:',
        await evaluate(
          `({route:router.currentRoute.value.path,modal:!!document.querySelector('[role="dialog"]'),form:!!document.querySelector('[data-test="new-group-dialog"]')})`,
        ),
      )
    }
    assert.equal(await evaluate(`router.currentRoute.value.path`), '/new-group')
    assert.equal(
      await evaluate(
        `!!document.querySelector('[data-test="new-group-form"]') && !document.querySelector('[role="dialog"]')`,
      ),
      true,
    )
    assert.equal(
      await evaluate(`document.documentElement.scrollWidth>innerWidth`),
      false,
    )
    const formshot = await call(
      'Page.captureScreenshot',
      { format: 'png' },
      sessionId,
    )
    await writeFile(
      join(directory, `group-${width}.png`),
      Buffer.from(formshot.data, 'base64'),
    )
    await evaluate(
      `document.querySelector('[data-test="cancel-create-group"]').click()`,
    )
    await evaluate('new Promise(resolve=>setTimeout(resolve,150))')
    assert.equal(await evaluate(`router.currentRoute.value.path`), '/chat')
    assert.equal(await evaluate(`globalThis.created`), undefined)
  }
  await evaluate(
    `router.push('/new-group?member=0x1111111111111111111111111111111111111111')`,
  )
  await evaluate('new Promise(resolve=>setTimeout(resolve,150))')
  assert.equal(
    await evaluate(
      `!!document.querySelector('[data-test="selected-group-members"]')`,
    ),
    true,
  )
  await evaluate(
    `(()=>{const input=document.querySelector('[data-test="group-name-input"]');input.value='Browser team';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  )
  await evaluate('new Promise(resolve=>setTimeout(resolve,150))')
  await evaluate(
    `document.querySelector('[data-test="create-group-submit"]').click()`,
  )
  await evaluate('new Promise(resolve=>setTimeout(resolve,150))')
  assert.equal(
    await evaluate('router.currentRoute.value.path'),
    '/chat/created-group',
  )
  assert.equal(await evaluate('selected'), 'created-group')
  assert.deepEqual(await evaluate('created.memberAddresses'), [
    '0x1111111111111111111111111111111111111111',
  ])
  console.log(
    'PASS real Quasar + Router toolbar/form, Screener, cancel and synthetic public-store creation; screenshots: ' +
      directory,
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
