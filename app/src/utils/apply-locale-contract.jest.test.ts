import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const ownerPath = resolve(__dirname, 'apply-locale.ts')
const fixturePath = resolve(__dirname, 'locale-contract-probe.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)

const fixture = `
import { Quasar, type QVueGlobals } from 'quasar';
import { applyLocale, type QuasarLangTarget } from './apply-locale';
import { i18n } from '../boot/i18n';
declare const componentQuasar: QVueGlobals;
declare const languageTarget: QuasarLangTarget;
applyLocale({ $q: Quasar, locale: 'en-us' });
applyLocale({ $q: componentQuasar, locale: 'fr-fr' });
i18n.global.locale = 'unknown-locale';
const title: string = i18n.global.messages['en-us'].startupFailure.title;
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
  return [fixturePath, ownerPath].flatMap(file => {
    const source = program.getSourceFile(file)
    if (!source)
      throw new Error(`Locale contract source was not included: ${file}`)
    return program.getSemanticDiagnostics(source)
  })
}

it('accepts framework language capabilities, string locales and the catalog message schema', () => {
  expect(
    localeDiagnostics().map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ),
  ).toEqual([])
})

it('rejects incompatible language capabilities, locale values and message resources', () => {
  expect(
    localeDiagnostics(`
applyLocale({ $q: { lang: { set: (_pack: number) => undefined } }, locale: 'fr-fr' });
languageTarget.lang.set({ isoName: 'fr' });
i18n.global.locale = 123;
i18n.global.messages['fr-fr'].startupFailure.title = 123;
i18n.global.messages['en-us'].definitelyMissing;
`).map(diagnostic => diagnostic.code),
  ).toEqual([2322, 2345, 2322, 2322, 2339])
})
