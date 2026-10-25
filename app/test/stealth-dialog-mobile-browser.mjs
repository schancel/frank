// The stealth payment sheet on a 390 px phone, with and without the on-screen keyboard, in a new
// blank browser profile. No app server, account, relay or chain.
// STEALTH_SHEET_PLAYWRIGHT=/external/prefix/node_modules/playwright yarn --cwd app test:stealth-sheet,
// or node app/test/stealth-dialog-mobile-browser.mjs [--out=<dir>] [--source-ref=<revision>]
// STEALTH_SHEET_CHROME=<chrome binary> uses that browser instead of Playwright's download.
// --source-ref renders the sheet, the chat column and app.scss from an earlier revision, to show
// the regression; --out keeps one screenshot per case.
//
// The real SendStealthDialog.vue sits in the real chat column structure (Quasar layout, header,
// page, footer) with the real scoped styles of MainLayout.vue, ChatLayout.vue and Chat.vue and
// the real app.scss. The keyboard is opened the way utils/mobile-viewport-scale.ts reports it on
// iOS: the layout keeps its height, and the app clamps itself to the visual viewport above the
// keyboard (`--frank-vh`, `html.frank-keyboard-open`). With the amount focused, the amount field
// and the Send button must both be on screen above the keyboard, not clipped or covered.
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
const { chromium } = require(process.env.STEALTH_SHEET_PLAYWRIGHT ||
  'playwright')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argument = name =>
  process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const reference = argument('source-ref')
const out = argument('out')
const source = async relative =>
  reference
    ? execFileSync('git', ['show', `${reference}:${relative}`], {
        cwd: root,
        encoding: 'utf8',
      })
    : readFile(join(root, relative), 'utf8')

const styles = []
async function scopedStyles(relative, id, prefix = '') {
  const descriptor = parse(await source(relative)).descriptor
  for (const style of descriptor.styles) {
    const compiled = compileStyle({
      source: prefix + style.content,
      filename: relative,
      id: `data-v-${id}`,
      scoped: style.scoped,
      preprocessLang: style.lang,
    })
    if (compiled.errors.length) throw new Error(String(compiled.errors))
    styles.push(compiled.code)
  }
}
await scopedStyles('app/src/layouts/MainLayout.vue', 'mainlayout')
await scopedStyles(
  'app/src/layouts/ChatLayout.vue',
  'chatlayout',
  '$primary: #c0442a; $separator-color: rgba(0, 0, 0, 0.12);\n',
)
await scopedStyles('app/src/pages/Chat.vue', 'chat')

// The three levels of the real tree, each under its own component's scope id.
const shells = {
  mainlayout: `<q-layout view="lHr lpr lFr"><slot /></q-layout>`,
  chatlayout: `<div class="chat-layout-root column full-height overflow-hidden">
    <q-header><q-toolbar class="q-pl-sm"><q-btn flat round dense icon="arrow_back" />
      <q-toolbar-title class="h6 ellipsis">Damian</q-toolbar-title></q-toolbar></q-header>
    <slot /></div>`,
  chat: `<div class="chat-container column full-height overflow-hidden">
    <q-page-container class="col full-height overflow-hidden">
      <q-page class="chat-page-background column no-wrap">
        <div class="col relative-position" style="overflow:auto">
          <div v-for="n in 12" :key="n" class="q-pa-sm"><div class="q-pa-md bg-grey-3" style="border-radius:18px">Message {{ n }}</div></div>
        </div>
      </q-page>
    </q-page-container>
    <q-footer bordered :height-hint="64" class="chat-footer chat-input-bar">
      <div class="chat-inline-sheet q-pa-sm" data-testid="chat-inline-sheet"><slot /></div>
      <div class="chat-input-toolbar row no-wrap items-center" data-testid="composer">
        <input class="col" placeholder="Write a message..." style="font-size:16px" />
      </div>
    </q-footer></div>`,
}
const entry = `import {createApp, h, nextTick, defineComponent} from 'vue'; import * as q from 'quasar';
  import messages from './app/src/i18n/en-us/index.ts';
  import Dialog from './app/src/components/dialogs/SendStealthDialog.vue';
  ${Object.keys(shells)
    .map(id => `import ${id} from 'shell:${id}';`)
    .join('\n')}
  const usdc = {key: 'monad-testnet:erc20:0x534b2f3a21130d7a60830c2df862319e593943a3', chainIdentifier: 'monad-testnet', asset: {kind: 'erc20', contractAddress: '0x534b2f3a21130d7a60830c2df862319e593943a3'}, label: 'Monad Testnet · USDC', unit: 'USDC', decimals: 6, nativeUnit: 'MONT', nativeDecimals: 18};
  globalThis.mountSheet = async () => {
    document.body.innerHTML = '<div id="q-app"></div>';
    const app = createApp({render: () => h(mainlayout, null, () => h(chatlayout, null, () => h(chat, null, () => h(Dialog, {address: '0xdamian', contact: {name: 'Damian'}, options: [usdc], loadAvailable: async () => 25000000n}))))});
    app.use(q.Quasar, {components: Object.fromEntries(Object.entries(q).filter(([name]) => /^Q[A-Z]/.test(name)))});
    app.config.globalProperties.$t = (key, params = {}) => String(key.split('.').reduce((value, part) => value?.[part], messages) ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name]));
    app.mount('#q-app'); await nextTick(); await new Promise(r => setTimeout(r, 50)); await new Promise(requestAnimationFrame);
  };`
