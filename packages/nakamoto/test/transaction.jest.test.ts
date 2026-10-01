import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'

import { sha256 } from '@noble/hashes/sha256.js'

import { concatBytes, reverseBytes } from '../src/bytes.js'
import {
  BCH_MAINNET,
  BTC_MAINNET,
  XEC_MAINNET,
  XPI_MAINNET,
} from '../src/chain/index.js'
import {
  internalHashFromBytes,
  type InternalHash,
} from '../src/constructors.js'
import {
  SIGHASH_ALL,
  SIGHASH_FORKID,
  SIGHASH_LOTUS,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  SIGHASH_UTXOS,
  blockMerkleLeaf,
  parseTransaction,
  serializeTransaction,
  sighash,
  transactionHash,
  transactionId,
  type SpentOutput,
  type Transaction,
  type TxInput,
  type TxOutput,
} from '../src/transaction.js'

const requireOld = createRequire(__filename)
const oldTx = requireOld('bitcore-lib-xpi') as {
  Transaction: new (serialized: Buffer) => {
    _getHash(): Buffer
    _getTxid(): Buffer
    hash: string
    txid: string
  }
  crypto: {
    Hash: { sha256sha256(bytes: Buffer): Buffer }
  }
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex')
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Bitcoin Core prints uint256 with GetHex, which reverses the raw hash. */
function display(bytes: Uint8Array): string {
  return toHex(reverseBytes(bytes))
}

function mustTx(bytes: Uint8Array, chain = BTC_MAINNET): Transaction {
  const parsed = parseTransaction(bytes, chain)
  if (!parsed.ok) throw new Error(parsed.error.code)
  return parsed.value
}

function hashed(
  tx: Transaction,
  index: number,
  chain: typeof BTC_MAINNET,
  hashType: number,
  algorithm: 'legacy' | 'bip143' | 'bip341' | 'forkid' | 'lotus',
  extra: {
    scriptCode?: Uint8Array
    amount?: bigint
    spent?: readonly SpentOutput[]
    commitUtxos?: boolean
    executedScriptHash?: Uint8Array
  } = {},
) {
  const result = sighash(tx, index, chain, hashType, {
    algorithm,
    ...extra,
  })
  if (!result.ok) throw new Error(`${result.error.code} type ${hashType}`)
  return result.value
}

/** Bitcoin Core sighash.json stores GetHex, the reversal of the raw digest. */
function digest(
  tx: Transaction,
  index: number,
  chain: typeof BTC_MAINNET,
  hashType: number,
  algorithm: 'legacy' | 'bip143' | 'bip341' | 'forkid' | 'lotus',
  extra: {
    scriptCode?: Uint8Array
    amount?: bigint
    spent?: readonly SpentOutput[]
    commitUtxos?: boolean
    executedScriptHash?: Uint8Array
  } = {},
): string {
  return display(hashed(tx, index, chain, hashType, algorithm, extra))
}

const BIP143_UNSIGNED =
  '010000000169c12106097dc2e0526493ef67f21269fe888ef05c7a3a5dacab38e1ac8387f14c1d000000ffffffff0101000000000000000000000000'
const BIP143_SCRIPT =
  'ad4830450220487fb382c4974de3f7d834c1b617fe15860828c7f96454490edd6d891556dcc9022100baf95feb48f845d5bfc9882eb6aeefa1bc3790e39f59eaa46ff7f15ae626c53e01'
const BIP143_SIGNED =
  '0100000000010169c12106097dc2e0526493ef67f21269fe888ef05c7a3a5dacab38e1ac8387f14c1d000000ffffffff01010000000000000000034830450220487fb382c4974de3f7d834c1b617fe15860828c7f96454490edd6d891556dcc9022100baf95feb48f845d5bfc9882eb6aeefa1bc3790e39f59eaa46ff7f15ae626c53e012102a9781d66b61fb5a7ef00ac5ad5bc6ffc78be7b44a566e3c87870e1079368df4c4aad4830450220487fb382c4974de3f7d834c1b617fe15860828c7f96454490edd6d891556dcc9022100baf95feb48f845d5bfc9882eb6aeefa1bc3790e39f59eaa46ff7f15ae626c53e0100000000'

describe('transaction bytes', () => {
  test('a BTC witness transaction keeps the marker and BCH does not', () => {
    const signed = mustTx(fromHex(BIP143_SIGNED))
    expect(signed.inputs[0]?.witness?.length).toBe(3)
    const btc = serializeTransaction(signed, BTC_MAINNET)
    if (!btc.ok) throw new Error(btc.error.code)
    expect(toHex(btc.value)).toBe(BIP143_SIGNED)
    expect(btc.value[4]).toBe(0x00)
    expect(btc.value[5]).toBe(0x01)
    expect(serializeTransaction(signed, BCH_MAINNET)).toEqual({
      ok: false,
      error: { code: 'tx-witness-rejected' },
    })
    const legacy = mustTx(fromHex(BIP143_UNSIGNED), BCH_MAINNET)
    const bch = serializeTransaction(legacy, BCH_MAINNET)
    if (!bch.ok) throw new Error(bch.error.code)
    expect(toHex(bch.value)).toBe(BIP143_UNSIGNED)
    expect(bch.value[4]).not.toBe(0x00)
    const asBtc = serializeTransaction(legacy, BTC_MAINNET)
    if (!asBtc.ok) throw new Error(asBtc.error.code)
    expect(toHex(asBtc.value)).toBe(BIP143_UNSIGNED)
    const parsedBch = parseTransaction(fromHex(BIP143_SIGNED), BCH_MAINNET)
    expect(parsedBch.ok).toBe(false)
  })

  test('trailing bytes and a non-witness flag are rejected', () => {
    const extra = fromHex(`${BIP143_UNSIGNED}00`)
    expect(parseTransaction(extra, BTC_MAINNET).ok).toBe(false)
    expect(
      parseTransaction(Uint8Array.of(1, 0, 0, 0, 0, 2), BTC_MAINNET),
    ).toEqual({
      ok: false,
      error: { code: 'tx-witness-flag' },
    })
  })

  test('empty-witness-not-canonical', () => {
    const txid = brand(new Uint8Array(32))
    const input = {
      prevout: { txid, vout: 0 },
      scriptSig: new Uint8Array(),
      sequence: 0xffffffff,
    }
    const output = { value: 0n, scriptPubKey: new Uint8Array() }
    const emptyStack: readonly Uint8Array[] = []
    const marked: Transaction = {
      version: 1,
      locktime: 0,
      inputs: [{ ...input, witness: emptyStack }],
      outputs: [output],
    }
    const legacy: Transaction = {
      version: 1,
      locktime: 0,
      inputs: [input],
      outputs: [output],
    }
    const encoded = serializeTransaction(marked, BTC_MAINNET)
    const plain = serializeTransaction(legacy, BTC_MAINNET)
    expect(encoded).toEqual(plain)
    if (!plain.ok) throw new Error(plain.error.code)
    expect(toHex(plain.value)).toBe(
      '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff0100000000000000000000000000',
    )
    expect(plain.value[4]).toBe(0x01)
    expect(
      parseTransaction(
        fromHex(
          '0100000000010100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff010000000000000000000000000000',
        ),
        BTC_MAINNET,
      ),
    ).toEqual({
      ok: false,
      error: { code: 'tx-witness-superfluous' },
    })
    const pushed = serializeTransaction(
      {
        ...marked,
        inputs: [{ ...input, witness: [new Uint8Array()] }],
      },
      BTC_MAINNET,
    )
    if (!pushed.ok) throw new Error(pushed.error.code)
    expect(pushed.value[4]).toBe(0x00)
    expect(pushed.value[5]).toBe(0x01)
    const round = parseTransaction(pushed.value, BTC_MAINNET)
    if (!round.ok) throw new Error(round.error.code)
    expect(round.value.inputs[0]?.witness).toEqual([new Uint8Array()])
    expect(serializeTransaction(marked, BCH_MAINNET)).toEqual(
      serializeTransaction(legacy, BCH_MAINNET),
    )
  })

  test('legacy-empty-vin', () => {
    const bytes = fromHex('01000000000000000000')
    const parsed = parseTransaction(bytes, BTC_MAINNET)
    expect(parsed).toEqual({
      ok: true,
      value: { version: 1, inputs: [], outputs: [], locktime: 0 },
    })
    if (!parsed.ok) throw new Error(parsed.error.code)
    const encoded = serializeTransaction(parsed.value, BTC_MAINNET)
    if (!encoded.ok) throw new Error(encoded.error.code)
    expect(toHex(encoded.value)).toBe('01000000000000000000')
    expect(
      parseTransaction(Uint8Array.of(1, 0, 0, 0, 0, 0), BTC_MAINNET),
    ).toEqual({
      ok: false,
      error: { code: 'tx-truncated' },
    })
    expect(
      parseTransaction(fromHex('010000000001000000000000'), BTC_MAINNET),
    ).toEqual({
      ok: false,
      error: { code: 'tx-witness-superfluous' },
    })
    expect(
      parseTransaction(
        fromHex('01000000000100000000000000000000000000'),
        BTC_MAINNET,
      ),
    ).toEqual({
      ok: false,
      error: { code: 'tx-trailing' },
    })
    expect(parseTransaction(bytes, BCH_MAINNET)).toEqual({
      ok: true,
      value: { version: 1, inputs: [], outputs: [], locktime: 0 },
    })
  })
})

const BARE_LEGACY =
  '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff0000000000'

describe('sighash', () => {
  test('legacy-pushdata4-dos', () => {
    const tx = mustTx(fromHex(BARE_LEGACY))
    // The trailing ab sits past GetOp's cursor, so it is not hashed.
    const truncated = digest(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
      scriptCode: fromHex('4effffffffab'),
    })
    expect(truncated).toBe(
      'c4d9b92d6e2300769db07edecf9fa3b2beab7892fa1829e37912eb314257f5fc',
    )
    const pushed = digest(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
      scriptCode: fromHex('4e00000080'),
    })
    expect(pushed).toBe(
      '9ccadf2c9a41a8f1b426315e1d333a314d909138ddfab593f2f2c3e599996272',
    )
    expect(
      digest(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
        scriptCode: fromHex('ab4e00000080'),
      }),
    ).toBe(pushed)
    expect(
      digest(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
        scriptCode: fromHex('4e01000000ff'),
      }),
    ).toBe('c0605714b38195694e8056a689f2db24fe4ed3bfd1588f85809336c5f7ee6648')
  })

  test('legacy truncated push omits the unread tail', () => {
    const tx = mustTx(fromHex(BARE_LEGACY))
    // Bitcoin Core GetOp returns before an unread push payload.
    // SerializeScriptCode hashes only through that cursor.
    // bitcoin/bitcoin src/script/interpreter.cpp (master, read 2026-09-30).
    const dropped = digest(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
      scriptCode: fromHex('02ff'),
    })
    expect(dropped).toBe(
      'c812f137b51400c5180a5e94beef28a7b5fa9f18f94d5ab5140cc76c7c2ad51a',
    )
    expect(
      digest(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
        scriptCode: fromHex('4e00000080ff'),
      }),
    ).toBe('229e8e5e585db3361ce312026c159536150810b663c31f040532af00c89f167e')
    expect(
      digest(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
        scriptCode: fromHex('ab02ff'),
      }),
    ).toBe(dropped)
  })

  test('Bitcoin Core legacy vectors match GetHex', () => {
    const rows = JSON.parse(
      readFileSync(
        join(__dirname, 'fixtures/bitcoin-core-sighash.json'),
        'utf8',
      ),
    ) as [string, string, number, number, string][]
    rows.slice(1).forEach((row, index) => {
      const tx = mustTx(fromHex(row[0]))
      const got = digest(tx, row[2], BTC_MAINNET, row[3], 'legacy', {
        scriptCode: fromHex(row[1]),
      })
      if (got !== row[4]) {
        throw new Error(`legacy vector ${index + 1}: ${got} != ${row[4]}`)
      }
    })
  })

  test('the old package fork-id rows match BCH and XEC, and not XPI', () => {
    const rows = JSON.parse(
      readFileSync(
        join(__dirname, '../../bitcore-lib-xpi/test/data/sighash.json'),
        'utf8',
      ),
    ) as unknown[]
    const header = rows.findIndex(
      row =>
        Array.isArray(row) &&
        row.length === 1 &&
        row[0] === 'Test vectors for SIGHASH_FORKID',
    )
    expect(header).toBeGreaterThan(0)
    const fork = rows.slice(header + 1) as [
      string,
      string,
      number,
      number,
      string,
    ][]
    expect(fork.length).toBe(500)
    fork.forEach((row, index) => {
      const tx = mustTx(fromHex(row[0]), BCH_MAINNET)
      const scriptCode = fromHex(row[1])
      const bch = digest(tx, row[2], BCH_MAINNET, row[3], 'forkid', {
        scriptCode,
        amount: 0n,
      })
      const xec = digest(tx, row[2], XEC_MAINNET, row[3], 'forkid', {
        scriptCode,
        amount: 0n,
      })
      if (bch !== row[4] || xec !== bch) {
        throw new Error(`forkid vector ${index}: ${bch} ${xec} != ${row[4]}`)
      }
    })
    const sample = fork[0]
    if (sample === undefined) throw new Error('missing forkid vector')
    const tx = mustTx(fromHex(sample[0]), XPI_MAINNET)
    expect(
      sighash(tx, sample[2], XPI_MAINNET, sample[3], {
        algorithm: 'forkid',
        scriptCode: fromHex(sample[1]),
        amount: 0n,
      }),
    ).toEqual({ ok: false, error: { code: 'sighash-algorithm' } })
  })

  test('BIP143 commits the amount and is not a BCH hash', () => {
    const tx = mustTx(fromHex(BIP143_UNSIGNED))
    const scriptCode = fromHex(BIP143_SCRIPT)
    const bip143 = toHex(
      hashed(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'bip143', {
        scriptCode,
        amount: 200000n,
      }),
    )
    expect(bip143).toBe(
      '71c9cd9b2869b9c70b01b1f0360c148f42dee72297db312638df136f43311f23',
    )
    expect(
      sighash(tx, 0, BCH_MAINNET, SIGHASH_ALL, {
        algorithm: 'bip143',
        scriptCode,
        amount: 200000n,
      }).ok,
    ).toBe(false)
    const legacy = toHex(
      hashed(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
        scriptCode,
      }),
    )
    expect(legacy).not.toBe(bip143)
  })

  test('fork id 0 commits a non-zero amount and BCH UTXOS differs from XEC', () => {
    const tx = mustTx(fromHex(BIP143_UNSIGNED), BCH_MAINNET)
    const scriptCode = fromHex('51')
    const amount = 500000n
    const spent = [{ value: amount, scriptPubKey: fromHex('51') }]
    const hashType = SIGHASH_ALL | SIGHASH_FORKID
    const bch = digest(tx, 0, BCH_MAINNET, hashType, 'forkid', {
      scriptCode,
      amount,
      spent,
    })
    const xec = digest(tx, 0, XEC_MAINNET, hashType, 'forkid', {
      scriptCode,
      amount,
      spent,
    })
    expect(bch).toBe(xec)
    expect(bch).not.toBe(
      digest(tx, 0, BCH_MAINNET, hashType, 'forkid', {
        scriptCode,
        amount: 1n,
        spent,
      }),
    )
    const utxoType = hashType | SIGHASH_UTXOS
    const withUtxos = digest(tx, 0, BCH_MAINNET, utxoType, 'forkid', {
      scriptCode,
      amount,
      spent,
      commitUtxos: true,
    })
    const without = digest(tx, 0, BCH_MAINNET, utxoType, 'forkid', {
      scriptCode,
      amount,
      spent,
    })
    const xecSameType = digest(tx, 0, XEC_MAINNET, utxoType, 'forkid', {
      scriptCode,
      amount,
      spent,
    })
    expect(withUtxos).not.toBe(without)
    expect(without).toBe(xecSameType)
    expect(
      sighash(tx, 0, XEC_MAINNET, utxoType, {
        algorithm: 'forkid',
        scriptCode,
        amount,
        spent,
        commitUtxos: true,
      }),
    ).toEqual({ ok: false, error: { code: 'sighash-utxos' } })
  })

  test('BIP341 key-path vectors match Bitcoin Core, and a hash-type flip does not', () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, 'fixtures/bip341-keypath.json'), 'utf8'),
    ) as {
      rawUnsignedTx: string
      utxosSpent: { scriptPubKey: string; amountSats: number }[]
      cases: { txinIndex: number; hashType: number; sigHash: string }[]
    }
    const tx = mustTx(fromHex(fixture.rawUnsignedTx))
    const spent = fixture.utxosSpent.map(utxo => ({
      value: BigInt(utxo.amountSats),
      scriptPubKey: fromHex(utxo.scriptPubKey),
    }))
    for (const item of fixture.cases) {
      expect(
        toHex(
          hashed(tx, item.txinIndex, BTC_MAINNET, item.hashType, 'bip341', {
            spent,
          }),
        ),
      ).toBe(item.sigHash)
    }
    const first = fixture.cases[0]
    if (first === undefined) throw new Error('missing taproot case')
    const flipped = toHex(
      hashed(tx, first.txinIndex, BTC_MAINNET, SIGHASH_ALL, 'bip341', {
        spent,
      }),
    )
    expect(flipped).not.toBe(first.sigHash)
    expect(
      sighash(tx, first.txinIndex, BCH_MAINNET, first.hashType, {
        algorithm: 'bip341',
        spent,
      }).ok,
    ).toBe(false)
  })

  test('XPI lotus is not fork id 0', () => {
    const script = fromHex('51')
    const txid = fromHex('11'.repeat(32))
    const parsedId = mustTx(
      serializeChecked({
        version: 1,
        locktime: 0,
        inputs: [
          {
            prevout: {
              txid: brand(txid),
              vout: 0,
            },
            scriptSig: new Uint8Array(),
            sequence: 0xffffffff,
          },
        ],
        outputs: [{ value: 1000n, scriptPubKey: script }],
      }),
      XPI_MAINNET,
    )
    const spent = [{ value: 2000n, scriptPubKey: script }]
    const lotus = sighash(
      parsedId,
      0,
      XPI_MAINNET,
      SIGHASH_LOTUS | SIGHASH_ALL,
      {
        algorithm: 'lotus',
        spent,
      },
    )
    if (!lotus.ok) throw new Error(lotus.error.code)
    expect(toHex(lotus.value)).toBe(
      '61553b556049dd318472b0f6170c4333c740a17cc1dcf86a69fe8dfa30db671f',
    )
    const forkid = sighash(
      parsedId,
      0,
      BCH_MAINNET,
      SIGHASH_FORKID | SIGHASH_ALL,
      { algorithm: 'forkid', scriptCode: script, amount: 2000n },
    )
    if (!forkid.ok) throw new Error(forkid.error.code)
    expect(toHex(forkid.value)).not.toBe(toHex(lotus.value))
    expect(toHex(forkid.value)).toBe(
      '36a65567f437cb49370f9f398e72b64f37cb679b0f343e706872f97dea0704d0',
    )
    const two = twoInputLotus()
    expect(toHex(two)).toBe(
      'f164b36533e61a5962b136acaeb51e0339dfa067b9489d0366f0ed69e88b65b2',
    )
    expect(
      sighash(parsedId, 0, XPI_MAINNET, SIGHASH_FORKID | SIGHASH_ALL, {
        algorithm: 'forkid',
        scriptCode: script,
        amount: 2000n,
      }).ok,
    ).toBe(false)
  })

  test('SIGHASH_NONE changes the legacy digest and SINGLE past the end is the one-bug', () => {
    const tx = mustTx(fromHex(BIP143_UNSIGNED))
    const scriptCode = new Uint8Array()
    const all = digest(tx, 0, BTC_MAINNET, SIGHASH_ALL, 'legacy', {
      scriptCode,
    })
    const none = digest(tx, 0, BTC_MAINNET, SIGHASH_NONE, 'legacy', {
      scriptCode,
    })
    expect(none).not.toBe(all)
    const bare = mustTx(
      fromHex(
        '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff0000000000',
      ),
    )
    expect(bare.outputs).toHaveLength(0)
    expect(
      digest(bare, 0, BTC_MAINNET, SIGHASH_SINGLE, 'legacy', { scriptCode }),
    ).toBe(`${'0'.repeat(63)}1`)
    expect(
      sighash(bare, 0, BTC_MAINNET, SIGHASH_SINGLE | SIGHASH_FORKID, {
        algorithm: 'bip143',
        scriptCode,
        amount: 1n,
      }).ok,
    ).toBe(true)
  })
})

