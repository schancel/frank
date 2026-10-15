// Actual adapter in an independent process. Only synthetic test database paths are supplied.
const { createNativeEcashOperationStore } = require('./native.ts')
const { binding } = require('./fixture.ts')
;(async () => {
  const store = await createNativeEcashOperationStore({
    ...binding,
    rootLocation: process.argv[2],
  })
  try {
    const ledger = await store.get(store.walletKey)
    const opened = { status: 'opened', ledger }
    if (process.argv[3] === '--hold') {
      process.send(opened)
      await new Promise(resolve => process.once('message', resolve))
    } else process.stdout.write(JSON.stringify(opened))
  } catch (error) {
    if (!/lock .*LOCK:|LOCK:.*lock/i.test(String(error.message))) throw error
    process.stdout.write(JSON.stringify({ status: 'locked' }))
    process.exitCode = 2
  } finally {
    await store.close()
  }
})().catch(error => {
  console.error(error.message)
  process.exitCode = 3
})
