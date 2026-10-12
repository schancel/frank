// Real Vue/Quasar history with synthetic read-only operation inputs, in a new blank browser profile.
// node app/test/wallet-history-layout-browser.mjs
// No app server, account, relay, chain or owner browser profile is used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const rowPath = 'app/src/components/wallet/WalletHistory.vue'
const styles = []
const storeInputs = {
  '../utils/notifications':
    'export const addressCopiedNotify = () => {}; export const errorNotify = () => {}',
}
const bundle = await build({
  stdin: {
    contents: `import {createApp, nextTick} from 'vue'; import * as quasar from 'quasar'; import messages from './app/src/i18n/en-us/index.ts'; import Row from './${rowPath}';
    globalThis.mountHistory = async (width, status, open) => {
      globalThis.previousApp?.unmount(); document.body.innerHTML = '<main id="host"></main>';
      const host = document.getElementById('host'); host.style.width = width + 'px';
      const operation = {operationId:'evm-native-v1:0000000000000001',chainIdentifier:'monad-testnet',kind:'legacy',recipient:'0xd4f3463ce84b24d14346e0668ed907e492db965f',intendedValueWei:'1000',payment:status,members:[{transactionHash:'0x'+'a'.repeat(64),state:'included-success',blockNumber:123},{transactionHash:'0x'+'b'.repeat(64),state:'pending'}],observedFeeWei:'2',feeCoverage:'partial',sharing:'not-shared'};
      const app = createApp(Row, {groups:[{id:'transfers',label:'walletHistory.transfers',rows:[{id:'row',kind:'native',operation}]}],inspectionStatus:'available',nativeUnit:'MONT',nativeAmount:value=>value==='1000'?'1.0':'0.002142',networkName:()=> 'Monad Testnet',transactionExplorerLink:hash=>'https://explorer.example/'+hash,formatSwapTime:()=>''});
      app.use(quasar.Quasar, {components: Object.fromEntries(Object.entries(quasar).filter(([name]) => /^Q[A-Z]/.test(name)))});
      app.config.globalProperties.$t = (key, params = {}) => String(key.split('.').reduce((value, part) => value?.[part], messages) ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name]));
      app.mount(host); globalThis.previousApp = app; await nextTick(); document.querySelector('details').open = open; await new Promise(requestAnimationFrame);
    };`,
    resolveDir: root,
    sourcefile: 'wallet-history-layout-entry.ts',
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
        builder.onResolve(
          { filter: /^(src\/|\.\.\/utils\/notifications$)/ },
          args => {
            if (storeInputs[args.path])
              return { path: args.path, namespace: 'store-input' }
            return { path: resolve(root, 'app', args.path) }
          },
        )
        builder.onLoad({ filter: /.*/, namespace: 'store-input' }, args => ({
          contents: storeInputs[args.path],
          loader: 'ts',
          resolveDir: root,
        }))
        builder.onLoad({ filter: /\.vue$/ }, async args => {
          const relative = args.path.slice(root.length + 1)
          const source = await readFile(args.path, 'utf8')
          const descriptor = parse(source).descriptor
          const id =
            relative === rowPath
              ? 'wallet-history-layout'
              : 'history-address-layout'
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
const directory = await mkdtemp(join(tmpdir(), 'frank-history-layout-'))
const chrome = spawn(
  process.env.HISTORY_LAYOUT_CHROME ??
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
  for (const width of [280, 320, 390, 680]) {
    await call(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    for (const status of ['included', 'partial', 'unknown'])
      for (const open of [false, true]) {
        const result = await evaluate(`(async () => {
        await mountHistory(${width}, '${status}', ${open}); await document.fonts.ready; await new Promise(requestAnimationFrame);
        const row=document.querySelector('.wallet-history-row'), details=document.querySelector('details'), amount=document.querySelector('.wallet-history-amount'), badge=document.querySelector('.wallet-history-status');
        const r=e=>{const x=e.getBoundingClientRect();return {left:x.left,right:x.right,top:x.top,bottom:x.bottom,width:x.width,height:x.height}};
        return {width:${width},status:'${status}',open:${open},overflow:document.documentElement.scrollWidth>innerWidth,row:r(row),amount:r(amount),badge:r(badge),links:[...details.querySelectorAll('a')].length,addresses:[...document.querySelectorAll('.wallet-history-address')].map(e=>({rect:r(e),overflow:e.scrollWidth>e.clientWidth,copyGap:e.querySelector('button').getBoundingClientRect().left-e.querySelector('.address-value').getBoundingClientRect().right})),summary:document.querySelector('summary').innerText};
      })()`)
        if (
          process.env.HISTORY_LAYOUT_SCREENSHOTS &&
          width === 390 &&
          status === 'included'
        ) {
          const screenshot = await call(
            'Page.captureScreenshot',
            { format: 'png' },
            sessionId,
          )
          await writeFile(
            `${process.env.HISTORY_LAYOUT_SCREENSHOTS}-${
              open ? 'expanded' : 'collapsed'
            }.png`,
            Buffer.from(screenshot.data, 'base64'),
          )
        }
        assert.equal(result.overflow, false, 'history stays inside viewport')
        assert.ok(
          result.amount.bottom <= result.badge.top ||
            result.amount.right <= result.badge.left ||
            result.badge.bottom <= result.amount.top,
          'amount and status never overlap',
        )
        assert.equal(result.links, 2, 'all backing transactions stay available')
        for (const address of result.addresses) {
          assert.equal(
            address.overflow,
            false,
            'address and copy stay inside row',
          )
          if (address.rect.width)
            assert.ok(
              address.copyGap < 10,
              'copy button stays beside its address',
            )
        }
        if (!open)
          assert.ok(result.row.height < 150, 'collapsed transfer is compact')
        console.log(JSON.stringify(result))
      }
  }
  console.log(
    'PASS: real Vue/Quasar history at 280/320/390/680px, confirmed/partial/unknown, collapsed/expanded',
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
