import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { discoverEmailGateway } from '@frank/cashweb/relay/email-gateway-discovery'
import protocol from '../../../../docs/protocol/chains/v1.json'
import { getDefaultConfig, resolveDataDir } from '../config'

export interface MailDiscoverOptions {
  chain?: string
  relay?: string
  dataDir?: string
  json?: boolean
}

/** Read configuration without initializing storage or opening an account. */
function configuredRelay(dataDir?: string): string {
  const configPath = join(resolveDataDir(dataDir), 'config.json')
  const fallback = getDefaultConfig().relayUrl
  if (!existsSync(configPath)) return fallback
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      relayUrl?: string
    }
    return config.relayUrl ?? fallback
  } catch {
    return fallback
  }
}

export async function mailDiscoverCommand(
  options: MailDiscoverOptions,
): Promise<void> {
  if (
    !options.chain ||
    !protocol.chains.some(chain => chain.id === options.chain)
  )
    throw new Error(
      'mail discover requires --chain with a canonical chain identifier',
    )
  const gateway = await discoverEmailGateway({
    relayBaseUrl: options.relay ?? configuredRelay(options.dataDir),
    chainIdentifier: options.chain,
  })
  if (options.json) console.log(JSON.stringify(gateway))
  else if (gateway)
    console.log(`Email gateway: ${gateway.address}\nDomain: ${gateway.domain}`)
  else console.log('No email gateway advertised')
}
