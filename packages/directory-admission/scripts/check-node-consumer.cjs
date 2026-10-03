const path = require('path')
const ts = require('typescript')

function checkNodeConsumer() {
  const packageRoot = path.resolve(__dirname, '..')
  const root = path.resolve(packageRoot, '../..')
  const manifest = require(path.join(packageRoot, 'package.json'))
  const filename = path.join(root, 'directory-node-consumer.ts')
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
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, ...rest) =>
    file === filename
      ? ts.createSourceFile(file, source, languageVersion)
      : getSourceFile(file, languageVersion, ...rest)
  const program = ts.createProgram([filename], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) {
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: file => file,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    )
  }
  console.log('directory Node public consumer: strict declaration closure ok')
}

module.exports = checkNodeConsumer
if (require.main === module) checkNodeConsumer()
