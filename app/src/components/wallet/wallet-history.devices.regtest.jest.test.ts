/** @jest-environment node */

/**
 * History agrees on every device of one account, on a real chain through the REAL relay binary.
 *
 * The chain is monad-solonet (the local `monad-regtest` network, packages/bot/demo/regtest), the
 * relay is the real cashwebd started on it by the regtest stack, and every device is a real
 * wallet with its own empty state directory (`openRealWallet`, packages/bot/demo/real-stack.ts).
 * History is read the way the wallet page reads it: `loadWalletHistory`, then
 * `buildWalletHistoryGroups`.
 *
 * Device one sends a paid message (its stamp) and a Send to Address. Device two of the same
 * account was open the whole time and reads its mailbox. A third device is opened afterwards
 * from the account's root alone ("restored from the seed") and reads the mailbox. Every device
 * shows both sends with amount, recipient, time and status.
 *
 * Runs only when FRANK_REGTEST_LIVE=1 (solonet must be up, see monad-regtest.ts; CASHWEBD_BIN
 * names a relay build, otherwise this worktree's Cargo build is used):
 *   FRANK_REGTEST_LIVE=1 CASHWEBD_BIN=/path/to/cashwebd-exe \
 *     yarn --cwd app jest src/components/wallet/wallet-history.devices.regtest.jest.test.ts
 *
 * Funds come from the solonet faucet and go back to it at the end (`returnToFaucet`).
 */
import { copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'

import type { NativeWalletHandle } from '@frank/wallet/chain'
import type { RealWallet } from '../../../../packages/bot/demo/real-stack'
import type { RegtestStack } from '../../../../packages/bot/demo/regtest/regtest-stack'
import {
  buildWalletHistoryGroups,
  loadWalletHistory,
  type WalletHistoryRow,
} from './wallet-history'

const live = process.env.FRANK_REGTEST_LIVE === '1' ? describe : describe.skip
const CHAIN = 'monad-regtest'
const ETHER = 10n ** 18n
const FUND_WEI = 50n * ETHER
const TRANSFER_WEI = 5n * 10n ** 16n // 0.05 MONR
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** What one History row says about a send, in the terms a person reads. */
interface SendLine {
  amountWei: string
  recipient: string
  purpose: string
  status: string
  timeMs: number | undefined
}

function sendLines(rows: readonly WalletHistoryRow[]): SendLine[] {
  return rows
    .flatMap((row): SendLine[] =>
      row.kind === 'native'
        ? [
            {
              amountWei: row.operation.intendedValueWei,
              recipient: row.operation.recipient.toLowerCase(),
              purpose: row.operation.purpose,
              status: row.operation.payment,
              timeMs: row.timeMs,
            },
          ]
        : row.kind === 'noted'
        ? [
            {
              amountWei: row.valueWei,
              recipient: row.recipient ?? '',
              purpose: row.purpose,
              status: row.state,
              timeMs: row.timeMs,
            },
          ]
        : [],
    )
    .sort((a, b) => a.purpose.localeCompare(b.purpose))
}

live('History on every device of one account (solonet, real relay)', () => {
  jest.setTimeout(900_000)
  let stack: RegtestStack
  const opened: RealWallet[] = []

  /** A device: a real wallet in its own copy of the wallet code (one process may hold an account
   * open only once) with its own state. A device after the first is given only the account root. */
  async function openDevice(
    name: string,
    sameAccountAs?: string,
  ): Promise<RealWallet> {
    const dir = join(stack.stateDir, 'devices', name)
    const label = sameAccountAs ? 'me' : name === 'peer' ? 'peer' : 'me'
    if (sameAccountAs) {
      mkdirSync(join(dir, 'wallets', 'me'), { recursive: true, mode: 0o700 })
      copyFileSync(
        join(
          stack.stateDir,
          'devices',
          sameAccountAs,
          'wallets',
          'me',
          'account-root.hex',
        ),
        join(dir, 'wallets', 'me', 'account-root.hex'),
      )
    }
    let open: (() => Promise<RealWallet>) | undefined
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const {
        openRealWallet,
      } = require('../../../../packages/bot/demo/real-stack')
      /* eslint-enable @typescript-eslint/no-var-requires */
      open = () =>
        openRealWallet({
          label,
          relayUrl: stack.relayUrl,
          stateDir: dir,
          network: { rpcChain: CHAIN, networkTag: 'MONR' },
        })
    })
    const wallet = await open!()
    opened.push(wallet)
    return wallet
  }

  /** Reads the device's whole mailbox, as the app's mailbox poll does from an empty store. */
  async function readMailbox(device: RealWallet) {
    await device.chain.directMessages.fetchSince({
      wallet: device.handle,
      sinceMs: 0,
    })
  }

  async function history(device: RealWallet) {
    const load = await loadWalletHistory(
      device.handle as unknown as NativeWalletHandle,
      CHAIN,
    )
    expect(load.status).toBe('available')
    const groups = buildWalletHistoryGroups({
      chainIdentifier: CHAIN,
      load,
      swaps: [],
    })
    return sendLines(groups.flatMap(group => group.rows))
  }

  /** Reads History until it shows `count` finished sends, each dated. */
  async function settledHistory(
    device: RealWallet,
    count: number,
    before?: () => Promise<void>,
  ) {
    const end = Date.now() + 180_000
    for (;;) {
      await before?.()
      const lines = await history(device)
      if (
        lines.length >= count &&
        lines.every(
          line => line.status === 'included' && line.timeMs !== undefined,
        )
      )
        return lines
      if (Date.now() > end)
        throw new Error(
          `${device.label} History did not settle: ${JSON.stringify(lines)}`,
        )
      await sleep(2000)
    }
  }

  beforeAll(async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const {
      startRegtestStack,
    } = require('../../../../packages/bot/demo/regtest/regtest-stack')
    /* eslint-enable @typescript-eslint/no-var-requires */
    stack = await startRegtestStack({ chains: [CHAIN] })
  })

  afterAll(async () => {
    for (const wallet of opened.reverse())
      await wallet.close().catch(() => undefined)
    if (stack) {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const {
        returnToFaucet,
      } = require('../../../../packages/bot/demo/regtest/monad-wallets')
      /* eslint-enable @typescript-eslint/no-var-requires */
      const swept = await returnToFaucet(stack)
      console.log(
        `returned ${swept.returnedWei} wei to the faucet; ${swept.leftWei} wei left`,
      )
      await stack.stop()
    }
  })

  it('a send on one device shows in the other device and in a restored device, dated', async () => {
    const monad = stack.chains[CHAIN]!
    const one = await openDevice('one')
    const two = await openDevice('two', 'one')
    const peer = await openDevice('peer')
    expect(two.address).toBe(one.address)
    await monad.fund(one.mainAccount, FUND_WEI)

    // A paid message: its stamp is a send of the account. Above the payment floor (ten times
    // what moving it costs at the node's price).
    const stampWei = 3n * 10n ** 16n
    const digest = await one.send(
      peer.address,
      [{ type: 'text', text: 'hello from one' }],
      stampWei,
    )
    // A Send to Address, back to the faucet.
    const faucet = (await import('ethers'))
      .computeAddress(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      )
      .toLowerCase()
    // Handed to the network: the app shows it pending until the chain has it (the error says
    // only that), and so does History until it is in a block. The stamp's coin is the account's only one until the chain has its successor: the
    // transfer waits for it, as a person pressing Send again would.
    for (let attempt = 0; ; attempt++) {
      const outcome = await one.chain.nativeTransfers
        .send({
          wallet: one.handle,
          recipient: { raw: faucet },
          value: TRANSFER_WEI,
        })
        .then(
          () => 'sent' as const,
          error => {
            if (error instanceof Error && 'operation' in error)
              return 'sent' as const
            if (
              error?.name === 'EvmTransactionSetInsufficientFundsError' &&
              attempt < 30
            )
              return 'wait' as const
            throw error
          },
        )
      if (outcome === 'sent') break
      await sleep(2000)
      // The wallet page reads the balance, which reads the coin list's accounts again.
      await one.handle.getBalance().catch(() => undefined)
    }

    // The sending device: both sends, each dated by its block.
    // The app's mailbox poll re-observes the wallet's own transfers and shares them; so does
    // this loop.
    const onOne = await settledHistory(one, 2, async () => {
      await one.handle.reobserveNativeOperations?.().catch(() => undefined)
      await one.handle.flushNativeSync?.().catch(() => undefined)
    })
    expect(onOne).toEqual([
      expect.objectContaining({
        purpose: 'stamp',
        amountWei: stampWei.toString(),
      }),
      expect.objectContaining({
        purpose: 'transfer',
        amountWei: TRANSFER_WEI.toString(),
        recipient: faucet,
      }),
    ])
    for (const line of onOne)
      expect(Math.abs(line.timeMs! - Date.now())).toBeLessThan(10 * 60_000)

    // The other device of the account: the same sends, read from the account's notes to itself.
    const onTwo = await settledHistory(two, 2, () => readMailbox(two))
    expect(onTwo.map(({ timeMs: _t, ...line }) => line)).toEqual(
      onOne.map(({ timeMs: _t, ...line }) => line),
    )
    for (const [index, line] of onTwo.entries())
      expect(line.timeMs).toBe(onOne[index]!.timeMs)

    // A device restored from the seed, opened after the sends: the same past sends.
    const restored = await openDevice('restored', 'one')
    const onRestored = await settledHistory(restored, 2, () =>
      readMailbox(restored),
    )
    expect(onRestored).toEqual(onTwo)

    // What the peer received goes back to the faucet with the rest.
    await peer.receive(message => message.payloadDigest === digest)
    await peer.handle
      .sweepReceivedCoins?.({ payloadDigests: [digest] })
      .catch(() => undefined)
  })
})
