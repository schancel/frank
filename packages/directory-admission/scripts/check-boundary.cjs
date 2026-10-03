const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')
const { execFileSync } = require('child_process')
const assert = require('assert/strict')
const { createContext, runInContext } = require('vm')
const { root, packageRoot } = require('./build-tests.cjs')
async function main() {
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
        '-n',
        '-E',
        '(from |require\\()["\x27]@frank/directory-admission',
        '--',
        ':!packages/directory-admission',
        ':!docs',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (error) {
    if (error.status !== 1) throw error
  }
  if (consumers.trim())
    throw new Error(`unexpected active runtime adoption:\n${consumers}`)
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
      runtimeConsumers: 0,
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
