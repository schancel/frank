import { createNativeNegotiationJournalStore } from './negotiation-native.ts'
import { binding, emptyRow } from './storage-cases.testutil.ts'
const store = await createNativeNegotiationJournalStore({
  ...binding,
  rootLocation: process.argv[2],
})
try {
  const value = await store.read(emptyRow(0).key)
  console.log(
    JSON.stringify({
      namespace: store.namespace,
      key: emptyRow(0).key,
      present: value !== undefined,
    }),
  )
} catch (error) {
  console.log(String(error))
  process.exitCode = 2
} finally {
  await store.close()
}
