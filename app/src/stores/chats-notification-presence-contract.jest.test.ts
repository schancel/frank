import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const sourcePath = resolve(__dirname, 'chats.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)

function notificationDiagnostics(restoreBooleanCall = false) {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = file => {
    const source = readFile(file)
    return file === sourcePath && restoreBooleanCall
      ? source?.replace('&& !!stored &&', '&& Boolean(stored) &&')
      : source
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  const source = program.getSourceFile(sourcePath)
  if (!source) throw new Error('Chat source was not included')
  let method: ts.MethodDeclaration | undefined
  function visit(node: ts.Node) {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(source) === 'notifyReceivedMessages'
    )
      method = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!method) throw new Error('Notification method was not included')
  const start = method.getStart(source)
  const end = method.end
  // The full Vue gate retains other chat diagnostics; this regression targets the notification method.
  return program
    .getSemanticDiagnostics(source)
    .filter(
      diagnostic =>
        diagnostic.start !== undefined &&
        diagnostic.start >= start &&
        diagnostic.start < end,
    )
    .map(diagnostic => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }))
}

it('narrows the actual stored row without changing its truthiness contract', () => {
  expect(notificationDiagnostics()).toEqual([])
  expect(notificationDiagnostics(true)).toEqual([
    { code: 18048, message: "'stored' is possibly 'undefined'." },
  ])
}, 30000)
