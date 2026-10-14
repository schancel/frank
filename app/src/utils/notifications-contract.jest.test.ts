import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const sourcePath = resolve(__dirname, 'notifications.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)

function notificationDiagnostics(restoreUnsafeCall = false) {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = file => {
    const source = readFile(file)
    return file === sourcePath && restoreUnsafeCall
      ? source?.replace(
          /const url = transactionExplorerUrl\(txId\)\s+if \(url\) \{\s+openURL\(url\)\s+\}/,
          'openURL(transactionExplorerUrl(txId))',
        )
      : source
  }
  const program = ts.createProgram([sourcePath], parsed.options, host)
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error('Notification source was not included')
  return program.getSemanticDiagnostics(source).map(diagnostic => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }))
}

it('narrows the real optional explorer result before passing it to Quasar', () => {
  expect(notificationDiagnostics()).toEqual([])
  expect(notificationDiagnostics(true)).toEqual([
    {
      code: 2345,
      message: expect.stringContaining("Argument of type 'string | undefined'"),
    },
  ])
}, 30000)
