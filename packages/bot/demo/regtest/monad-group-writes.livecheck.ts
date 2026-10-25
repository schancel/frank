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
 * - payments that cannot land now (an empty payer, a nonce already used, a nonce ahead of the
 *   payer's next one) are refused with 402 `group_payment_unfunded` after the host reads the
 *   payer's account from the chain, and no sequence is consumed;
 * - a payment for a write on A is refused by B (`wrong_commitment`) and B stores nothing;
 * - one paid write sent twice to A and once to B at the same moment gives one append: one
 *   `appended` and one `existing` answer with the same receipt from A, and a refusal from B;
 * - a retry returns the original receipt; the payment is broadcast by A after the commit and
 *   mined;
 * - the real writer path: a funded Frank wallet pays a write through `deliverPaidGroupWrite`
 *   (sign, store, submit to A, then authorize and broadcast) and the payment is mined.
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

    // Refusals: nothing stored, no sequence consumed.
    // Funded first: the faucet signs the payments below by hand at its pending nonce.
    const writer = await openMonadWallet(stack, 'group-writer')
    await monad.fund(writer.mainAccount, 10n ** 17n)
    await monad.mine(6)

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
      [
        'empty payer',
        await sign(plan, {
          signer: Wallet.createRandom() as unknown as Wallet,
        }),
        'insufficient_balance',
      ],
      ['used nonce', await sign(plan, { nonceOffset: -1 }), 'stale_nonce'],
      ['nonce ahead', await sign(plan, { nonceOffset: 3 }), 'nonce_gap'],
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
      const funding = ['insufficient_balance', 'stale_nonce', 'nonce_gap']
      assert.equal(
        answer.body.error === 'group_payment_unfunded',
        funding.includes(reason),
        `${label}: ${JSON.stringify(answer.body)}`,
      )
      console.log(`${label}: 402 ${answer.body.error} (${answer.body.reason})`)
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

    // The real writer path: a Frank wallet signs, stores, submits to the host, and only then
    // authorizes and broadcasts its payment.
    try {
      await writer.handle.refreshTransactionSetInventory?.()
      const written = seal('written by a wallet')
      let record: StoredGroupWritePayment | undefined
      const order: string[] = []
      const delivery = await deliverPaidGroupWrite({
        groupIdHex: id,
        envelope: written,
        stored: record,
        policy: () => host.getWritePolicy(id),
        persist: async next => {
          record = next
        },
        wallet: writer.handle,
        submit: async payment => {
          order.push('relay')
          return host.sendGroupMessage(id, written, payment)
        },
      })
      assert.equal(delivery.state, 'delivered')
      assert(delivery.state === 'delivered' && delivery.settled)
      const writtenHash = Transaction.from(`0x${record!.rawTransaction}`).hash!
      const writtenReceipt = await monad.provider.waitForTransaction(
        writtenHash,
        1,
        60_000,
      )
      assert(writtenReceipt, 'the wallet payment was mined')
      assert.equal(writtenReceipt.status, 1)
      assert.equal((await messages()).length, 2)
      console.log(
        `wallet write: seq ${delivery.receipt.server_seq}, payment ${writtenHash} mined in block ${writtenReceipt.blockNumber}`,
      )
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
