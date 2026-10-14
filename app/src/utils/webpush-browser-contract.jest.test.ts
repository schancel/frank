import { resolve } from 'node:path'
import ts from 'typescript'

const appDir = resolve(__dirname, '../..')
const sourcePath = resolve(__dirname, 'webpush-sync.ts')
const consumerPath = resolve(__dirname, 'webpush-browser-consumer.ts')
const config = ts.readConfigFile(
  resolve(appDir, 'tsconfig.json'),
  ts.sys.readFile,
)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, appDir)
const consumer = `
import { ensureBrowserPushSubscription } from './webpush-sync'
type Options = NonNullable<Parameters<typeof ensureBrowserPushSubscription>[0]>
declare const registration: ServiceWorkerRegistration
const native: Options = { serviceWorkerRegistration: registration }
const invalid: Options = {
  serviceWorkerRegistration: {
    pushManager: { subscribe: async (_options: { applicationServerKey: string }) => null },
  },
}
void [native, invalid]
`

function consumerDiagnostics(restoreBroadBuffer = false) {
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = file => file === consumerPath || fileExists(file)
  host.readFile = file => {
    if (file === consumerPath) return consumer
    const source = readFile(file)
    return file === sourcePath && restoreBroadBuffer
      ? source?.replace(
          'applicationServerKey: Uint8Array<ArrayBuffer>',
          'applicationServerKey: Uint8Array',
        )
      : source
  }
  const program = ts.createProgram([consumerPath], parsed.options, host)
  const source = program.getSourceFile(consumerPath)
  if (!source) throw new Error('WebPush type consumer was not included')
  return program.getSemanticDiagnostics(source).map(diagnostic => ({
    code: diagnostic.code,
    line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
  }))
}

it('accepts native DOM registration and rejects incompatible adapters through the production signature', () => {
  expect(consumerDiagnostics()).toEqual([{ code: 2322, line: 8 }])
  expect(consumerDiagnostics(true)).toEqual([
    { code: 2322, line: 5 },
    { code: 2322, line: 8 },
  ])
}, 30000)
