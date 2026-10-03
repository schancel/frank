const assert = require('assert/strict')
const { killOwnedGroup } = require('../scripts/test-browser.cjs')

function verifyCleanup() {
  let signals = 0
  killOwnedGroup(
    123,
    () => signals++,
    () => [],
  )
  assert.equal(signals, 0, 'an exited empty group must not be signalled again')
  let observations = 0
  const denied = () => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
  }
  killOwnedGroup(123, denied, () => (observations++ === 0 ? [123] : []))
  assert.throws(
    () => killOwnedGroup(123, denied, () => [124]),
    { code: 'EPERM' },
    'a live inaccessible descendant must fail cleanup',
  )
  const absent = () => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  }
  killOwnedGroup(123, absent, () => [123])
  return 4
}
module.exports = { verifyCleanup }
if (require.main === module)
  console.log(JSON.stringify({ cleanup: verifyCleanup(), ok: true }))
