import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const sourcePath = resolve(__dirname, 'wallet-configs.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)

function orderingDiagnostics(control?: 'untyped' | 'invalid-kind') {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = file => {
    const source = readFile(file)
    if (file !== sourcePath) return source
    if (control === 'untyped')
      return source?.replace(': readonly SupportedChainKind[]', '')
    if (control === 'invalid-kind')
      return source?.replace("'monad',", "'unknown-network-kind',")
    return source
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error('Wallet configuration source was not included')
  return program
    .getSemanticDiagnostics(source)
    .map(diagnostic => diagnostic.code)
}

it('uses registry kinds for presentation ordering and rejects unsupported literals', () => {
  expect(orderingDiagnostics()).toEqual([])
  expect(orderingDiagnostics('untyped')).toEqual([2345])
  expect(orderingDiagnostics('invalid-kind')).toEqual([2322])
}, 30000)
