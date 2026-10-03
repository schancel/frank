const path = require('path')
const ts = require('typescript')
const assert = require('assert/strict')

function checkNodeConsumer() {
  // The declaration boundary must not select a different runtime implementation.
  assert.equal(require.resolve('level/level.js'), require.resolve('level'))
  const packageRoot = path.resolve(__dirname, '..')
  const root = path.resolve(packageRoot, '../..')
  const manifest = require(path.join(packageRoot, 'package.json'))
  const filename = path.join(root, 'directory-node-consumer.ts')
  const envelopeFilename = path.join(
    root,
    'directory-node-consumer-envelope.d.ts',
  )
  const source = `
import {
  openNodeDirectoryStore,
  type Anchor,
  type DirectoryStore,
} from '@frank/directory-admission/node'

export function consume(location: string, anchor: Anchor): Promise<DirectoryStore> {
  return openNodeDirectoryStore({ location, anchor, mode: { kind: 'new' } })
}
`
  // A downstream project starts with only its consumer, not the package tsconfig's
  // src/**/*.ts include (which incidentally includes private ambient declarations).
  const options = {
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    esModuleInterop: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
    paths: {
      '@frank/directory-admission/node': [
        path.resolve(packageRoot, manifest.exports['./node']),
      ],
      '@frank/codec': [path.join(root, 'packages/frank-codec/src/index.ts')],
      // Isolate the unchanged faucet's Level boundary from unrelated cashweb
      // declarations. This stub does not declare or replace the Level module.
      '@frank/cashweb/relay/monad-message-envelope': [envelopeFilename],
    },
  }
  function check(label, consumer) {
    const sources = new Map([
      [filename, consumer],
      [
        envelopeFilename,
        'export declare function canonicalMonadEnvelopeAddress(address: string): string',
      ],
    ])
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile.bind(host)
    const fileExists = host.fileExists.bind(host)
    host.fileExists = file => sources.has(file) || fileExists(file)
    host.getSourceFile = (file, languageVersion, ...rest) =>
      sources.has(file)
        ? ts.createSourceFile(file, sources.get(file), languageVersion)
        : getSourceFile(file, languageVersion, ...rest)
    const program = ts.createProgram([filename], options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program)
    if (diagnostics.length) {
      throw new Error(
        `${label}:\n` +
          ts.formatDiagnostics(diagnostics, {
            getCanonicalFileName: file => file,
            getCurrentDirectory: () => root,
            getNewLine: () => '\n',
          }),
      )
    }
    console.log(`${label}: strict declaration closure ok`)
  }
  check('directory Node public consumer', source)
  // Compile the actual unmodified legacy consumer, including its location-only
  // level(this.dbLocation) call, alongside the public Node entry. Neither check
  // includes private ambient declarations as consumer root files.
  check(
    'directory Node + legacy faucet consumer',
    source +
      `
import { FaucetStateStore } from './packages/bot/faucet-state'
export const legacy = new FaucetStateStore('/unused-typecheck-only')
`,
  )
}

module.exports = checkNodeConsumer
if (require.main === module) checkNodeConsumer()