function brand(bytes: Uint8Array) {
  const branded = internalHashFromBytes(bytes)
  if (!branded.ok) throw new Error(branded.error.code)
  return branded.value
}

function serializeChecked(tx: Transaction): Uint8Array {
  const encoded = serializeTransaction(tx, XPI_MAINNET)
  if (!encoded.ok) throw new Error(encoded.error.code)
  return encoded.value
}

function twoInputLotus(): Uint8Array {
  const first = brand(fromHex('11'.repeat(32)))
  const second = brand(fromHex('22'.repeat(32)))
  const tx = mustTx(
    serializeChecked({
      version: 1,
      locktime: 0,
      inputs: [
        {
          prevout: { txid: first, vout: 0 },
          scriptSig: new Uint8Array(),
          sequence: 0xffffffff,
        },
        {
          prevout: { txid: second, vout: 1 },
          scriptSig: new Uint8Array(),
          sequence: 0xfffffffe,
        },
      ],
      outputs: [
        { value: 1000n, scriptPubKey: fromHex('51') },
        { value: 1500n, scriptPubKey: fromHex('52') },
      ],
    }),
    XPI_MAINNET,
  )
  const result = sighash(tx, 1, XPI_MAINNET, SIGHASH_LOTUS | SIGHASH_ALL, {
    algorithm: 'lotus',
    spent: [
      { value: 2000n, scriptPubKey: fromHex('51') },
      { value: 3000n, scriptPubKey: fromHex('52') },
    ],
  })
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function hash256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(sha256(sha256(bytes)))
}

