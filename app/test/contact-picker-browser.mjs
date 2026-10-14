// Real Vue/Quasar dialog in a fresh browser; synthetic contacts, no wallet or relay.
// CONTACT_PICKER_PLAYWRIGHT=/external/prefix/node_modules/playwright node app/test/contact-picker-browser.mjs
// Add --source-ref=<revision> to prove the regression against an earlier revision.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  parse,
  compileScript,
  compileTemplate,
  compileStyle,
} from '@vue/compiler-sfc'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CONTACT_PICKER_PLAYWRIGHT ||
  'playwright')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const reference = process.argv
  .find(arg => arg.startsWith('--source-ref='))
  ?.slice(13)
const styles = []
const stubs = {
  'src/stores/contacts': `import {defineStore} from 'pinia'; export const useContactStore=defineStore('contacts',{state:()=>({getContacts:Object.fromEntries(Array.from({length:20},(_,i)=>['address-'+i,{profile:{name:i===0?'Alice':'Bob '+i},inbox:i===0?{acceptancePrice:0.5}:{}}]))})});`,
  'src/utils/avatar':
    'export const profileAvatar=()=>"data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E";',
  'src/utils/formatting': 'export const pubKeyToColor=()=>"red";',
}
const bundle = await build({
  stdin: {
    contents: `import {createApp,ref,h} from 'vue'; import {createPinia} from 'pinia'; import * as q from 'quasar'; import Picker from './app/src/components/dialogs/ContactBookDialog.vue'; const open=ref(false); globalThis.selected=[]; const app=createApp({render:()=>h('main',[h('button',{id:'opener',onClick:()=>open.value=true},'Contacts'),h(q.QDialog,{modelValue:open.value,'onUpdate:modelValue':v=>open.value=v},()=>h(Picker,{contactClick:address=>{selected.push(address);open.value=false}}))])}); app.use(createPinia());app.use(q.Quasar,{components:Object.fromEntries(Object.entries(q).filter(([name])=>/^Q[A-Z]/.test(name))),directives:{ClosePopup:q.ClosePopup,Ripple:q.Ripple}});app.config.globalProperties.$t=key=>key;app.mount('#host');`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  define: {
    'process.env.NODE_ENV': '"production"',
    '__VUE_OPTIONS_API__': 'true',
    '__VUE_PROD_DEVTOOLS__': 'false',
    '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false',
  },
  plugins: [
    {
      name: 'vue-components',
      setup(builder) {
        builder.onResolve({ filter: /^src\// }, args => ({
          path: stubs[args.path] ? args.path : resolve(root, 'app', args.path),
          namespace: stubs[args.path] ? 'fixture' : 'file',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: stubs[args.path],
          loader: 'ts',
          resolveDir: root,
        }))
        builder.onLoad(
          { filter: /(AccountBadge|DeleteContactDialog)\.vue$/ },
          () => ({
            contents: 'export default {render:()=>null}',
            loader: 'js',
          }),
        )
        builder.onLoad({ filter: /\.vue$/ }, async args => {
          const relative = args.path.slice(args.path.lastIndexOf('/app/') + 1)
          const source =
            reference &&
            relative === 'app/src/components/dialogs/ContactBookDialog.vue'
              ? execFileSync('git', ['show', `${reference}:${relative}`], {
                  cwd: root,
                  encoding: 'utf8',
                })
              : await readFile(args.path, 'utf8')
          const descriptor = parse(source).descriptor,
            id = 'picker-' + styles.length
          const script = compileScript(descriptor, { id })
          const template = compileTemplate({
            source: descriptor.template.content,
            filename: args.path,
            id,
            scoped: true,
            compilerOptions: { bindingMetadata: script.bindings },
          })
          if (template.errors.length) throw Error(String(template.errors))
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
              `\ncomponent.render=render;component.__scopeId='data-v-${id}';export default component;`,
            loader: 'ts',
            resolveDir: dirname(args.path),
          }
        })
      },
    },
  ],
})
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CONTACT_PICKER_CHROME ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } })
  await page.setContent('<div id="host"></div>')
  await page.addStyleTag({
    content:
      (await readFile(
        resolve(root, 'node_modules/quasar/dist/quasar.prod.css'),
        'utf8',
      )) +
      '\n' +
      styles.join('\n'),
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const open = async () => {
    await page.locator('#opener').click()
    await page.locator('.contact-book-card').waitFor()
    await page.waitForTimeout(350)
  }
  await open()
  assert.equal(
    await page.locator('input').evaluate(el => el === document.activeElement),
    true,
    'opening focuses the native search input',
  )
  await page.keyboard.type('Alice')
  assert.equal(
    await page.locator('.contact-book-list .q-item').count(),
    1,
    'immediate typing filters contacts',
  )
  await page.keyboard.press('Enter')
  await page.locator('.contact-book-card').waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => selected), ['address-0'])
  assert.equal(
    await page.locator('#opener').evaluate(el => el === document.activeElement),
    true,
    'selection restores opener focus',
  )
  await open()
  assert.equal(
    await page.locator('input').evaluate(el => el === document.activeElement),
    true,
    'reopening focuses search',
  )
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await page.locator('.contact-book-card').waitFor({ state: 'detached' })
  assert.deepEqual(
    await page.evaluate(() => selected),
    ['address-0', 'address-0'],
    'arrows and Enter select the highlighted contact',
  )
  await open()
  const geometry = await page.locator('.contact-book-card').evaluate(card => ({
    width: card.getBoundingClientRect().width,
    height: card.getBoundingClientRect().height,
    scroll:
      card.querySelector('.contact-book-list').scrollHeight >
      card.querySelector('.contact-book-list').clientHeight,
    row: card.querySelector('.q-item').getBoundingClientRect().height,
    price: card.querySelector('[data-testid="inbox-price"]').textContent,
  }))
  assert.ok(
    geometry.width <= 390 && geometry.height <= 700,
    'mobile dialog fits viewport',
  )
  assert.ok(geometry.scroll, 'long contact lists scroll within the dialog')
  assert.ok(geometry.row < 78, 'mobile rows are compact')
  assert.match(geometry.price, /0.5/, 'advertised price remains visible')
  await page.locator('[data-test="contact-item-actions"]').first().focus()
  await page.keyboard.press('Enter')
  await page.locator('.q-menu').waitFor()
  assert.deepEqual(
    await page.evaluate(() => selected),
    ['address-0', 'address-0'],
    'menu keyboard activation does not select a contact',
  )
  await page.keyboard.press('Escape')
  await page.locator('.q-menu').waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  await page.locator('.contact-book-card').waitFor({ state: 'detached' })
  assert.equal(
    await page.locator('#opener').evaluate(el => el === document.activeElement),
    true,
    'Escape restores opener focus',
  )
  await open()
  await page.locator('.contact-book-actions button').focus()
  await page.keyboard.press('Enter')
  await page.locator('.contact-book-card').waitFor({ state: 'detached' })
  assert.deepEqual(
    await page.evaluate(() => selected),
    ['address-0', 'address-0'],
    'closing with Enter does not select a contact',
  )
  console.log(
    'PASS native input focus, typing, reopen, arrows/Enter, Escape, restoration and mobile geometry',
  )
} finally {
  await browser.close()
}