const stubs = {
  '@frank/wallet/chain':
    "export const activeChain = { chainIdentifier: 'monad-testnet' }",
  'useBalance':
    "import {ref} from 'vue'; export const useBalance = () => ({ balance: ref(null), loaded: ref(false), hasError: ref(false) })",
}
const bundle = await build({
  stdin: {
    contents: entry,
    resolveDir: root,
    sourcefile: 'stealth-sheet-entry.ts',
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
      name: 'sheet-inputs',
      setup(builder) {
        builder.onResolve({ filter: /^@frank\/wallet\/chain$/ }, () => ({
          path: '@frank/wallet/chain',
          namespace: 'stub',
        }))
        builder.onResolve({ filter: /composables\/useBalance$/ }, () => ({
          path: 'useBalance',
          namespace: 'stub',
        }))
        builder.onResolve({ filter: /^shell:/ }, args => ({
          path: args.path.slice('shell:'.length),
          namespace: 'shell',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: stubs[args.path],
          loader: 'ts',
          resolveDir: root,
        }))
        builder.onLoad({ filter: /.*/, namespace: 'shell' }, args => {
          const id = args.path
          const template = compileTemplate({
            source: shells[id],
            filename: `${id}.vue`,
            id,
            scoped: true,
          })
          if (template.errors.length) throw new Error(String(template.errors))
          return {
            contents: `${template.code}\nexport default { render, __scopeId: 'data-v-${id}' }`,
            loader: 'js',
            resolveDir: root,
          }
        })
        builder.onLoad({ filter: /\.vue$/ }, async args => {
          const relative = args.path.slice(root.length + 1)
          const descriptor = parse(await source(relative)).descriptor
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
                preprocessLang: style.lang,
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
const appCss = sass.compileString(await source('app/src/css/app.scss'), {
  loadPaths: [cssDirectory],
}).css
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
  'body{margin:0;font-family:-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif}',
].join('\n')

// iPhone 13/14 (390 x 844). The numeric keypad with its accessory bar covers about 380 px.
const phone = { width: 390, height: 844, keyboard: 380 }
const browser = await chromium.launch({
  executablePath: process.env.STEALTH_SHEET_CHROME || undefined,
})
const failures = []
try {
  if (out) await mkdir(out, { recursive: true })
  for (const keyboard of [false, true]) {
    const name = keyboard ? 'mobile-390-keyboard' : 'mobile-390'
    const page = await browser.newPage({
      viewport: { width: phone.width, height: phone.height },
      hasTouch: true,
      isMobile: true,
    })
    await page.setContent(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body class="body--light"></body></html>',
    )
    await page.addStyleTag({ content: css })
    await page.evaluate(bundle.outputFiles[0].text)
    await page.evaluate(() => globalThis.mountSheet())
    await page.evaluate(() => document.fonts.ready)
    const visibleHeight = keyboard
      ? phone.height - phone.keyboard
      : phone.height
    const amount = page.locator(
      'input[data-testid="stealth-amount-input"], [data-testid="stealth-amount-input"] input',
    )
    if (keyboard) {
      await amount.focus()
      // What utils/mobile-viewport-scale.ts sets when the iOS keyboard shrinks the visual
      // viewport, then the visualViewport resize the dialog listens to.
      await page.evaluate(
        ([vh, kb]) => {
          const html = document.documentElement
          html.style.setProperty('--frank-vh', `${vh}px`)
          html.style.setProperty('--frank-kb-offset', `${kb}px`)
          html.classList.add('frank-keyboard-open')
          // The phone's own reveal of the focused field, which also scrolls clipping boxes.
          document.activeElement?.scrollIntoView?.({ block: 'nearest' })
          window.visualViewport?.dispatchEvent(new Event('resize'))
        },
        [visibleHeight, phone.keyboard],
      )
      await page.waitForTimeout(100)
    }
    const seen = await page.evaluate(visible => {
      const shown = selector => {
        const element = document.querySelector(selector)
        if (!element) return { present: false }
        const r = element.getBoundingClientRect()
        const x = r.left + r.width / 2,
          y = r.top + r.height / 2
        const top =
          y >= 0 && y < visible ? document.elementFromPoint(x, y) : null
        return {
          present: true,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          right: Math.round(r.right),
          onScreen:
            r.top >= 0 &&
            r.bottom <= visible + 0.5 &&
            r.left >= 0 &&
            r.right <= innerWidth + 0.5,
          reachable: !!top && (element === top || element.contains(top)),
        }
      }
      return {
        sheet: shown('[data-testid="send-stealth-dialog"]'),
        // Quasar puts the test id on the native input itself.
        amount: shown(
          'input[data-testid="stealth-amount-input"], [data-testid="stealth-amount-input"] input',
        ),
        send: shown('[data-testid="stealth-send-confirm-btn"]'),
        available: document
          .querySelector('[data-testid="wallet-balance-value"]')
          ?.textContent?.trim(),
        horizontalScroll:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      }
    }, visibleHeight)
    console.log(JSON.stringify({ case: name, visibleHeight, ...seen }))
    const fail = text => failures.push(`${name}: ${text}`)
    for (const part of ['sheet', 'amount', 'send']) {
      if (!seen[part].present) fail(`${part} is missing`)
      else if (!seen[part].onScreen)
        fail(
          `${part} is off screen (x ${seen[part].left}..${seen[part].right}, y ${seen[part].top}..${seen[part].bottom} of ${visibleHeight})`,
        )
      else if (!seen[part].reachable) fail(`${part} is covered or clipped`)
    }
    if (seen.available !== '25 USDC')
      fail(`available shows "${seen.available}"`)
    if (seen.horizontalScroll) fail('the page scrolls sideways')
    if (out)
      await page.screenshot({
        path: join(out, `${name}.png`),
        clip: { x: 0, y: 0, width: phone.width, height: visibleHeight },
      })
    await page.close()
  }
} finally {
  await browser.close()
}
assert.deepEqual(failures, [])
console.log('stealth sheet: amount and Send reachable at 390 px, keyboard open')
