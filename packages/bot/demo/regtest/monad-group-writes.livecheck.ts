/**
 * Paid group writes, checked for real: two real relays (A hosts the group, B is another relay)
 * on a local Monad network (monad-solonet), and payments signed by the solonet faucet. Costs
 * nothing and needs no `.env`.
 *
 *   yarn --cwd packages/bot regtest:monad-group-writes
 *
 * Checks, in order:
 * - underpaid, wrong-payee, wrong-chain and wrong-commitment payments are refused with 402 and
 *   their reason, and no sequence is consumed;
 * - a payment at a nonce already used is refused with 402 `group_payment_unfunded`
 *   (`stale_nonce`) after the host reads the payer's account from the chain; a payer without
 *   the balance, or a nonce past the host's window, is deferred with a retryable 503
 *   `group_payment_not_ready`; no sequence is consumed;
 * - a payment for a write on A is refused by B (`wrong_commitment`) and B stores nothing;
 * - one paid write sent twice to A and once to B at the same moment gives one append: one
 *   `appended` and one `existing` answer with the same receipt from A, and a refusal from B;
 * - a retry returns the original receipt; the payment is broadcast by A after the commit and
 *   mined;
 * - an unfunded payer's write is deferred, then accepted with the same bytes after a deposit;
 * - a payment two nonces above the payer's pending one (behind its own self-sends) is accepted,
 *   and lands once the writer broadcasts its predecessors;
 * - the real writer path: a funded Frank wallet pays a write through `deliverPaidGroupWrite`
 *   (sign, store, submit to A, then authorize and broadcast the whole set in nonce order) and
 *   the payment, wherever construction shuffled it among its self-sends, is mined.
 *
 * Not covered here: a home relay proxying to the host (the production binary proxies only to
 * public addresses, so two local relays cannot; `cargo test -p cashweb-registry groups` covers it
 * with loopback routers), and two replicas of one cluster sharing a store, which arrives with
 * the cluster storage work.
 *
 * The first run starts the VM and the chain (5 to 8 minutes, see monad-regtest.ts); later runs
 * reuse them. Not part of CI.
 */
import assert from 'assert'

import { Transaction, Wallet, getAddress, hexlify } from 'ethers'

import {
  GroupRelayClient,
  createGroupOnRelay,
  sealGroupMessage,
  type SealedGroupMessageEnvelope,
} from '../../../cashweb/groups'
import {
  GROUP_TEST_ACCOUNTS,
  groupTestSigningKey,
} from '../../../cashweb/groups/group-test.testutil'
import { bytesToHex, groupWritePaymentPlan } from '../../../cashweb/groups'
import { MONAD_REGTEST_CHAIN, MONAD_REGTEST_CHAIN_ID } from './monad-regtest'
import { monadOf, openMonadWallet } from './monad-wallets'
import { deliverPaidGroupWrite } from '../../../group-messaging/groups/write-payment'
import type { StoredGroupWritePayment } from '../../../cashweb/groups/group-write-payment'
import { startRegtestStack } from './regtest-stack'

/** The relay's `PAYMENT_NONCE_WINDOW` (`cashweb-registry/src/http/groups/payment.rs`). */
const PAYMENT_NONCE_WINDOW = 63

interface Answer {
  status: number
  disposition: string | null
  body: Record<string, unknown>
}

async function put(
  relayUrl: string,
  groupId: string,
  envelope: SealedGroupMessageEnvelope,
  payment: { network: string; raw_transaction: string } | undefined,
  upstream?: string,
): Promise<Answer> {
  const response = await fetch(`${relayUrl}/groups/${groupId}/messages`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(upstream ? { 'x-group-upstream-relay': upstream } : {}),
    },
    body: JSON.stringify({
      group_id: groupId,
      ...envelope,
      ...(payment ? { payment } : {}),
    }),
  })
  return {
    status: response.status,
    disposition: response.headers.get('x-group-append-disposition'),
    body: (await response.json()) as Record<string, unknown>,
  }
}

