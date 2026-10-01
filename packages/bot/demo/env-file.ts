/**
 * Minimal `.env` reader for the demo launcher (#312). The file is provided by the user and read
 * at runtime only; nothing in this repository reads one during tests (tests pass text in).
 *
 * Supported: `KEY=value`, optional `export ` prefix, `#` comment lines, blank lines, values in
 * single or double quotes (no escapes, no interpolation, no command substitution). Anything else
 * is a parse error that names the line NUMBER only: a value is never echoed, because it may be a
 * secret.
 */
import { existsSync, readFileSync, statSync } from 'fs'

export class EnvFileError extends Error {}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) return
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) {
      throw new EnvFileError(`line ${i + 1} is not KEY=value`)
    }
    let value = match[2]
    const quote = value[0]
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1)
      if (end === -1) throw new EnvFileError(`line ${i + 1} has an unterminated quote`)
      value = value.slice(1, end)
    } else {
      // Unquoted: an inline comment starts at whitespace + #.
      value = value.replace(/\s+#.*$/, '').trim()
    }
    out[match[1]] = value
  })
  return out
}

/** Reads `path` if it exists (a missing file is fine: the environment alone may be enough). */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  if (!statSync(path).isFile()) {
    throw new EnvFileError(`${path} is not a file`)
  }
  try {
    return parseEnvFile(readFileSync(path, 'utf8'))
  } catch (err) {
    if (err instanceof EnvFileError) {
      throw new EnvFileError(`${path}: ${err.message}`)
    }
    throw err
  }
}
