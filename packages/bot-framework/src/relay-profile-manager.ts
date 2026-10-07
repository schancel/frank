import {
  fetchMonadProfile,
  registerMonadIdentityCbor,
  type MonadIdentity,
  type MonadProfileFields,
} from '@frank/wallet/monad-identity'
import type { BotProfile } from './types'

export class RelayProfileManager {
  static async registerProfile(params: {
    relayBaseUrl: string
    identity: MonadIdentity
    label: string
    profile: BotProfile
    force?: boolean
  }): Promise<void> {
    let avatarStr: string | undefined = undefined
    if (typeof params.profile.avatarPng === 'string') {
      avatarStr = params.profile.avatarPng
    } else if (params.profile.avatarPng instanceof Uint8Array) {
      avatarStr = `data:image/png;base64,${Buffer.from(
        params.profile.avatarPng,
      ).toString('base64')}`
    }

    const wanted: MonadProfileFields = {
      name: params.profile.name,
      bio: params.profile.bio,
      avatar: avatarStr,
      bot: params.profile.bot ?? true,
      accountType: params.profile.accountType,
      botRole: params.profile.botRole,
    }

    if (!params.force) {
      try {
        const existing = await fetchMonadProfile({
          relayBaseUrl: params.relayBaseUrl,
          address: params.identity.address,
        })
        if (
          existing &&
          (existing.name ?? '') === (wanted.name ?? '') &&
          (existing.bio ?? '') === (wanted.bio ?? '') &&
          (existing.bot ?? false) === (wanted.bot ?? false) &&
          existing.accountType === wanted.accountType &&
          existing.botRole === wanted.botRole
        ) {
          console.log(
            `[${params.label}] profile on relay already current (${params.identity.displayAddress})`,
          )
          return
        }
      } catch {
        // Continue to register if check fails
      }
    }

    await registerMonadIdentityCbor({
      relayBaseUrl: params.relayBaseUrl,
      identity: params.identity,
      profile: wanted,
    })
    console.log(
      `[${params.label}] registered profile on relay for ${params.identity.displayAddress} ("${wanted.name}")`,
    )
  }
}
