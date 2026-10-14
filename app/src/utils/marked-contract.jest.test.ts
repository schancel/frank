/** @jest-environment node */
import path from 'node:path'
import ts from 'typescript'

const appRoot = path.resolve(__dirname, '../..')
const configPath = path.join(appRoot, 'tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  appRoot,
  {},
  configPath,
)
const sources = [
  'address-mentions.ts',
  'markdown-plain-text.ts',
  'markdown.ts',
].map(file => path.join(__dirname, file))
const probePath = path.join(__dirname, 'marked-contract-probe.ts')
const validProbe = `
import { marked } from 'marked'
const tokens: marked.TokensList = marked.lexer('text')
const html: string = marked.parser(tokens)
`

function diagnostics(probe = validProbe, removeGuard = false) {
  const host = ts.createCompilerHost(parsed.options)
  const originalRead = host.readFile.bind(host)
  host.readFile = file => {
    if (file === probePath) return probe
    const source = originalRead(file)
    if (removeGuard && file === sources[0])
      return source?.replace(
        "if ('tokens' in token && Array.isArray(token.tokens))",
        'if (Array.isArray(token.tokens))',
      )
    return source
  }
  const program = ts.createProgram(
    [...sources, probePath],
    parsed.options,
    host,
  )
  return [...sources, probePath].flatMap(file => {
    const source = program.getSourceFile(file)
    if (!source) throw new Error(`Missing compiler input: ${file}`)
    return program.getSemanticDiagnostics(source).map(diagnostic => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }))
  })
}

describe('Marked production compiler boundary', () => {
  it('checks the actual three utilities against the installed public API', () => {
    expect(diagnostics()).toEqual([])
  })

  it('rejects invalid public inputs, options and incomplete tokens', () => {
    expect(
      diagnostics(
        validProbe +
          `
marked.lexer(123)
marked.lexer('text', { breaks: 'wrong' })
const incomplete: marked.Token = { type: 'text', text: 'missing raw' }
`,
      ).map(({ code }) => code),
    ).toEqual([2345, 2322, 2322])
  })

  it('requires property narrowing for the real Text or Tag producer union', () => {
    const failures = diagnostics(validProbe, true)
    expect(failures.map(({ code }) => code)).toEqual([2339, 2339])
    expect(
      failures.every(({ message }) => message.includes('Text | Tag')),
    ).toBe(true)
  })
})
