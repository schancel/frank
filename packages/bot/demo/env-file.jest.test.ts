import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { EnvFileError, parseEnvFile, readEnvFile } from './env-file'

describe('parseEnvFile', () => {
  it('reads KEY=value lines, comments, export, and quotes', () => {
    expect(
      parseEnvFile(
        [
          '# comment',
          '',
          'A=1',
          'export B = two words # trailing comment',
          'C="quoted # not a comment"',
          "D='single'",
          'E=',
        ].join('\n'),
      ),
    ).toEqual({ A: '1', B: 'two words', C: 'quoted # not a comment', D: 'single', E: '' })
  })

  it('does no interpolation or command substitution', () => {
    expect(parseEnvFile('A=$(echo hi)\nB=${A}')).toEqual({ A: '$(echo hi)', B: '${A}' })
  })

  it('reports the line number, never the value, of a bad line', () => {
    const secret = 'sekret-value-123'
    let message = ''
    try {
      parseEnvFile(`GOOD=1\nthis is ${secret} not valid`)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toBe('line 2 is not KEY=value')
    expect(message).not.toContain(secret)
    expect(() => parseEnvFile(`A="${secret}`)).toThrow('line 1 has an unterminated quote')
  })
})

describe('readEnvFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-file-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('treats a missing file as empty', () => {
    expect(readEnvFile(join(dir, 'nope.env'))).toEqual({})
  })

  it('names the file and line on a parse error', () => {
    const file = join(dir, 'bad.env')
    writeFileSync(file, 'nonsense')
    expect(() => readEnvFile(file)).toThrow(EnvFileError)
    expect(() => readEnvFile(file)).toThrow(`${file}: line 1 is not KEY=value`)
  })

  it('refuses a directory', () => {
    expect(() => readEnvFile(dir)).toThrow(/is not a file/)
  })
})
