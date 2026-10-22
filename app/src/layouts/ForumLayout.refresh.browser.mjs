// node app/src/layouts/ForumLayout.refresh.browser.mjs [--source-ref=<revision>]
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const reference = process.argv
  .find(arg => arg.startsWith('--source-ref='))
  ?.slice(13)
const baselinePaths = ['app/src/layouts/ForumLayout.vue']
const styles = []
// Synthetic read-only store input; real ForumLayout, Quasar scroll area and touch directive.
const storeInputs = {
  'src/stores/forum':
    "import {reactive} from 'vue'; export const store=reactive({topics:[],selectedTopic:'a-very-long-topic-that-must-yield-to-actions',isRefreshing:false, async refreshMessages(){globalThis.refreshes=(globalThis.refreshes??0)+1;store.isRefreshing=true;try{await new Promise(r=>setTimeout(r,150));if(globalThis.failRefresh)throw Error('fixture outage')}finally{store.isRefreshing=false}},setSelectedTopic(value){store.selectedTopic=value}});export const useForumStore=()=>store",
  'pinia': "import {toRefs} from 'vue'; export const storeToRefs=toRefs",
  'src/stores/topics':
    'export const useTopicStore=()=>({refreshDiscoveredTopics:async()=>{}})',
  'src/composables/useActiveWallet':
    'export const useActiveWallet=async()=>undefined',
}
const bundle = await build({
  stdin: {
    contents: `import {createApp,h,nextTick,ref} from 'vue';import {createRouter,createMemoryHistory,RouterView} from 'vue-router';import * as q from 'quasar';import ForumLayout from './app/src/layouts/ForumLayout.vue';
    const tall=ref(false),media=ref(false);globalThis.setTall=value=>tall.value=value;globalThis.setMedia=value=>media.value=value;globalThis.linkClicks=0;
    const Content={render:()=>h('div',{style:{height:tall.value?'1800px':'40px'},'data-test':'feed'},media.value?[h('img',{'data-test':'feed-image',src:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%2280%22%3E%3C/svg%3E',alt:'Forum media',style:{display:'block',width:'100%',height:'80px'}}),h('a',{'data-test':'feed-link',href:'https://example.invalid/read',draggable:'true',style:{display:'block',height:'80px'},onClick:e=>{e.preventDefault();globalThis.linkClicks++}},'Linked Forum content')]: 'Read-only Forum content')};
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:ForumLayout,children:[{path:'forum',component:Content},{path:'new-post',component:Content}]}]});
    const app=createApp({render:()=>h(q.QLayout,()=>h(RouterView))});app.use(router);app.use(q.Quasar,{components:Object.fromEntries(Object.entries(q).filter(([name])=>/^Q[A-Z]/.test(name)))});app.config.globalProperties.$t=key=>key;globalThis.router=router;globalThis.ready=(async()=>{await router.push('/forum');await router.isReady();document.body.innerHTML='<main id="host"></main>';app.mount('#host');await nextTick()})();`,
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
        builder.onLoad(
          { filter: /(?:ForumDrawer|ExtensionPopoutBtn)\.vue$/ },
          args => ({
            contents: args.path.endsWith('ExtensionPopoutBtn.vue')
              ? "import {h} from 'vue';import {QBtn} from 'quasar';export default {render:()=>h(QBtn,{icon:'open_in_new',flat:true,round:true,dense:true,'aria-label':'Pop Out Window'})}"
              : 'export default {render: () => null}',
            loader: 'js',
          }),
        )
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
const directory = await mkdtemp(join(tmpdir(), 'frank-forum-refresh-'))
const chrome = spawn(
  process.env.FORUM_REFRESH_CHROME ??
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
const timeout = setTimeout(() => chrome.kill('SIGTERM'), 60000)
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
  await call('Emulation.setTouchEmulationEnabled', { enabled: true }, sessionId)
  await evaluate(bundle.outputFiles[0].text)
  await evaluate('ready')
  const pause = ms =>
    evaluate(`new Promise(resolve=>setTimeout(resolve,${ms}))`)
  const gesture = async selector => {
    const point = await evaluate(
      "(()=>{const r=document.querySelector('.q-scrollarea__container').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(160,r.height/2)}})()",
    )
    await call(
      'Input.dispatchTouchEvent',
      { type: 'touchStart', touchPoints: [point] },
      sessionId,
    )
    for (let dy = 10; dy <= 110; dy += 10) {
      await call(
        'Input.dispatchTouchEvent',
        { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + dy }] },
        sessionId,
      )
      await pause(17)
    }
    await call(
      'Input.dispatchTouchEvent',
      { type: 'touchEnd', touchPoints: [] },
      sessionId,
    )
    await pause(650)
  }
  for (const width of [320, 390, 590, 1280]) {
    await call(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 800, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await pause(350)
    const geometry = await evaluate(
      "(()=>{const e=document.querySelector('[aria-label=\"a11y.forumRefresh\"]');const r=e?.getBoundingClientRect();const pull=document.querySelector('[data-test=\"forum-pull-to-refresh\"]').getBoundingClientRect();const scroll=document.querySelector('.q-scrollarea__container').getBoundingClientRect();return {button:r&&{left:r.left,right:r.right,width:r.width,height:r.height},pullHeight:pull.height,scrollHeight:scroll.height,overflow:document.documentElement.scrollWidth>innerWidth}})()",
    )
    console.log(JSON.stringify({ width, ...geometry }))
    const shot = await call(
      'Page.captureScreenshot',
      { format: 'png' },
      sessionId,
    )
    await writeFile(
      join(directory, `forum-${width}.png`),
      Buffer.from(shot.data, 'base64'),
    )
    assert.ok(geometry.button, 'refresh remains present at every width')
    assert.ok(
      geometry.button.left >= 0 && geometry.button.right <= width,
      'refresh stays on screen',
    )
    assert.equal(geometry.overflow, false, 'no horizontal overflow')
    assert.ok(
      geometry.pullHeight >= geometry.scrollHeight - 1,
      'short feed whitespace accepts pull',
    )
    const before = await evaluate('refreshes')
    await gesture()
    assert.equal(
      await evaluate('refreshes'),
      before + 1,
      'one physical pull produces one read refresh',
    )
    assert.equal(
      await evaluate("!!document.querySelector('.q-spinner')"),
      false,
      'spinner completes',
    )
    await evaluate(
      'document.querySelector(\'[aria-label="a11y.forumRefresh"]\').click()',
    )
    await pause(250)
    assert.equal(
      await evaluate('refreshes'),
      before + 2,
      'manual refresh works at every width',
    )
    await evaluate("router.push('/new-post')")
    await pause(150)
    assert.equal(
      await evaluate('document.documentElement.scrollWidth>innerWidth'),
      false,
      'back + refresh + compose + popout + settings fit',
    )
    const actions = await evaluate(
      "Array.from(document.querySelectorAll('header button')).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}})",
    )
    assert.ok(
      actions.every(r => r.left >= 0 && r.right <= width && r.width > 0),
      'every action remains in view',
    )
    await evaluate("router.push('/forum')")
    await pause(150)
  }
  await evaluate('setMedia(true)')
  await pause(350)
  for (const selector of [
    '[data-test="feed-image"]',
    '[data-test="feed-link"]',
  ]) {
    const originalAttribute = await evaluate(
      `document.querySelector(${JSON.stringify(
        selector,
      )}).getAttribute('draggable')`,
    )
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).draggable`,
      ),
      true,
      'native media/link starts draggable',
    )
    const beforeMedia = await evaluate('refreshes')
    await gesture(selector)
    assert.equal(
      await evaluate('refreshes'),
      beforeMedia + 1,
      'physical pull on image/link refreshes',
    )
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(
          selector,
        )}).getAttribute('draggable')`,
      ),
      originalAttribute,
      'touch restores exact original drag attribute',
    )
  }
  await evaluate(`document.querySelector('[data-test="feed-link"]').click()`)
  assert.equal(
    await evaluate('linkClicks'),
    1,
    'normal link click still reaches its handler',
  )
  await evaluate('setMedia(false)')
  await evaluate('failRefresh=true')
  const beforeFailure = await evaluate('refreshes')
  await gesture()
  assert.equal(await evaluate('refreshes'), beforeFailure + 1)
  assert.equal(
    await evaluate("!!document.querySelector('.q-spinner')"),
    false,
    'failed refresh releases spinner',
  )
  await evaluate('failRefresh=false;setTall(true)')
  await pause(350)
  await evaluate(
    "document.querySelector('.q-scrollarea__container').scrollTop=350",
  )
  await pause(350)
  const beforeScrolled = await evaluate('refreshes')
  await gesture()
  assert.equal(
    await evaluate('refreshes'),
    beforeScrolled,
    'pull while scrolled never refreshes',
  )
  await evaluate(
    "document.querySelector('.q-scrollarea__container').scrollTop=0",
  )
  await pause(350)
  await gesture()
  assert.equal(
    await evaluate('refreshes'),
    beforeScrolled + 1,
    'long feed refreshes again at top',
  )
  const beforeMouse = await evaluate('refreshes')
  // Touch refresh is available on a wide tablet, but desktop mouse drag cannot steal selection.
  await call(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 },
    sessionId,
  )
  await call(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: 200, y: 340, button: 'left', buttons: 1 },
    sessionId,
  )
  await call(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: 200, y: 340, button: 'left', clickCount: 1 },
    sessionId,
  )
  await pause(650)
  assert.equal(
    await evaluate('refreshes'),
    beforeMouse,
    'mouse drag never triggers refresh',
  )
  await evaluate("router.push('/new-post')")
  await pause(350)
  await gesture()
  assert.equal(
    await evaluate('router.currentRoute.value.path'),
    '/new-post',
    'gesture does not navigate or submit post',
  )
  console.log('Browser screenshots:', directory)
  console.log(
    'PASS: narrow and wide manual refresh; physical touch on short feed; failure completion; scroll guard; mouse selection; route preservation',
  )
} finally {
  clearTimeout(timeout)
  chrome.kill('SIGTERM')
  await new Promise(resolve => chrome.once('exit', resolve))
}
