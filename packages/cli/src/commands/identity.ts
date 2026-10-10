import * as bip39 from 'bip39'

import { fetchMonadProfile, MonadIdentity } from '@frank/wallet/monad-identity'
import {
  loadConfig,
  loadIdentity,
  resolveDataDir,
  saveIdentity,
} from '../config'
import { outputError, outputResult } from '../util'
import { cliAccountAddress } from '../account'

export interface IdentityCreateOptions {
  json?: boolean
  password?: string
  dataDir?: string
}

export interface IdentityShowOptions {
  json?: boolean
  address?: string
  password?: string
  dataDir?: string
}

export async function createIdentityCommand(
  options: IdentityCreateOptions,
): Promise<void> {
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const mnemonic = bip39.generateMnemonic()
    const identity = MonadIdentity.fromSeed({ mnemonic })

    const savedPath = await saveIdentity(dataDir, {
      identity,
      mnemonic,
      password: options.password,
    })

    const result = {
      address: identity.displayAddress,
      encryptionPublicKey: identity.compressedPubKey.toString('hex'),
      mnemonic,
      storagePath: savedPath,
      dataDir,
    }

    outputResult(
      result,
      () => {
        console.log('Generated new identity:')
        console.log(`  Public Address:         ${result.address}`)
        console.log(`  Encryption Public Key:  ${result.encryptionPublicKey}`)
        console.log(`  Mnemonic Seed:          ${result.mnemonic}`)
        console.log(`  Keystore Path:          ${result.storagePath}`)
        console.log(
          '\nIMPORTANT: Save your mnemonic seed in a secure location. It is required to recover your wallet.',
        )
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}

export async function showIdentityCommand(
  options: IdentityShowOptions,
): Promise<void> {
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const config = loadConfig(dataDir)
    const { address, encryptionPublicKey, identity } = await loadIdentity(
      dataDir,
      options.address,
      options.password,
    )

    let profile = null
    try {
      const fetched = await fetchMonadProfile({
        relayBaseUrl: config.relayUrl,
        address: identity.address,
      })
      if (fetched) {
        profile = {
          name: fetched.name,
          bio: fetched.bio,
          avatar: fetched.avatar,
          bot: fetched.bot,
          pubKey: Buffer.from(fetched.pubKey).toString('hex'),
        }
      }
    } catch {
      // Profile fetch can fail if relay is unreachable; show as unregistered
    }

    const result = {
      address,
      encryptionPublicKey,
      relayUrl: config.relayUrl,
      registered: profile !== null,
      profile,
      // Messages are sent and received as a separate account with its own address.
      messagingAddress: cliAccountAddress(dataDir) ?? null,
    }

    outputResult(
      result,
      () => {
        console.log('Active Identity:')
        console.log(`  Address:                ${result.address}`)
        console.log(`  Encryption Public Key:  ${result.encryptionPublicKey}`)
        console.log(`  Relay URL:              ${result.relayUrl}`)
        console.log(
          `  Messaging Address:      ${
            result.messagingAddress ?? '(created by the first send or inbox)'
          }`,
        )
        console.log(
          '    Messages use this separate account, not the address above: give this one to',
        )
        console.log(
          '    correspondents, and fund its own main address (shown by a failed paid send).',
        )
        if (result.profile) {
          console.log(`  Relay Profile:          Registered`)
          if (result.profile.name)
            console.log(`    Name:                 ${result.profile.name}`)
          if (result.profile.bio)
            console.log(`    Bio:                  ${result.profile.bio}`)
          if (result.profile.bot !== undefined)
            console.log(`    Bot:                  ${result.profile.bot}`)
        } else {
          console.log(
            `  Relay Profile:          Not registered on ${result.relayUrl}`,
          )
        }
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}
