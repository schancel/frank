const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')
const { execFileSync } = require('child_process')
const assert = require('assert/strict')
const ts = require('typescript')
const { createContext, runInContext } = require('vm')
const { root, packageRoot } = require('./build-tests.cjs')
const demoEntries = new Map([
  ['packages/bot/demo/directory-trust/admission.ts', '/node'],
  ['packages/bot/demo/directory-trust/browser-admission.ts', '/browser'],
  ['packages/bot/demo/directory-trust/admission.jest.test.ts', null],
  ['packages/cashweb/relay/canonical-dm.ts', null],
  ['packages/cashweb/relay/canonical-dm.jest.test.ts', '/node'],
  ['packages/cashweb/relay/directory-client.ts', null],
  ['packages/cashweb/relay/directory-client.jest.test.ts', '/node'],
  ['packages/cashweb/relay/monad-mailbox-client.ts', null],
  ['packages/cashweb/relay/monad-mailbox-client.jest.test.ts', '/node'],
  // The open directory: shared client logic takes its stores from the caller; the Node storage
  // helper (bots, tests) and the app's messaging session are the only places that open one.
  ['packages/cashweb/relay/open-directory.ts', null],
  ['packages/cashweb/relay/open-directory-node.ts', '/node'],
  ['app/src/utils/monad-identity-session.ts', '/browser'],
  ['app/src/utils/monad-identity-session.jest.test.ts', '/browser'],
  // The Qwen bot uses the same open directory through the Node storage helper; its workflows
  // only name the public Current type. Two workflow tests admit fixtures through a Node store.
  ['packages/bot/qwen-bot-common.ts', null],
  ['packages/bot/qwen-inbound-workflow.ts', null],
  ['packages/bot/qwen-response-workflow.ts', null],
  ['packages/bot/qwen-inbound-workflow.jest.test.ts', '/node'],
  ['packages/bot/qwen-response-workflow.jest.test.ts', '/node'],
  ['packages/wallet/chain/monad-canonical-dm.jest.test.ts', '/node'],
])
// A jest test may replace its own allowlisted entry with a mock; nothing else may call it in.
function isJestMock(node, file) {
  return (
    /\.jest\.test\.[cm]?[jt]sx?$/.test(file) &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'jest' &&
    node.expression.name.text === 'mock'
  )
}
function checkConsumer(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let count = 0
  function visit(node) {
    let specifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal
    else if (ts.isExternalModuleReference(node)) specifier = node.expression
    else if (ts.isCallExpression(node)) specifier = node.arguments[0]
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const name = specifier.text
      const base = '@frank/directory-admission'
      if (name === base || name.startsWith(base + '/')) {
        count++
        const clause = ts.isImportDeclaration(node) && node.importClause
        const typeOnly =
          ts.isImportTypeNode(node) ||
          !!(
            clause &&
            (clause.isTypeOnly ||
              (!clause.name &&
                clause.namedBindings &&
                ts.isNamedImports(clause.namedBindings) &&
                clause.namedBindings.elements.length > 0 &&
                clause.namedBindings.elements.every(item => item.isTypeOnly)))
          )
        if (
          !demoEntries.has(file) ||
          (name === base
            ? !typeOnly
            : !(ts.isImportDeclaration(node) || isJestMock(node, file)) ||
              !demoEntries.get(file) ||
              name !== base + demoEntries.get(file))
        )
          throw new Error(
            `unexpected active runtime adoption: ${file}: ${name}`,
          )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}
function checkConsumerRegressions() {
  const node = 'packages/bot/demo/directory-trust/admission.ts'
  const browser = 'packages/bot/demo/directory-trust/browser-admission.ts'
  const test = 'packages/bot/demo/directory-trust/admission.jest.test.ts'
  assert.equal(
    checkConsumer(
      node,
      "import {openNodeDirectoryStore} from '@frank/directory-admission/node'",
    ),
    1,
  )
  assert.equal(
    checkConsumer(
      browser,
      "import {openBrowserDirectoryStore} from '@frank/directory-admission/browser'",
    ),
    1,
  )
  assert.equal(
    checkConsumer(
      test,
      "import type {Current} from '@frank/directory-admission'",
    ),
    1,
  )
  assert.equal(
    checkConsumer(
      node,
      "import {type Current} from '@frank/directory-admission'",
    ),
    1,
  )
  for (const basename of ['canonical-dm', 'directory-client']) {
    const production = `packages/cashweb/relay/${basename}.ts`
    const fixture = `packages/cashweb/relay/${basename}.jest.test.ts`
    for (const file of [production, fixture]) {
      assert.equal(
        checkConsumer(
          file,
          "import type {Current} from '@frank/directory-admission'",
        ),
        1,
      )
      for (const statement of [
        "import {Current} from '@frank/directory-admission'",
        "import '@frank/directory-admission'",
        "export * from '@frank/directory-admission'",
        "require('@frank/directory-admission')",
        "import('@frank/directory-admission')",
        "import type {X} from '@frank/directory-admission/storage/level'",
        "import {open} from '@frank/directory-admission/browser'",
      ])
        assert.throws(
          () => checkConsumer(file, statement),
          /unexpected active runtime adoption/,
        )
    }
    assert.equal(
      checkConsumer(
        fixture,
        "import {openNodeDirectoryStore} from '@frank/directory-admission/node'",
      ),
      1,
    )
    for (const file of [production, fixture + '.extra.ts'])
      assert.throws(
        () =>
          checkConsumer(
            file,
            "import {openNodeDirectoryStore} from '@frank/directory-admission/node'",
          ),
        /unexpected active runtime adoption/,
      )
  }
  for (const [file, statement] of [
    [node, "import {Current} from '@frank/directory-admission'"],
    [node, "import {} from '@frank/directory-admission'"],
    [node, "import '@frank/directory-admission'"],
    [node, "import {open} from '@frank/directory-admission/browser'"],
    [browser, "import {open} from '@frank/directory-admission/node'"],
    [test, "import {open} from '@frank/directory-admission/node'"],
    [node, "import type {X} from '@frank/directory-admission/storage/level'"],
    [node, "export * from '@frank/directory-admission'"],
    [node, "require('@frank/directory-admission')"],
    [node, "import('@frank/directory-admission')"],
    ['app/directory.ts', "import type {X} from '@frank/directory-admission'"],
    [
      'packages/bot/runtime.ts',
      "import {open} from '@frank/directory-admission/node'",
    ],
    [
      node + '.extra.ts',
      "import {open} from '@frank/directory-admission/node'",
    ],
  ])
    assert.throws(
      () => checkConsumer(file, statement),
      /unexpected active runtime adoption/,
    )
}
async function main() {
  checkConsumerRegressions()
  require('./check-node-consumer.cjs')()
  const manifest = require(path.join(packageRoot, 'package.json'))
  const allowed = ['@frank/codec', 'level']
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), allowed)
  assert.deepEqual(manifest.exports, {
    '.': './src/index.ts',
    './browser': './src/browser.ts',
    './node': './src/node.ts',
  })
  const result = await esbuild.build({
    entryPoints: [path.join(packageRoot, 'src/browser.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'DirectoryAdmission',
    metafile: true,
    alias: {
      '@frank/codec': path.join(root, 'packages/frank-codec/src/index.ts'),
    },
  })
  for (const input of Object.keys(result.metafile.inputs)) {
    if (
      /(?:^|\/)(?:proposals|backend|wallet|app|bot|level|levelup|leveldown)(?:\/|$)/.test(
        input,
      )
    )
      throw new Error(`forbidden browser dependency ${input}`)
  }
  for (const output of Object.values(result.metafile.outputs))
    assert.equal(output.imports.length, 0)
  const realm = createContext({})
  runInContext(result.outputFiles[0].text, realm, { timeout: 5000 })
  assert.equal(
    runInContext(
      'JSON.stringify(Object.keys(DirectoryAdmission).sort())',
      realm,
    ),
    JSON.stringify(['AdmissionError', 'openBrowserDirectoryStore']),
  )
  assert.equal(
    runInContext(
      '[typeof process, typeof Buffer, typeof require].join(",")',
      realm,
    ),
    'undefined,undefined,undefined',
  )
  const types = await esbuild.transform(
    fs.readFileSync(path.join(packageRoot, 'src/index.ts'), 'utf8'),
    { loader: 'ts', format: 'esm' },
  )
  if (types.code.trim() !== '')
    throw new Error('root entrypoint must export data types only')
  const sourceFiles = fs
    .readdirSync(path.join(packageRoot, 'src'), { recursive: true })
    .filter(file => file.endsWith('.ts'))
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(packageRoot, 'src', file), 'utf8')
    if (
      /from\s+['"][^'"]*(?:proposals|\/wallet|\/app|\/bot|backend)/.test(source)
    )
      throw new Error(`forbidden production import ${file}`)
  }
  let consumers = ''
  try {
    consumers = execFileSync(
      'git',
      [
        'grep',
        '-l',
        '-z',
        '-F',
        '@frank/directory-admission',
        '--',
        ':!packages/directory-admission',
        ':!docs',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (error) {
    if (error.status !== 1) throw error
  }
  const allowedDemoConsumerFiles = consumers
    .split('\0')
    .filter(
      file =>
        /\.[cm]?[jt]sx?$/.test(file) &&
        checkConsumer(file, fs.readFileSync(path.join(root, file), 'utf8')) > 0,
    )
  const example = /```ts\n([\s\S]*?)```/.exec(
    fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8'),
  )
  assert.ok(example, 'README consumer example is required')
  await esbuild.build({
    stdin: { contents: example[1], loader: 'ts', resolveDir: packageRoot },
    bundle: true,
    write: false,
    platform: 'browser',
    treeShaking: false,
    alias: {
      '@frank/directory-admission/browser': path.join(
        packageRoot,
        manifest.exports['./browser'],
      ),
      '@frank/directory-admission': path.join(
        packageRoot,
        manifest.exports['.'],
      ),
      '@frank/codec': path.join(root, 'packages/frank-codec/src/index.ts'),
    },
  })
  console.log(
    JSON.stringify({
      ok: true,
      browserInputs: Object.keys(result.metafile.inputs).length,
      allowedDemoConsumerFiles: allowedDemoConsumerFiles.length,
      rootTypesOnly: true,
      publicExample: true,
      bareRealm: true,
    }),
  )
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
