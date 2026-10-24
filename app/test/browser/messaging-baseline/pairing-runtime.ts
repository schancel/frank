/** Simulated extension API for the real sender page; never installed in a product build. */
import { splitCodex32 } from '@frank/codex32'
import {
  createSyncSender,
  SYNC_PAIRING_TTL_MS,
  type SyncSenderState,
} from '../../../src/utils/sync-pairing'

type Mode = 'tab' | 'popup' | 'web'
type Event = {
  type: string
  offerId?: string
  path?: string
  threshold?: number
  count?: number
}
declare global {
  interface Window {
    __pairingMode?: Mode
    __pairingFixture: typeof pairing
  }
}
let exportRelease: (() => void) | undefined
let promotion:
  | {
      resolve: (value: { opened: boolean; mode: 'tab'; url: string }) => void
      reject: (error: Error) => void
      path: string
    }
  | undefined
let offer: { id: string; sender: SyncSenderState } | undefined
const listeners = new Set<(message: unknown) => unknown>()
export const pairing = {
  events: [] as Event[],
  get activeOfferId() {
    return offer?.id ?? null
  },
  releaseExport() {
    exportRelease?.()
    exportRelease = undefined
  },
  acknowledgePromotion(ok: boolean) {
    if (!promotion) throw new Error('No promotion request')
    const pending = promotion
    promotion = undefined
    pairing.events.push({ type: ok ? 'tab-ack' : 'tab-rejected' })
    if (ok) pending.resolve({ opened: true, mode: 'tab', url: pending.path })
    else pending.reject(new Error('Synthetic browser refused tab'))
  },
}
if (typeof window !== 'undefined') window.__pairingFixture = pairing
export function isSimulatedExtension() {
  return window.__pairingMode === 'tab' || window.__pairingMode === 'popup'
}
export async function backupCodex32(
  threshold: number,
  count: number,
): Promise<string[]> {
  if (!window.__pairingMode) throw new Error('Export outside pairing scenario')
  pairing.events.push({ type: 'export', threshold, count })
  if (threshold !== 2 || count !== 3) throw new Error('Unexpected export shape')
  await new Promise<void>(resolve => {
    exportRelease = resolve
  })
  const shares = splitCodex32({
    threshold: 2,
    identifier: 'test',
    indices: ['q', 'p', 'z'],
    secret: new Uint8Array(16).fill(0x42),
    randomBytes: length => new Uint8Array(length).fill(0x73),
  })
  if (!shares.ok) throw new Error('Synthetic share generation failed')
  return [...shares.value]
}
export function openTab({
  path = 'index.html?extMode=tab',
}: { path?: string } = {}) {
  if (promotion) throw new Error('Concurrent promotion')
  pairing.events.push({ type: 'tab-request', path })
  return new Promise<{ opened: boolean; mode: 'tab'; url: string }>(
    (resolve, reject) => {
      promotion = { resolve, reject, path }
    },
  )
}
export function closeView() {
  pairing.events.push({ type: 'close-request' })
  return true
}
export function listen(listener: (message: unknown) => unknown) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export async function message<TReq = unknown, TRes = unknown>(
  request: TReq,
): Promise<TRes> {
  const value = request as {
    channel?: string
    type?: string
    payload?: { offerId?: string; deviceSyncBundle?: Record<string, unknown> }
  }
  if (value.channel !== 'frank-pwa-extension-sync-v1') return null as TRes
  const id = value.payload?.offerId
  if (value.type === 'extension-sync-offer') {
    if (!id || !value.payload?.deviceSyncBundle || offer)
      throw new Error('Invalid or duplicate synthetic offer')
    offer = { id, sender: createSyncSender(value.payload.deviceSyncBundle) }
    pairing.events.push({ type: 'offer', offerId: id })
    return {
      result: {
        ok: true,
        offerId: id,
        pin: offer.sender.pin,
        expiresAt: Date.now() + SYNC_PAIRING_TTL_MS,
      },
    } as TRes
  }
  if (value.type === 'extension-sync-cancel') {
    pairing.events.push({ type: 'cancel', offerId: id })
    if (offer?.id !== id) throw new Error('Cancellation does not own the offer')
    offer = undefined
    return { ok: true } as TRes
  }
  throw new Error('Unexpected simulated pairing runtime request: ' + value.type)
}
