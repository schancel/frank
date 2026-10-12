/// <reference lib="esnext.disposable" />
import type { WebAuthnClient } from '@category-labs/mera'

export type MeraAccountAction = 'create' | 'login'
export type MeraFailureCode = 'unsupported' | 'cancelled' | 'prf' | 'failed'

/** Public error codes only: provider causes and credential material never reach presentation. */
export class MeraAccountError extends Error {
  constructor(readonly code: MeraFailureCode) {
    super(`Passkey account: ${code}`)
    this.name = 'MeraAccountError'
  }
}

export function supportsMeraPasskeys(): boolean {
  return (
    globalThis.isSecureContext === true &&
    typeof globalThis.PublicKeyCredential !== 'undefined' &&
    typeof globalThis.navigator?.credentials?.create === 'function' &&
    typeof globalThis.navigator?.credentials?.get === 'function' &&
    typeof globalThis.crypto?.subtle?.digest === 'function'
  )
}

// Changing this input, RP scope, or the raw-output mapping changes account identity.
export const MERA_ACCOUNT_PRF_DOMAIN = 'frank.mera.account-root.v1'

/** Caller owns and must wipe the returned root. No credential metadata is persisted. */
export async function getMeraAccountRoot(
  action: MeraAccountAction,
  webAuthnClient?: WebAuthnClient,
): Promise<Uint8Array> {
  if (!supportsMeraPasskeys() || !globalThis.location?.hostname)
    throw new MeraAccountError('unsupported')
  const rpId = globalThis.location.hostname
  const prfSalt = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(MERA_ACCOUNT_PRF_DOMAIN),
    ),
  )
  try {
    const mera = await import('@category-labs/mera')
    const result =
      action === 'create'
        ? await mera.createPasskeyWithPrfOutput({
            rp: { id: rpId, name: 'Frank' },
            user: { name: 'Frank account', displayName: 'Frank account' },
            prfSalt,
            webAuthnClient,
          })
        : await mera.getPasskeyPrfOutput({ rpId, prfSalt, webAuthnClient })
    if (result.prfOutput.length !== 32) {
      result.prfOutput.fill(0)
      throw new MeraAccountError('prf')
    }
    return result.prfOutput
  } catch (error) {
    if (error instanceof MeraAccountError) throw error
    const failure = error as {
      code?: string
      name?: string
      cause?: { name?: string }
    }
    if (failure.code === 'PRF_UNAVAILABLE') throw new MeraAccountError('prf')
    if (
      ['NotAllowedError', 'AbortError'].includes(failure.name ?? '') ||
      ['NotAllowedError', 'AbortError'].includes(failure.cause?.name ?? '')
    )
      throw new MeraAccountError('cancelled')
    if (failure.code === 'CRYPTO_UNAVAILABLE')
      throw new MeraAccountError('unsupported')
    throw new MeraAccountError('failed')
  } finally {
    prfSalt.fill(0)
  }
}
