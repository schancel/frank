import { readonly, shallowRef } from 'vue'

type StartupRestoration =
  | { phase: 'restoring' }
  | { phase: 'restored' }
  | { phase: 'failed'; reason: 'state-restore-failed' }

// Transient application restoration only; custody retains its own account readiness state.
const restoration = shallowRef<StartupRestoration>({ phase: 'restoring' })
export const startupRestoration = readonly(restoration)

/** setup-apis is the production writer. Tests may reset this transient boundary in isolation. */
export function setStartupRestoration(result: StartupRestoration): void {
  restoration.value = result
}
