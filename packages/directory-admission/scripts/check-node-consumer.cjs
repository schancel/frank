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
  // The repository's one declaration of the bare `level` module. Every project
  // that calls Level lists it explicitly, as packages/bot-framework/tsconfig.json does.
  const levelDeclaration = path.join(root, 'packages/wallet/level.d.ts')
  const botTypesFilename = path.join(
    root,
    'packages/bot-framework/src/types.ts',
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
    },
  }
  function check(label, consumer, extraRoots = []) {
    const sources = new Map([
      [filename, consumer],
      // The bot state store takes only this interface from the bot framework's
      // types. Standing in for that file keeps the wallet, cashweb and ethers
      // declarations it also imports out of this check. It does not declare or
      // replace the Level module.
      [
        botTypesFilename,
        `export interface BotStateStore {
  get(key: string): Promise<string | undefined>
  put(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
  batch(
    ops: Array<
      { type: 'put'; key: string; value: string } | { type: 'del'; key: string }
    >,
  ): Promise<void>
  sublevel(name: string): BotStateStore
}`,
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
    const program = ts.createProgram([filename, ...extraRoots], options, host)
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
  // Compile the bots' actual Level state store, including its location-only
  // level(location) call, alongside the public Node entry. A bot opens both in one
  // process, so the directory's private view of Level must not change what the
  // bare `level` module accepts. The only declaration added as a root file is the
  // repository's own bare `level` declaration, never the directory's private one.
  check(
    'directory Node + bot state store consumer',
    source +
      `
import { LevelBotStateStore } from './packages/bot-framework/src/state-store'
export const botState = new LevelBotStateStore('/unused-typecheck-only')
`,
    [levelDeclaration],
  )
}

module.exports = checkNodeConsumer
if (require.main === module) checkNodeConsumer()
