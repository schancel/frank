// Operator clock for the relays' directory runtime. The relay reads Unix nanoseconds from an
// explicit file and has no wall-clock fallback; this keeps each relay's file at this machine's
// time. The value is rewritten in place (same length, one write) so a reader never sees an empty
// or renamed file.
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

const files = process.argv.slice(2)
const now = () => `${BigInt(Date.now()) * 1_000_000n}\n`
const fds = files.map(file => {
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, now())
  return openSync(file, 'r+')
})
const tick = () => {
  const text = Buffer.from(now())
  for (const fd of fds) writeSync(fd, text, 0, text.length, 0)
}
tick()
setInterval(tick, 200)
process.on('SIGTERM', () => {
  for (const fd of fds) closeSync(fd)
  process.exit(0)
})
console.log(`clock writer for ${files.join(', ')}`)
