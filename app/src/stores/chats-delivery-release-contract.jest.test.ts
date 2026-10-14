import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const sourcePath = resolve(__dirname, 'chats.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)

function releaseDiagnostics(removeAnnotation = false) {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = file => {
    const source = readFile(file)
    return file === sourcePath && removeAnnotation
      ? source?.replace('let release: () => void =', 'let release =')
      : source
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error('Chat source was not included')
  const helper = source.statements.find(
    statement =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'serializeDeliveryMutation',
  )
  if (!helper) throw new Error('Delivery mutation helper was not included')
  // This regression covers the existing helper; the full Vue gate reports other chat diagnostics.
  return program
    .getSemanticDiagnostics(source)
    .filter(
      diagnostic =>
        diagnostic.start !== undefined &&
        diagnostic.start >= helper.getStart(source) &&
        diagnostic.start < helper.end,
    )
    .map(diagnostic => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }))
}

it('accepts the real Promise<void> resolver as the existing release capability', () => {
  expect(releaseDiagnostics()).toEqual([])
  expect(releaseDiagnostics(true)).toEqual([
    {
      code: 2322,
      message: expect.stringContaining(
        "is not assignable to type '() => undefined'",
      ),
    },
  ])
}, 30000)
