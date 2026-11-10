# Tempo generic transfer admission — Tier 3

Accepted outcome: preserve Tempo's dedicated PathUSD wallet panel and balance visibility while removing Tempo from generic native-send routes and generic chat payment choices whose owner acquisition cannot support it.

Observed failure: `nativeSendChainIdentifier` returns Tempo despite `nativeDecimals: null`; `configuredStealthAssets` lists Tempo pathUSD from its adapter, but availability/review acquires `createNativeTransferContext`, whose EVM owner rejects Tempo. The wallet page already hides the generic send button for Tempo through its ancestor panel gate; it renders a separate `TempoPathUsdPanel` with its own wallet instead. This change does not claim that dedicated implementation is absent or proven live.

Current ownership: canonical registry owns identity; client chain metadata owns native denomination and wallet availability; dedicated Tempo composition owns PathUSD operations. Generic native-transfer composition owns family wallet acquisition, and generic chat payment review uses that acquisition. Target ownership is unchanged: admission reads the existing `nativeDecimals: null` fact before offering a generic route/choice or acquiring a native wallet. No new network-name switches or competing capability table.

Scope: app native-send utility, native-transfer context admission, configured stealth asset listing, and adjacent tests including the actual Wallet panel boundary. Preserve EVM, Solana and Bitcoin-family positive routes and choices. Retain walletSupport availability and dedicated Tempo panel operations. No transfer implementation, new subsystem, protocol/wire/persistence format, derivation, migration, relay config, funding, or recovery policy change.

Invariants: generic native owner acquisition must reject no-native-coin networks before custody, RPC, signing or stores open; listing stays pure and never acquires custody. Existing authorized operations and dedicated Tempo journals remain untouched. Mainnet/testnet canonical identity is preserved.

Proof: add fail-before regressions for both Tempo network IDs in generic route and stealth choices, and direct context rejection before EVM owner acquisition; test wallet page keeps dedicated Tempo panel and lacks generic native send. Existing EVM/Solana/UTXO positive selections remain checked. Run focused app suites and `yarn typecheck:fast` only when coordinator grants test capacity, followed by independent review. No claim of funded/public-network proof.

No replacement stages or temporary coexistence are introduced. No durable record shape changes; cost-of-reversal questions do not apply. Root coordinates unresolved scope, runtime scheduling, review and integration. Rollback is a code revert; it must not delete wallet data. Candidate remains local until root authorizes publication.
