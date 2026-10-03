import { readFileSync } from 'node:fs'
import {
  checkBrowser,
  checkNode,
  disposeBundle,
  initBundle,
  parseTrust,
  reopenBundle,
  startFixture,
} from './index'
import { decimal } from './provision'

async function main(): Promise<void> {
  const [command, inputFile] = process.argv.slice(2)
  if (
    !inputFile ||
    process.argv.length !== 4 ||
    ![
      'init',
      'serve',
      'check-node',
      'check-browser',
      'reopen',
      'dispose',
    ].includes(command)
  )
    throw new Error(
      'Usage: node --import tsx cli.ts <init|serve|check-node|check-browser|reopen|dispose> <explicit-input.json>',
    )
  const input = JSON.parse(readFileSync(inputFile, 'utf8'))
  const nowNs = decimal(input.nowNs)
  const abort = new AbortController()
  let stop: (() => Promise<void>) | undefined
  let interrupted = false
  let finish: (() => void) | undefined
  const signal = () => {
    interrupted = true
    abort.abort()
    finish?.()
  }
  process.on('SIGINT', signal)
  process.on('SIGTERM', signal)
  try {
    let output: unknown
    if (command === 'init')
      output = initBundle({
        mode: input.mode,
        runDir: input.runDir,
        trustInputs: parseTrust(input.trustInputs),
        nowNs,
        witnessHex: input.witnessHex,
      })
    else if (command === 'dispose') {
      disposeBundle(input, nowNs)
      output = { kind: 'synthetic-fixture-disposed' }
    } else if (command === 'reopen') output = reopenBundle(input, nowNs)
    else if (command === 'check-node') output = await checkNode(input, nowNs)
    else if (command === 'check-browser')
      output = await checkBrowser(input, nowNs, input.chromium, abort.signal)
    else {
      const fixture = await startFixture(input, nowNs)
      stop = fixture.stop
      if (!interrupted) {
        console.log(JSON.stringify({ kind: 'synthetic-fixture-listening' }))
        await new Promise<void>(resolve => {
          finish = resolve
        })
      }
    }
    if (output !== undefined && !interrupted)
      console.log(
        JSON.stringify(output, (_, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      )
    if (interrupted) process.exitCode = 130
  } finally {
    await stop?.()
    process.removeListener('SIGINT', signal)
    process.removeListener('SIGTERM', signal)
  }
}
void main().catch(error => {
  console.error(
    error instanceof Error ? error.message : 'Fixture operation failed',
  )
  process.exitCode = 1
})