function mustId(tx: Transaction, chain: typeof BTC_MAINNET): InternalHash {
  const id = transactionId(tx, chain)
  if (!id.ok) throw new Error(id.error.code)
  return id.value
}

function mustHash(tx: Transaction, chain: typeof BTC_MAINNET): InternalHash {
  const hash = transactionHash(tx, chain)
  if (!hash.ok) throw new Error(hash.error.code)
  return hash.value
}

function mustLeaf(tx: Transaction, chain: typeof BTC_MAINNET): InternalHash {
  const leaf = blockMerkleLeaf(tx, chain)
  if (!leaf.ok) throw new Error(leaf.error.code)
  return leaf.value
}

function oldOf(bytes: Uint8Array) {
  return new oldTx.Transaction(Buffer.from(bytes))
}

function input(txidHex: string, vout: number, script: Uint8Array): TxInput {
  return {
    prevout: { txid: brand(fromHex(txidHex)), vout },
    scriptSig: script,
    sequence: 0xffffffff,
  }
}

function output(value: bigint, scriptHex: string): TxOutput {
  return { value, scriptPubKey: fromHex(scriptHex) }
}

// lotusd chainparams.cpp CreateGenesisBlock. One transaction, so the header
// merkle root is sha256d(GetHash || GetId). Display order is uint256S.
const XPI_GENESIS_MERKLE =
  '37f392d88f70cdada6d366a25a7ef90b6711bf2d6b5ffea4f39727dcb90af34c'
