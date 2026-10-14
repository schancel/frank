import {
  BCH_MAINNET,
  BCH_TESTNET,
  BITCOIN_HEADER_BYTES,
  BTC_MAINNET,
  BTC_TESTNET,
  DOGE_MAINNET,
  DOGE_TESTNET,
  LOTUS_HEADER_BYTES,
  LTC_MAINNET,
  LTC_TESTNET,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_FORKID,
  SIGHASH_LOTUS,
  SIGHASH_UTXOS,
  XEC_MAINNET,
  XEC_TESTNET,
  XPI_MAINNET,
  XPI_TESTNET,
  chainSupportsSighashAlgorithm,
  decodeAddress,
  deriveBip44Account,
  encodeAddress,
  encodeChainSigHashType,
  hdPrivateFromSeed,
  hdPublicFromPrivate,
  headerHash,
  internalHashFromBytes,
  lockingScript,
  parseHdPrivate,
  parseHdPublic,
  parseHeader,
  parseMerkleBlock,
  privateKeyFromHex,
  privateKeyFromWif,
  privateKeyToWif,
  pubkeyHashFromBytes,
  publicFromPrivate,
  resolveScriptSighashAlgorithm,
  serializeHdPrivate,
  serializeHdPublic,
  serializeHeader,
  serializeTransaction,
  sighash,
  signInput,
  signingKey,
  usesBip143Digest,
  validateChainSigHashType,
  verifyScript,
  xOnlyPublicKeyFromBytes,
  type BitcoinHeader,
  type ChainDescriptor,
  type Destination,
  type LotusHeader,
  type ScriptHash,
  type SpentOutput,
  type Transaction,
} from '../src/index.js'

const TWELVE_CHAINS: readonly ChainDescriptor[] = [
  BTC_MAINNET,
  BTC_TESTNET,
  BCH_MAINNET,
  BCH_TESTNET,
  XEC_MAINNET,
  XEC_TESTNET,
  XPI_MAINNET,
  XPI_TESTNET,
  DOGE_MAINNET,
  DOGE_TESTNET,
  LTC_MAINNET,
  LTC_TESTNET,
]

