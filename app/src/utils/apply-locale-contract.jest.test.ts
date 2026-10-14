import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const fixturePath = resolve(__dirname, 'locale-contract-probe.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)

const fixture = `
import { Quasar, type QVueGlobals } from 'quasar';
import { applyLocale, type QuasarLangTarget } from './apply-locale';
declare const componentQuasar: QVueGlobals;
declare const languageTarget: QuasarLangTarget;
applyLocale({ $q: Quasar, locale: 'en-us' });
applyLocale({ $q: componentQuasar, locale: 'fr-fr' });
`

function localeDiagnostics(extraSource = ''): readonly ts.Diagnostic[] {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  host.readFile = file =>
    file === fixturePath ? fixture + extraSource : readFile(file)
  const program = ts.createProgram(
    [...parsed.fileNames, fixturePath],
    parsed.options,
    host,
  )
  const source = program.getSourceFile(fixturePath)
  if (!source) throw new Error('Locale capability fixture was not included')
  return program.getSemanticDiagnostics(source)
}

it('accepts the installed Quasar singleton and component language capability', () => {
  expect(
    localeDiagnostics().map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ),
  ).toEqual([])
})

it('rejects incompatible setters and incomplete language packs', () => {
  expect(
    localeDiagnostics(`
applyLocale({ $q: { lang: { set: (_pack: number) => undefined } }, locale: 'fr-fr' });
languageTarget.lang.set({ isoName: 'fr' });
`).map(diagnostic => diagnostic.code),
  ).toEqual([2322, 2345])
})
