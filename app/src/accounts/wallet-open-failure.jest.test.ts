import { walletOpenFailureKey } from './wallet-open-failure'
import { EvmRpcIdentityError } from './evm-wallet-verification'
import {
  RelayOperatorCheckpointUnavailableError,
  RelayWalletRouteUnavailableError,
} from './relay-wallet-route'
import { ChainUnreachableError } from '@frank/wallet/chain'
import enUS from '../i18n/en-us'
import frFR from '../i18n/fr-fr'

it.each([
  [
    new RelayOperatorCheckpointUnavailableError('monad-regtest'),
    'walletCheckpointUnavailable',
  ],
  [
    new EvmRpcIdentityError('EVM RPC checkpoint mismatch'),
    'walletIdentityUnverified',
  ],
  [
    new RelayWalletRouteUnavailableError('monad-regtest'),
    'walletRouteUnavailable',
  ],
  [new ChainUnreachableError(new Error('fetch failed')), 'walletUnreachable'],
  [new Error('anything else'), 'walletOpenFailed'],
] as const)('names an app-owned reason for %p', (error, key) => {
  expect(walletOpenFailureKey(error)).toBe(`sendAddressDialog.${key}`)
  expect(enUS.sendAddressDialog[key]).toEqual(expect.any(String))
  expect(frFR.sendAddressDialog[key]).toEqual(expect.any(String))
})