async function main() {
  const startedAt = Date.now()
  const stack = await startRegtestStack({
    chains: [MONAD_REGTEST_CHAIN],
    relays: 2,
  })
  try {
    const [hostUrl, otherUrl] = stack.relayUrls as [string, string]
    const monad = monadOf(stack)
    console.log(
      `relays up in ${Math.round(
        (Date.now() - startedAt) / 1000,
      )} s: host ${hostUrl}, other ${otherUrl}`,
    )

    const host = new GroupRelayClient(hostUrl)
    const [alice, bob, charlie] = GROUP_TEST_ACCOUNTS
    const created = await createGroupOnRelay({
      client: host,
      groupName: 'Paid writes',
      creatorAddress: alice!.address,
      creatorIdentityPubKeyHex: alice!.publicKeyHex,
      members: [bob!, charlie!],
    })
    const id = created.identity.groupIdHex
    const seal = (text: string) =>
      sealGroupMessage({
        epochKeys: created.epochKeys,
        senderIndex: 1,
        senderEpochKeyPair: groupTestSigningKey(
          bob!.address,
          id,
          created.epochKeys.epoch,
        ),
        senderAddress: bob!.address,
        payload: text,
        timestampMs: Date.now(),
      })
    const messages = async () =>
      (await host.fetchGroupMessages(id, created.epochKeys.readTokenHex, 0, 50))
        .messages

    const policy = await host.getWritePolicy(id)
    assert.equal(policy.network, MONAD_REGTEST_CHAIN)
    assert.equal(policy.hostOrigin, hostUrl)
    console.log(
      `host policy: ${policy.priceWei} wei on ${
        policy.network
      } to ${JSON.stringify(policy.payee)}`,
    )

    const payer: Wallet = monad.faucet.connect(monad.provider)
    const feeData = await monad.provider.getFeeData()
    const sign = async (
      plan: ReturnType<typeof groupWritePaymentPlan>,
      overrides: {
        to?: string
        value?: bigint
        chainId?: bigint
        nonceOffset?: number
        signer?: Wallet
      } = {},
    ) => {
      const signer = overrides.signer ?? payer
      const tx = Transaction.from({
        type: 2,
        chainId: overrides.chainId ?? MONAD_REGTEST_CHAIN_ID,
        nonce:
          (await monad.provider.getTransactionCount(
            signer.address,
            'pending',
          )) + (overrides.nonceOffset ?? 0),
        to: overrides.to ?? plan.destination,
        value: overrides.value ?? plan.amountWei,
        data: hexlify(plan.calldata),
        gasLimit: 30_000n,
        maxFeePerGas: feeData.maxFeePerGas! * 2n,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1n,
      })
      tx.signature = signer.signingKey.sign(tx.unsignedHash)
      return {
        network: plan.network,
        raw_transaction: tx.serialized.slice(2),
        hash: tx.hash!,
      }
    }
    const wire = ({
      network,
      raw_transaction,
    }: {
      network: string
      raw_transaction: string
    }) => ({
      network,
      raw_transaction,
    })

    // Funded first: the faucet signs the payments below by hand at its pending nonce. Above
    // Monad's reserve balance, so the wallet's set is not held to a quiet spend window.
    const writer = await openMonadWallet(stack, 'group-writer')
    await monad.fund(writer.mainAccount, 20n * 10n ** 18n)
    await monad.mine(6)

    // Refusals: nothing stored, no sequence consumed.
    const envelope = seal('paid write')
    const plan = groupWritePaymentPlan(policy, id, envelope)
    const otherPlan = groupWritePaymentPlan(policy, id, seal('another write'))
    const refusals: Array<
      [string, Awaited<ReturnType<typeof sign>> | undefined, string]
    > = [
      ['missing', undefined, 'missing'],
      [
        'underpaid',
        await sign(plan, { value: plan.amountWei - 1n }),
        'underpaid',
      ],
      [
        'wrong payee',
        await sign(plan, { to: getAddress(`0x${'12'.repeat(20)}`) }),
        'wrong_payee',
      ],
      ['wrong chain', await sign(plan, { chainId: 10143n }), 'wrong_chain'],
      ['wrong commitment', await sign(otherPlan), 'wrong_commitment'],
      ['used nonce', await sign(plan, { nonceOffset: -1 }), 'stale_nonce'],
    ]
    for (const [label, payment, reason] of refusals) {
      const answer = await put(hostUrl, id, envelope, payment && wire(payment))
      assert.equal(
        answer.status,
        402,
        `${label}: ${JSON.stringify(answer.body)}`,
      )
      assert.equal(
        answer.body.reason,
        reason,
        `${label}: ${JSON.stringify(answer.body)}`,
      )
      assert.equal(
        answer.body.error === 'group_payment_unfunded',
        reason === 'stale_nonce',
        `${label}: ${JSON.stringify(answer.body)}`,
      )
      console.log(`${label}: 402 ${answer.body.error} (${answer.body.reason})`)
    }
    // Not refusals: the node does not show yet that the payment can land. Retryable, nothing
    // stored, the writer keeps the write pending.
    const deferrals: Array<[string, Awaited<ReturnType<typeof sign>>, string]> =
      [
        [
          'empty payer',
          await sign(plan, {
            signer: Wallet.createRandom() as unknown as Wallet,
          }),
          'insufficient_balance',
        ],
        [
          'nonce past the window',
          await sign(plan, { nonceOffset: PAYMENT_NONCE_WINDOW + 1 }),
          'nonce_gap',
        ],
      ]
    for (const [label, payment, reason] of deferrals) {
      const answer = await put(hostUrl, id, envelope, wire(payment))
      assert.equal(
        answer.status,
        503,
        `${label}: ${JSON.stringify(answer.body)}`,
      )
      assert.equal(answer.body.error, 'group_payment_not_ready', label)
      assert.equal(answer.body.reason, reason, label)
      console.log(`${label}: 503 ${answer.body.error} (${answer.body.reason})`)
    }
    assert.deepEqual(
      await messages(),
      [],
      'no refused write consumed a sequence',
    )

    const paid = await sign(plan)
    // A replay of the host's payment on another relay, as that relay's own write.
    const replay = await put(otherUrl, id, envelope, wire(paid))
    assert.equal(replay.status, 402, JSON.stringify(replay.body))
    assert.equal(replay.body.reason, 'wrong_commitment')
    console.log(`replay on the other relay: 402 (${replay.body.reason})`)
    assert.deepEqual(
      await messages(),
      [],
      'no refused write consumed a sequence',
    )

    // The same paid write, twice to the host and once to the other relay, at once.
    const [first, second, elsewhere] = await Promise.all([
      put(hostUrl, id, envelope, wire(paid)),
      put(hostUrl, id, envelope, wire(paid)),
      put(otherUrl, id, envelope, wire(paid)),
    ])
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.deepEqual(
      first.body,
      second.body,
      'both answers carry the one receipt',
    )
    assert.deepEqual([first.disposition, second.disposition].sort(), [
      'appended',
      'existing',
    ])
    assert.equal(elsewhere.status, 402, JSON.stringify(elsewhere.body))
    assert.equal(elsewhere.body.reason, 'wrong_commitment')
    const stored = await messages()
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.server_seq, 1)
    console.log(
      `one write sent at once twice to the host and once elsewhere: one append (seq ${
        stored[0]!.server_seq
      }), answers ${first.disposition}/${second.disposition}/${
        elsewhere.status
      }`,
    )
    const direct = first

    // A retry returns the original receipt and hands nothing new to the chain.
    const retried = await put(hostUrl, id, envelope, wire(paid))
    assert.equal(retried.status, 200)
    assert.equal(retried.disposition, 'existing')
    assert.deepEqual(retried.body, direct.body)

    // Broadcast by the host after the commit: the writer never sent it to the chain.
    const receipt = await monad.provider.waitForTransaction(
      paid.hash,
      1,
      60_000,
    )
    assert(receipt, 'the payment was mined')
    assert.equal(receipt.status, 1)
    const mined = await monad.provider.getTransaction(paid.hash)
    assert.equal(mined!.to, plan.destination)
    assert.equal(mined!.value, plan.amountWei)
    assert.equal(mined!.data, `0x${bytesToHex(plan.calldata)}`)
    console.log(
      `payment ${paid.hash} broadcast by the host and mined in block ${receipt.blockNumber}`,
    )

    // A payer without funds yet is deferred; once a deposit lands, the same bytes are accepted.
    const late = Wallet.createRandom() as unknown as Wallet
    const lateEnvelope = seal('paid once funded')
    const latePayment = await sign(
      groupWritePaymentPlan(policy, id, lateEnvelope),
      { signer: late },
    )
    const early = await put(hostUrl, id, lateEnvelope, wire(latePayment))
    assert.equal(early.status, 503, JSON.stringify(early.body))
    assert.equal(early.body.reason, 'insufficient_balance')
    await monad.fund(late.address, 10n ** 17n)
    // Monad checks a new transaction against state a few blocks behind the head, and a node
    // that turned a transaction down keeps turning the same bytes down, so the deposit is let
    // settle before the write is retried.
    await monad.mine(6)
    // Retried as the writer does, until the host's node shows the deposit.
    let funded = await put(hostUrl, id, lateEnvelope, wire(latePayment))
    for (let attempt = 0; funded.status === 503 && attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      funded = await put(hostUrl, id, lateEnvelope, wire(latePayment))
    }
    assert.equal(funded.status, 200, JSON.stringify(funded.body))
    assert.equal(funded.disposition, 'appended')
    // The writer broadcasts its payment once the host holds the write, as the wallet does.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await monad.provider.getTransactionReceipt(latePayment.hash)) break
      await monad.provider
        .broadcastTransaction(`0x${latePayment.raw_transaction}`)
        .catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    const lateReceipt = await monad.provider.waitForTransaction(
      latePayment.hash,
      1,
      60_000,
    )
    assert.equal(lateReceipt?.status, 1)
    console.log(
      `unfunded payer: 503 insufficient_balance, then the same bytes after a deposit: seq ${
        funded.body.server_seq
      }, payment mined in block ${lateReceipt!.blockNumber}`,
    )

    // The wallet shuffles a payment among its own self-sends on the same account, and a set
    // can follow a predecessor set not yet landed ([account, n+1] is claimed at reservation),
    // so the payment can sit above the pending nonce. Here two self-sends precede it: the host
    // accepts it, the writer then broadcasts all of its own transactions in nonce order, and
    // the payment lands.
    const base = await monad.provider.getTransactionCount(
      payer.address,
      'pending',
    )
    const behindEnvelope = seal('behind self-sends')
    const behind = await sign(
      groupWritePaymentPlan(policy, id, behindEnvelope),
      { nonceOffset: 2 },
    )
    const held = await put(hostUrl, id, behindEnvelope, wire(behind))
    assert.equal(held.status, 200, JSON.stringify(held.body))
    assert.equal(held.disposition, 'appended')
    for (const nonce of [base, base + 1]) {
      const selfSend = Transaction.from({
        type: 2,
        chainId: MONAD_REGTEST_CHAIN_ID,
        nonce,
        to: payer.address,
        value: 1n,
        gasLimit: 21_000n,
        maxFeePerGas: feeData.maxFeePerGas! * 2n,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1n,
      })
      selfSend.signature = payer.signingKey.sign(selfSend.unsignedHash)
      await monad.provider.broadcastTransaction(selfSend.serialized)
    }
    await monad.provider
      .broadcastTransaction(`0x${behind.raw_transaction}`)
      .catch(() => undefined) // the host may already have handed it on
    const behindReceipt = await monad.provider.waitForTransaction(
      behind.hash,
      1,
      60_000,
    )
    assert.equal(behindReceipt?.status, 1)
    console.log(
      `payment at pending nonce + 2 accepted (seq ${
        held.body.server_seq
      }); after its predecessors it was mined in block ${
        behindReceipt!.blockNumber
      }`,
    )

    // The real writer path: a Frank wallet signs, stores, submits to the host, and only then
    // authorizes and broadcasts its payment.
    try {
      await writer.handle.refreshTransactionSetInventory?.()
      const walletWrite = async (text: string) => {
        const written = seal(text)
        let record: StoredGroupWritePayment | undefined
        const delivery = await deliverPaidGroupWrite({
          groupIdHex: id,
          envelope: written,
          stored: record,
          policy: () => host.getWritePolicy(id),
          persist: async next => {
            record = next
          },
          wallet: writer.handle,
          submit: payment => host.sendGroupMessage(id, written, payment),
        })
        assert.equal(delivery.state, 'delivered')
        assert(delivery.state === 'delivered' && delivery.settled)
        return {
          seq: delivery.receipt.server_seq,
          payment: Transaction.from(`0x${record!.rawTransaction}`),
        }
      }
      // The payment sits among the set's own self-sends on its account in random order, so
      // its nonce may be above the account's pending one; the host accepts it within its
      // window and the wallet broadcasts the whole set in nonce order after that.
      const { seq, payment } = await walletWrite('written by a wallet')
      const receipt = await monad.provider.waitForTransaction(
        payment.hash!,
        1,
        60_000,
      )
      assert(receipt, 'the wallet payment was mined')
      assert.equal(receipt.status, 1)
      console.log(
        `wallet write: seq ${seq}, payment ${payment.hash} at nonce ${payment.nonce} of its account mined in block ${receipt.blockNumber}`,
      )
      assert.equal((await messages()).length, 4)
    } finally {
      await writer.close()
    }
  } finally {
    await stack.stop()
  }
  console.log(
    `Paid group writes on monad-regtest: OK (${Math.round(
      (Date.now() - startedAt) / 1000,
    )} s; the chain keeps running, stop it with regtest:monad-stop)`,
  )
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    err => {
      console.error(err)
      process.exit(1)
    },
  )
}
