import { mnemonicToSeedSync } from 'bip39'

import { walletXprivFromSeedHex } from '../utils/wallet-xpriv'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: Worker = self as any

ctx.addEventListener('message', function (event) {
  const hexSeed = mnemonicToSeedSync(event.data).toString('hex')
  ctx.postMessage(walletXprivFromSeedHex(hexSeed))
})