const SECRET_HEX =
  '1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd'

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string } },
): T {
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`)
  return result.value
}

describe('cross-chain abstraction across all 12 mainnet/testnet descriptors', () => {
  const privCompressed = must(privateKeyFromHex(SECRET_HEX, true))
  const privUncompressed = must(privateKeyFromHex(SECRET_HEX, false))
  const derivedPub = must(publicFromPrivate(privCompressed))
  const sampleHashBytes = new Uint8Array(20).fill(0x42)
  const pkh = must(pubkeyHashFromBytes(sampleHashBytes))
  const sh = new Uint8Array(20).fill(0x24) as ScriptHash
  const xOnly = must(xOnlyPublicKeyFromBytes(new Uint8Array(32).fill(0x33)))

  const p2pkhDest: Destination = { kind: 'p2pkh', hash: pkh }
  const p2shDest: Destination = { kind: 'p2sh', hash: sh }
  const p2wpkhDest: Destination = { kind: 'p2wpkh', hash: pkh }
  const p2trDest: Destination = {
    kind: 'p2tr',
    outputKey: xOnly,
    tweak: new Uint8Array(32).fill(0x01),
  }

  test('address round-trips and cross-chain rejection across all 12 descriptors', () => {
    // 1. Base58Check P2PKH & P2SH on all non-Lotus chains
    const base58Chains = TWELVE_CHAINS.filter(c => c.lotusNetChar === null)
    expect(base58Chains).toHaveLength(10)

    for (const chain of base58Chains) {
      for (const dest of [p2pkhDest, p2shDest]) {
        const encoded = must(encodeAddress(dest, chain, 'base58check'))
        const decoded = must(decodeAddress(encoded, chain))
        expect(decoded.encoding).toBe('base58check')
        expect(decoded.chain).toBe(chain)
        expect(decoded.destination).toEqual(dest)

        // Decoding without a chain argument fails for base58check
        expect(decodeAddress(encoded)).toEqual({
          ok: false,
          error: { code: 'chain-required' },
        })
      }
    }

    // Distinct version bytes (e.g. DOGE_MAINNET vs BTC_MAINNET vs LTC_MAINNET) reject each other's base58check addresses
    const dogeP2pkh = must(encodeAddress(p2pkhDest, DOGE_MAINNET, 'base58check'))
    const ltcP2pkh = must(encodeAddress(p2pkhDest, LTC_MAINNET, 'base58check'))
    const btcP2pkh = must(encodeAddress(p2pkhDest, BTC_MAINNET, 'base58check'))
    expect(dogeP2pkh.startsWith('D')).toBe(true)
    expect(ltcP2pkh.startsWith('L')).toBe(true)
    expect(btcP2pkh.startsWith('1')).toBe(true)
    expect(decodeAddress(dogeP2pkh, BTC_MAINNET).ok).toBe(false)
    expect(decodeAddress(dogeP2pkh, LTC_MAINNET).ok).toBe(false)
    expect(decodeAddress(ltcP2pkh, BTC_MAINNET).ok).toBe(false)
    expect(decodeAddress(ltcP2pkh, DOGE_MAINNET).ok).toBe(false)

    // 2. CashAddr round-trips on BCH and XEC (and rejected on BTC, DOGE, LTC, XPI)
    for (const chain of [BCH_MAINNET, BCH_TESTNET, XEC_MAINNET, XEC_TESTNET]) {
      for (const dest of [p2pkhDest, p2shDest]) {
        const cash = must(encodeAddress(dest, chain, 'cashaddr'))
        expect(cash.startsWith(`${chain.cashaddrPrefix}:`)).toBe(true)
        const decoded = must(decodeAddress(cash))
        expect(decoded.chain).toBe(chain)
        expect(decoded.encoding).toBe('cashaddr')
        expect(decoded.destination).toEqual(dest)

        // Cross-chain rejection when passing another chain descriptor
        for (const other of TWELVE_CHAINS.filter(c => c !== chain)) {
          const mismatch = decodeAddress(cash, other)
          expect(mismatch).toEqual({
            ok: false,
            error: {
              code: 'chain-mismatch',
              detected: { family: chain.family, network: chain.network },
              supplied: { family: other.family, network: other.network },
            },
          })
        }
      }
    }

    for (const nonCash of [
      BTC_MAINNET,
      BTC_TESTNET,
      DOGE_MAINNET,
      DOGE_TESTNET,
      LTC_MAINNET,
      LTC_TESTNET,
      XPI_MAINNET,
      XPI_TESTNET,
    ]) {
      expect(encodeAddress(p2pkhDest, nonCash, 'cashaddr').ok).toBe(false)
    }

    // 3. Lotus XAddress round-trips on XPI_MAINNET and XPI_TESTNET
    for (const chain of [XPI_MAINNET, XPI_TESTNET]) {
      for (const dest of [p2pkhDest, p2shDest]) {
        const xaddr = must(encodeAddress(dest, chain, 'lotus'))
        expect(xaddr.startsWith(`lotus${chain.lotusNetChar}`)).toBe(true)
        const decoded = must(decodeAddress(xaddr))
        expect(decoded.chain).toBe(chain)
        expect(decoded.encoding).toBe('lotus')
        expect(decoded.destination).toEqual(dest)

        for (const other of TWELVE_CHAINS.filter(c => c !== chain)) {
          expect(decodeAddress(xaddr, other)).toEqual({
            ok: false,
            error: {
              code: 'chain-mismatch',
              detected: { family: chain.family, network: chain.network },
              supplied: { family: other.family, network: other.network },
            },
          })
        }
      }
      expect(encodeAddress(p2pkhDest, chain, 'base58check').ok).toBe(false)
    }

    // 4. Bech32 / Bech32m round-trips on BTC and LTC (and rejected on BCH, XEC, XPI, DOGE)
    for (const chain of [BTC_MAINNET, BTC_TESTNET, LTC_MAINNET, LTC_TESTNET]) {
      const bech32Addr = must(encodeAddress(p2wpkhDest, chain, 'bech32'))
      expect(bech32Addr.startsWith(`${chain.bech32Hrp}1q`)).toBe(true)
      const decodedV0 = must(decodeAddress(bech32Addr))
      expect(decodedV0.chain).toBe(chain)
      expect(decodedV0.encoding).toBe('bech32')
      expect(decodedV0.destination).toEqual(p2wpkhDest)

      const bech32mAddr = must(encodeAddress(p2trDest, chain, 'bech32m'))
      expect(bech32mAddr.startsWith(`${chain.bech32Hrp}1p`)).toBe(true)
      const decodedV1 = must(decodeAddress(bech32mAddr))
      expect(decodedV1.chain).toBe(chain)
      expect(decodedV1.encoding).toBe('bech32m')
      expect(decodedV1.destination).toEqual({
        kind: 'p2tr',
        outputKey: xOnly,
        tweak: null,
      })

      for (const other of TWELVE_CHAINS.filter(c => c !== chain)) {
        expect(decodeAddress(bech32Addr, other)).toEqual({
          ok: false,
          error: {
            code: 'chain-mismatch',
            detected: { family: chain.family, network: chain.network },
            supplied: { family: other.family, network: other.network },
          },
        })
      }
    }

    for (const noSegwit of [
      BCH_MAINNET,
      BCH_TESTNET,
      XEC_MAINNET,
      XEC_TESTNET,
      XPI_MAINNET,
      XPI_TESTNET,
      DOGE_MAINNET,
      DOGE_TESTNET,
    ]) {
      expect(encodeAddress(p2wpkhDest, noSegwit, 'bech32')).toEqual({
        ok: false,
        error: {
          code: 'not-representable',
          kind: 'p2wpkh',
          family: noSegwit.family,
        },
      })
      expect(encodeAddress(p2trDest, noSegwit, 'bech32m')).toEqual({
        ok: false,
        error: {
          code: 'not-representable',
          kind: 'p2tr',
          family: noSegwit.family,
        },
      })
    }
  })

  test('WIF round-trips and version byte enforcement across all 12 descriptors', () => {
    for (const chain of TWELVE_CHAINS) {
      for (const key of [privCompressed, privUncompressed]) {
        const wif = must(privateKeyToWif(key, chain))
        const decoded = must(privateKeyFromWif(wif, chain))
        expect(decoded.compressed).toBe(key.compressed)
        expect(decoded.bytes).toEqual(key.bytes)

        for (const other of TWELVE_CHAINS.filter(
          c => c.wifVersion !== chain.wifVersion,
        )) {
          expect(privateKeyFromWif(wif, other)).toEqual({
            ok: false,
            error: {
              code: 'wif-version',
              expected: other.wifVersion,
              actual: chain.wifVersion,
            },
          })
        }
      }
    }
  })

  test('extended key (xprv/xpub, dgpv/dgub, tprv/tpub) version enforcement across all 12 descriptors', () => {
    const seed = new Uint8Array(32).fill(0x07)
    const master = must(hdPrivateFromSeed(seed))

    for (const chain of TWELVE_CHAINS) {
      const accountPriv = must(
        deriveBip44Account(master, chain.registeredSlip44, 0),
      )
      const accountPub = must(hdPublicFromPrivate(accountPriv))

      const encodedPriv = must(serializeHdPrivate(accountPriv, chain))
      const encodedPub = must(serializeHdPublic(accountPub, chain))

      if (chain === DOGE_MAINNET) {
        expect(encodedPriv.startsWith('dgpv')).toBe(true)
        expect(encodedPub.startsWith('dgub')).toBe(true)
      } else if (chain.network === 'mainnet') {
        expect(encodedPriv.startsWith('xprv')).toBe(true)
        expect(encodedPub.startsWith('xpub')).toBe(true)
      } else {
        expect(encodedPriv.startsWith('tprv')).toBe(true)
        expect(encodedPub.startsWith('tpub')).toBe(true)
      }

      const parsedPriv = must(parseHdPrivate(encodedPriv, chain))
      const parsedPub = must(parseHdPublic(encodedPub, chain))
      expect(parsedPriv.privateKey.bytes).toEqual(accountPriv.privateKey.bytes)
      expect(parsedPub.publicKey).toEqual(accountPub.publicKey)

      for (const other of TWELVE_CHAINS.filter(
        c => c.hdPrivateVersion !== chain.hdPrivateVersion,
      )) {
        expect(parseHdPrivate(encodedPriv, other)).toEqual({
          ok: false,
          error: {
            code: 'hd-version',
            expected: other.hdPrivateVersion,
            actual: chain.hdPrivateVersion,
          },
        })
      }
      for (const other of TWELVE_CHAINS.filter(
        c => c.hdPublicVersion !== chain.hdPublicVersion,
      )) {
        expect(parseHdPublic(encodedPub, other)).toEqual({
          ok: false,
          error: {
            code: 'hd-version',
            expected: other.hdPublicVersion,
            actual: chain.hdPublicVersion,
          },
        })
      }
    }
  })

  test('sighash strategy dispatch helpers enforce family rules across all 12 descriptors', () => {
    for (const chain of [BTC_MAINNET, BTC_TESTNET, LTC_MAINNET, LTC_TESTNET]) {
      expect(validateChainSigHashType(chain, SIGHASH_ALL)).toBe(true)
      expect(
        validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_ANYONECANPAY),
      ).toBe(true)
      expect(
        validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_FORKID),
      ).toBe(false)
      expect(validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_LOTUS)).toBe(
        false,
      )
      expect(usesBip143Digest(chain, 'legacy')).toBe(false)
      expect(usesBip143Digest(chain, 'segwit-v0')).toBe(true)
      expect(usesBip143Digest(chain, 'forkid')).toBe(false)
      expect(chainSupportsSighashAlgorithm(chain, 'legacy')).toBe(true)
      expect(chainSupportsSighashAlgorithm(chain, 'bip143')).toBe(true)
      expect(chainSupportsSighashAlgorithm(chain, 'bip341')).toBe(true)
      expect(chainSupportsSighashAlgorithm(chain, 'forkid')).toBe(false)
      expect(chainSupportsSighashAlgorithm(chain, 'lotus')).toBe(false)
      expect(resolveScriptSighashAlgorithm(chain, SIGHASH_ALL)).toBe('legacy')
      expect(encodeChainSigHashType(chain, SIGHASH_ALL)).toBe(SIGHASH_ALL)
    }

    for (const chain of [BCH_MAINNET, BCH_TESTNET, XEC_MAINNET, XEC_TESTNET]) {
      expect(validateChainSigHashType(chain, SIGHASH_ALL)).toBe(false)
      expect(
        validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_FORKID),
      ).toBe(true)
      expect(validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_LOTUS)).toBe(
        false,
      )
      expect(
        validateChainSigHashType(
          chain,
          SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS,
          { allowCommitUtxos: true },
        ),
      ).toBe(chain.family === 'bch')
      expect(usesBip143Digest(chain, 'legacy')).toBe(true)
      expect(usesBip143Digest(chain, 'forkid')).toBe(true)
      expect(usesBip143Digest(chain, 'segwit-v0')).toBe(false)
      expect(chainSupportsSighashAlgorithm(chain, 'forkid')).toBe(true)
      expect(chainSupportsSighashAlgorithm(chain, 'legacy')).toBe(false)
      expect(chainSupportsSighashAlgorithm(chain, 'bip143')).toBe(false)
      expect(
        resolveScriptSighashAlgorithm(chain, SIGHASH_ALL | SIGHASH_FORKID),
      ).toBe('forkid')
      expect(
        encodeChainSigHashType(chain, SIGHASH_ALL | SIGHASH_FORKID),
      ).toBe(SIGHASH_ALL | SIGHASH_FORKID)
    }

    for (const chain of [XPI_MAINNET, XPI_TESTNET]) {
      expect(validateChainSigHashType(chain, SIGHASH_ALL)).toBe(false)
      expect(
        validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_FORKID),
      ).toBe(true)
      expect(validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_LOTUS)).toBe(
        true,
      )
      expect(usesBip143Digest(chain, 'forkid')).toBe(true)
      expect(usesBip143Digest(chain, 'legacy')).toBe(false)
      expect(usesBip143Digest(chain, 'segwit-v0')).toBe(false)
      expect(
        resolveScriptSighashAlgorithm(chain, SIGHASH_ALL | SIGHASH_FORKID),
      ).toBe('forkid')
      expect(
        resolveScriptSighashAlgorithm(chain, SIGHASH_ALL | SIGHASH_LOTUS),
      ).toBe('lotus')
      expect(
        encodeChainSigHashType(chain, SIGHASH_ALL | SIGHASH_FORKID, {
          replayProtection: true,
        }),
      ).toBe(0xffdead41)
    }

    for (const chain of [DOGE_MAINNET, DOGE_TESTNET]) {
      expect(validateChainSigHashType(chain, SIGHASH_ALL)).toBe(true)
      expect(
        validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_FORKID),
      ).toBe(false)
      expect(validateChainSigHashType(chain, SIGHASH_ALL | SIGHASH_LOTUS)).toBe(
        false,
      )
      expect(usesBip143Digest(chain, 'legacy')).toBe(false)
      expect(usesBip143Digest(chain, 'segwit-v0')).toBe(false)
      expect(usesBip143Digest(chain, 'forkid')).toBe(false)
      expect(chainSupportsSighashAlgorithm(chain, 'legacy')).toBe(true)
      expect(chainSupportsSighashAlgorithm(chain, 'bip143')).toBe(false)
      expect(chainSupportsSighashAlgorithm(chain, 'bip341')).toBe(false)
      expect(chainSupportsSighashAlgorithm(chain, 'forkid')).toBe(false)
      expect(chainSupportsSighashAlgorithm(chain, 'lotus')).toBe(false)
      expect(resolveScriptSighashAlgorithm(chain, SIGHASH_ALL)).toBe('legacy')
    }
  })

  test('transaction signing and script verification across all 4 sighash families', () => {
    const signer = must(signingKey('ecdsa', privCompressed))
    const prevTxid = must(internalHashFromBytes(new Uint8Array(32).fill(0xaa)))

    // P2PK locking script (<33-byte compressed pubkey> OP_CHECKSIG)
    const p2pkScript = new Uint8Array(35)
    p2pkScript[0] = 33
    p2pkScript.set(derivedPub.compressed, 1)
    p2pkScript[34] = 0xac

    const baseTx: Transaction = {
      version: 2,
      inputs: [
        {
          prevout: { txid: prevTxid, vout: 0 },
          scriptSig: new Uint8Array(),
          sequence: 0xffffffff,
        },
      ],
      outputs: [{ value: 90_000n, scriptPubKey: p2pkScript }],
      locktime: 0,
    }
    const spentOutputs: readonly SpentOutput[] = [
      { value: 100_000n, scriptPubKey: p2pkScript },
    ]

    // 1. btc-legacy-and-segwit (BTC, LTC)
    for (const chain of [BTC_MAINNET, BTC_TESTNET, LTC_MAINNET, LTC_TESTNET]) {
      const signed = must(
        signInput(baseTx, 0, signer, {
          chain,
          algorithm: 'legacy',
          sighashType: SIGHASH_ALL,
          spent: spentOutputs,
        }),
      )
      const verified = verifyScript(signed.scriptSig, p2pkScript, {
        chain,
        transaction: signed.transaction,
        inputIndex: 0,
        spent: spentOutputs,
      })
      expect(verified).toEqual({ ok: true, value: true })

      // Rejects forkid signing on BTC/LTC
      expect(
        signInput(baseTx, 0, signer, {
          chain,
          algorithm: 'forkid',
          sighashType: SIGHASH_ALL | SIGHASH_FORKID,
          spent: spentOutputs,
        }),
      ).toEqual({ ok: false, error: { code: 'sign-algorithm' } })
    }

    // 2. forkid (BCH, XEC)
    for (const chain of [BCH_MAINNET, BCH_TESTNET, XEC_MAINNET, XEC_TESTNET]) {
      const signed = must(
        signInput(baseTx, 0, signer, {
          chain,
          algorithm: 'forkid',
          sighashType: SIGHASH_ALL | SIGHASH_FORKID,
          spent: spentOutputs,
        }),
      )
      const verified = verifyScript(signed.scriptSig, p2pkScript, {
        chain,
        transaction: signed.transaction,
        inputIndex: 0,
        spent: spentOutputs,
      })
      expect(verified).toEqual({ ok: true, value: true })

      // Rejects legacy signing on BCH/XEC
      expect(
        signInput(baseTx, 0, signer, {
          chain,
          algorithm: 'legacy',
          sighashType: SIGHASH_ALL,
          spent: spentOutputs,
        }),
      ).toEqual({ ok: false, error: { code: 'sign-algorithm' } })
    }

    // 3. lotus (XPI)
    for (const chain of [XPI_MAINNET, XPI_TESTNET]) {
      const signedLotus = must(
        signInput(baseTx, 0, signer, {
          chain,
          algorithm: 'lotus',
          sighashType: SIGHASH_ALL | SIGHASH_LOTUS,
          spent: spentOutputs,
        }),
      )
      expect(
        verifyScript(signedLotus.scriptSig, p2pkScript, {
          chain,
          transaction: signedLotus.transaction,
          inputIndex: 0,
          spent: spentOutputs,
        }),
      ).toEqual({ ok: true, value: true })

      const signedForkId = must(
        signInput(baseTx, 0, signer, {
          chain,
          algorithm: 'forkid',
          sighashType: SIGHASH_ALL | SIGHASH_FORKID,
          spent: spentOutputs,
          replayProtection: true,
        }),
      )
      expect(
        verifyScript(signedForkId.scriptSig, p2pkScript, {
          chain,
          transaction: signedForkId.transaction,
          inputIndex: 0,
          spent: spentOutputs,
        }),
      ).toEqual({ ok: true, value: true })
    }

    // 4. legacy-only (DOGE)
    for (const chain of [DOGE_MAINNET, DOGE_TESTNET]) {
      const signed = must(
        signInput(baseTx, 0, signer, {
          chain,
          algorithm: 'legacy',
          sighashType: SIGHASH_ALL,
          spent: spentOutputs,
        }),
      )
      expect(
        verifyScript(signed.scriptSig, p2pkScript, {
          chain,
          transaction: signed.transaction,
          inputIndex: 0,
          spent: spentOutputs,
        }),
      ).toEqual({ ok: true, value: true })

      // Rejects forkid, lotus, and bip143 on DOGE
      for (const badAlgorithm of ['forkid', 'lotus', 'bip143', 'bip341'] as const) {
        expect(
          signInput(baseTx, 0, signer, {
            chain,
            algorithm: badAlgorithm,
            sighashType: SIGHASH_ALL,
            spent: spentOutputs,
          }),
        ).toEqual({ ok: false, error: { code: 'sign-algorithm' } })
        expect(
          sighash(baseTx, 0, chain, SIGHASH_ALL, {
            algorithm: badAlgorithm,
            scriptCode: p2pkScript,
            amount: 100_000n,
            spent: spentOutputs,
          }),
        ).toEqual({ ok: false, error: { code: 'sighash-algorithm' } })
      }

      // Rejects witness serialization on DOGE
      expect(
        serializeTransaction(
          {
            ...baseTx,
            inputs: [
              {
                ...baseTx.inputs[0]!,
                witness: [new Uint8Array([1])],
              },
            ],
          },
          chain,
        ),
      ).toEqual({ ok: false, error: { code: 'tx-witness-rejected' } })
    }
  })

  test('block header parsing and rejection across all 3 header shapes', () => {
    const zeroHash = must(internalHashFromBytes(new Uint8Array(32)))
    const sampleBtcHeader: BitcoinHeader = {
      kind: 'bitcoin-80',
      version: 1,
      prevBlock: zeroHash,
      merkleRoot: zeroHash,
      time: 1_700_000_000,
      bits: 0x1d00ffff,
      nonce: 42,
    }
    const btcHeaderBytes = must(serializeHeader(sampleBtcHeader))
    expect(btcHeaderBytes).toHaveLength(BITCOIN_HEADER_BYTES)

    const sampleLotusHeader: LotusHeader = {
      kind: 'lotus',
      prevBlock: zeroHash,
      bits: 0x1c100000,
      time: 1_624_246_260n,
      reserved: 0,
      nonce: 123456789n,
      headerVersion: 1,
      size: 379n,
      height: 0,
      epochBlock: zeroHash,
      merkleRoot: zeroHash,
      extendedMetadata: zeroHash,
    }
    const lotusHeaderBytes = must(serializeHeader(sampleLotusHeader))
    expect(lotusHeaderBytes).toHaveLength(LOTUS_HEADER_BYTES)

    // 1. bitcoin-80 chains (BTC, BCH, XEC, LTC)
    for (const chain of [
      BTC_MAINNET,
      BTC_TESTNET,
      BCH_MAINNET,
      BCH_TESTNET,
      XEC_MAINNET,
      XEC_TESTNET,
      LTC_MAINNET,
      LTC_TESTNET,
    ]) {
      const parsed = must(parseHeader(btcHeaderBytes, chain))
      expect(parsed).toEqual(sampleBtcHeader)
      expect(headerHash(parsed).ok).toBe(true)

      expect(parseHeader(lotusHeaderBytes, chain)).toEqual({
        ok: false,
        error: {
          code: 'block-header-length',
          expected: BITCOIN_HEADER_BYTES,
          actual: LOTUS_HEADER_BYTES,
        },
      })
    }

    // 2. not-bitcoin-80 chains (XPI)
    for (const chain of [XPI_MAINNET, XPI_TESTNET]) {
      const parsed = must(parseHeader(lotusHeaderBytes, chain))
      expect(parsed).toEqual(sampleLotusHeader)
      expect(headerHash(parsed).ok).toBe(true)

      expect(parseHeader(btcHeaderBytes, chain)).toEqual({
        ok: false,
        error: {
          code: 'block-header-shape',
          expected: LOTUS_HEADER_BYTES,
          actual: BITCOIN_HEADER_BYTES,
          reason: expect.stringContaining('lotusd'),
        },
      })
    }

    // 3. auxpow-variable chains (DOGE)
    for (const chain of [DOGE_MAINNET, DOGE_TESTNET]) {
      expect(parseHeader(btcHeaderBytes, chain)).toEqual({
        ok: false,
        error: {
          code: 'block-header-shape',
          reason: expect.stringContaining('AuxPoW'),
        },
      })
      expect(parseMerkleBlock(btcHeaderBytes, chain)).toEqual({
        ok: false,
        error: {
          code: 'block-header-shape',
          reason: expect.stringContaining('AuxPoW'),
        },
      })
    }
  })
})