const GENESIS_MESSAGE = 'John 1:1 In the beginning was the Logos'
const GENESIS_PUBKEY =
  '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f'
const GENESIS_PAYLOAD =
  'ffe330c4b7643e554c62adcbe0b80537435d888b5c33d5e29a70cdd743e3a093'

function pushData(payload: Uint8Array): Uint8Array {
  if (payload.length >= 0x4c) throw new Error('push')
  return concatBytes([Uint8Array.of(payload.length), payload])
}

function lotusGenesisTx(scriptTail: Uint8Array): Transaction {
  const message = new TextEncoder().encode(GENESIS_MESSAGE)
  const subsidy = 130_000_000n
  return {
    version: 1,
    locktime: 0,
    inputs: [
      {
        prevout: { txid: brand(new Uint8Array(32)), vout: 0xffffffff },
        scriptSig: concatBytes([pushData(message), scriptTail]),
        sequence: 0xffffffff,
      },
    ],
    outputs: [
      {
        value: subsidy,
        scriptPubKey: concatBytes([
          Uint8Array.of(0x6a),
          pushData(new TextEncoder().encode('logos')),
          Uint8Array.of(0x00),
          pushData(fromHex(GENESIS_PAYLOAD)),
        ]),
      },
      {
        value: subsidy,
        scriptPubKey: concatBytes([
          pushData(fromHex(GENESIS_PUBKEY)),
          Uint8Array.of(0xac),
        ]),
      },
    ],
  }
}

