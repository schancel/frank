import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const sourcePath = resolve(__dirname, 'settings.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)

function gatewayDiagnostics(removePresenceGuard = false) {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = file => {
    const source = readFile(file)
    return file === sourcePath && removePresenceGuard
      ? source?.replace('!state.advertisedEmailGateway ||', '')
      : source
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error('Settings source was not included')
  return program.getSemanticDiagnostics(source).map(diagnostic => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }))
}

it('requires an actual advertisement before projecting its gateway address', () => {
  expect(gatewayDiagnostics()).toEqual([])
  expect(gatewayDiagnostics(true)).toEqual([
    {
      code: 18047,
      message: "'state.advertisedEmailGateway' is possibly 'null'.",
    },
  ])
}, 30000)
