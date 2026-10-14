import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const configPath = resolve(appDir, 'test/typecheck/tsconfig.json')
const fixturePath = resolve(appDir, 'test/typecheck/frontend-composition.ts')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  resolve(appDir, 'test/typecheck'),
)

// This is a component API contract test, not the full frontend compiler gate.
// Full vue-tsc output remains observable until #1272's remaining predecessors land.
function componentDiagnostics(extraSource = ''): readonly ts.Diagnostic[] {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = file =>
    file === fixturePath
      ? readFileSync(fixturePath, 'utf8') + extraSource
      : readFile(file)
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  const source = program.getSourceFile(fixturePath)
  if (!source) throw new Error('Frontend composition fixture was not included')
  return program.getSemanticDiagnostics(source)
}

it('uses the installed i18n, Quasar and router contracts alongside app properties', () => {
  expect(
    componentDiagnostics().map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ),
  ).toEqual([])
})

it('rejects invalid plugin arguments, app state types and absent custody globals', () => {
  const diagnostics = componentDiagnostics(`
component.$t({});
component.$router.push(123);
component.$q.notify({ definitelyUnknownNotifyOption: true });
component.$status.loaded = 'wrong';
component.$wallet;
component.$relay;
component.$indexer;
component.openURL('https://example.test');
`)
  const messages = diagnostics.map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  )
  expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
    2769, 2345, 2353, 2322, 2339, 2339, 2339, 2722,
  ])
  for (const property of ['$wallet', '$relay', '$indexer']) {
    expect(
      messages.some(message => message.includes(`Property '${property}'`)),
    ).toBe(true)
  }
})