describe('transaction ids', () => {
  test('bitcoin genesis txid is the header merkle root and ignores no witness', () => {
    const raw = fromHex(
      '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000',
    )
    const tx = mustTx(raw)
    const id = mustId(tx, BTC_MAINNET)
    expect(display(id)).toBe(
      '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
    )
    expect(toHex(mustHash(tx, BTC_MAINNET))).toBe(toHex(id))
    expect(toHex(mustLeaf(tx, BTC_MAINNET))).toBe(toHex(id))
    expect(toHex(id)).toBe(toHex(hash256(raw)))
    for (const chain of [BCH_MAINNET, XEC_MAINNET]) {
      expect(toHex(mustId(tx, chain))).toBe(toHex(id))
      expect(toHex(mustLeaf(tx, chain))).toBe(toHex(id))
    }
  })

  test('a BTC witness changes the full hash and not the txid or block leaf', () => {
    const signed = mustTx(fromHex(BIP143_SIGNED))
    const unsigned = mustTx(fromHex(BIP143_UNSIGNED))
    const id = mustId(signed, BTC_MAINNET)
    expect(toHex(id)).toBe(toHex(mustId(unsigned, BTC_MAINNET)))
    expect(toHex(id)).toBe(toHex(hash256(fromHex(BIP143_UNSIGNED))))
    expect(toHex(mustLeaf(signed, BTC_MAINNET))).toBe(toHex(id))
    expect(toHex(mustLeaf(unsigned, BTC_MAINNET))).toBe(toHex(id))
    const full = mustHash(signed, BTC_MAINNET)
    expect(toHex(full)).toBe(toHex(hash256(fromHex(BIP143_SIGNED))))
    expect(toHex(full)).not.toBe(toHex(id))
    const resigned = {
      ...unsigned,
      inputs: unsigned.inputs.map(item => ({
        ...item,
        scriptSig: fromHex('51'),
      })),
    }
    expect(toHex(mustId(resigned, BTC_MAINNET))).not.toBe(toHex(id))
    expect(toHex(mustLeaf(resigned, BTC_MAINNET))).not.toBe(toHex(id))
    expect(transactionId(signed, BCH_MAINNET)).toEqual({
      ok: false,
      error: { code: 'tx-witness-rejected' },
    })
    expect(blockMerkleLeaf(signed, XPI_MAINNET)).toEqual({
      ok: false,
      error: { code: 'tx-witness-rejected' },
    })
  })

  test('lotus genesis leaf is the header merkle root and matches bitcore', () => {
    const tx = lotusGenesisTx(new Uint8Array())
    const raw = serializeChecked(tx)
    const parsed = mustTx(raw, XPI_MAINNET)
    const id = mustId(parsed, XPI_MAINNET)
    const hash = mustHash(parsed, XPI_MAINNET)
    const leaf = mustLeaf(parsed, XPI_MAINNET)
    const reference = oldOf(raw)
    expect(toHex(id)).toBe(reference._getTxid().toString('hex'))
    expect(display(id)).toBe(reference.txid)
    expect(toHex(hash)).toBe(reference._getHash().toString('hex'))
    expect(display(hash)).toBe(reference.hash)
    const oldLeaf = oldTx.crypto.Hash.sha256sha256(
      Buffer.concat([reference._getHash(), reference._getTxid()]),
    )
    expect(toHex(leaf)).toBe(oldLeaf.toString('hex'))
    expect(display(leaf)).toBe(XPI_GENESIS_MERKLE)
    expect(toHex(hash)).not.toBe(toHex(id))
  })

  test('scriptSig moves the lotus hash and block leaf and not the segmented id', () => {
    const bare = lotusGenesisTx(new Uint8Array())
    const signed = lotusGenesisTx(fromHex('51'))
    const bareId = mustId(bare, XPI_MAINNET)
    const signedId = mustId(signed, XPI_MAINNET)
    expect(toHex(signedId)).toBe(toHex(bareId))
    expect(toHex(mustHash(signed, XPI_MAINNET))).not.toBe(
      toHex(mustHash(bare, XPI_MAINNET)),
    )
    const bareLeaf = mustLeaf(bare, XPI_MAINNET)
    const signedLeaf = mustLeaf(signed, XPI_MAINNET)
    expect(toHex(signedLeaf)).not.toBe(toHex(bareLeaf))
    const raw = serializeChecked(signed)
    const reference = oldOf(raw)
    expect(toHex(signedId)).toBe(reference._getTxid().toString('hex'))
    expect(toHex(mustHash(signed, XPI_MAINNET))).toBe(
      reference._getHash().toString('hex'),
    )
    expect(reference.txid).toBe(oldOf(serializeChecked(bare)).txid)
    expect(reference.hash).not.toBe(oldOf(serializeChecked(bare)).hash)
  })

  test('an odd input list puts a zero pad in the lotus id', () => {
    const tx: Transaction = {
      version: 2,
      locktime: 9,
      inputs: [
        input('11'.repeat(32), 0, fromHex('51')),
        input('22'.repeat(32), 1, fromHex('52')),
        input('33'.repeat(32), 2, fromHex('53')),
      ],
      outputs: [output(50n, '6a')],
    }
    const raw = serializeChecked(tx)
    const id = mustId(tx, XPI_MAINNET)
    expect(toHex(id)).toBe(oldOf(raw)._getTxid().toString('hex'))
    expect(display(id)).toBe(oldOf(raw).txid)
    const leaves = tx.inputs.map(item =>
      hash256(
        concatBytes([
          item.prevout.txid,
          Uint8Array.of(
            item.prevout.vout & 0xff,
            (item.prevout.vout >>> 8) & 0xff,
            (item.prevout.vout >>> 16) & 0xff,
            (item.prevout.vout >>> 24) & 0xff,
          ),
          Uint8Array.of(0xff, 0xff, 0xff, 0xff),
        ]),
      ),
    )
    const first = leaves[0]
    const second = leaves[1]
    const third = leaves[2]
    if (!first || !second || !third) throw new Error('leaves')
    const padded = hash256(concatBytes([third, new Uint8Array(32)]))
    const duplicated = hash256(concatBytes([third, third]))
    expect(toHex(padded)).not.toBe(toHex(duplicated))
    const script = tx.outputs[0]?.scriptPubKey ?? new Uint8Array()
    const outLeaf = hash256(
      concatBytes([
        Uint8Array.of(50, 0, 0, 0, 0, 0, 0, 0),
        Uint8Array.of(script.length),
        script,
      ]),
    )
    const left = hash256(concatBytes([first, second]))
    const root = hash256(concatBytes([left, padded]))
    const duplicateRoot = hash256(concatBytes([left, duplicated]))
    const preimage = (side: Uint8Array) =>
      concatBytes([
        Uint8Array.of(2, 0, 0, 0),
        side,
        Uint8Array.of(3),
        outLeaf,
        Uint8Array.of(1),
        Uint8Array.of(9, 0, 0, 0),
      ])
    expect(toHex(hash256(preimage(root)))).toBe(toHex(id))
    expect(toHex(hash256(preimage(duplicateRoot)))).not.toBe(toHex(id))
  })

  test('an odd output list puts a zero pad in the lotus id', () => {
    const tx: Transaction = {
      version: 1,
      locktime: 0,
      inputs: [input('ab'.repeat(32), 4, new Uint8Array())],
      outputs: [output(1n, '51'), output(2n, '52'), output(3n, '53')],
    }
    const raw = serializeChecked(tx)
    const id = mustId(tx, XPI_MAINNET)
    expect(toHex(id)).toBe(oldOf(raw)._getTxid().toString('hex'))
    const changed = {
      ...tx,
      inputs: tx.inputs.map(item => ({
        ...item,
        scriptSig: fromHex('0100'),
      })),
    }
    expect(toHex(mustId(changed, XPI_MAINNET))).toBe(toHex(id))
    expect(toHex(mustLeaf(changed, XPI_MAINNET))).not.toBe(
      toHex(mustLeaf(tx, XPI_MAINNET)),
    )
    expect(toHex(mustLeaf(changed, XPI_MAINNET))).toBe(
      oldTx.crypto.Hash.sha256sha256(
        Buffer.concat([
          oldOf(serializeChecked(changed))._getHash(),
          oldOf(serializeChecked(changed))._getTxid(),
        ]),
      ).toString('hex'),
    )
  })

  test('an empty output side is height 0, which bitcore does not implement', () => {
    const tx: Transaction = {
      version: 1,
      locktime: 7,
      inputs: [input('44'.repeat(32), 0, fromHex('00'))],
      outputs: [],
    }
    const raw = serializeChecked(tx)
    const id = mustId(tx, XPI_MAINNET)
    const reference = oldOf(raw)
    expect(toHex(id)).not.toBe(reference._getTxid().toString('hex'))
    const leaf = hash256(
      concatBytes([
        brand(fromHex('44'.repeat(32))),
        Uint8Array.of(0, 0, 0, 0),
        Uint8Array.of(0xff, 0xff, 0xff, 0xff),
      ]),
    )
    const preimage = concatBytes([
      Uint8Array.of(1, 0, 0, 0),
      leaf,
      Uint8Array.of(1),
      new Uint8Array(32),
      Uint8Array.of(0),
      Uint8Array.of(7, 0, 0, 0),
    ])
    expect(toHex(hash256(preimage))).toBe(toHex(id))
    const bitcoreHeight = concatBytes([
      Uint8Array.of(1, 0, 0, 0),
      leaf,
      Uint8Array.of(1),
      new Uint8Array(32),
      Uint8Array.of(1),
      Uint8Array.of(7, 0, 0, 0),
    ])
    expect(toHex(hash256(bitcoreHeight))).toBe(
      reference._getTxid().toString('hex'),
    )
  })
})
