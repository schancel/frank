//! Four-byte Frank network tags: one per canonical chain in `docs/protocol/chains/v1.json`.
//!
//! The relay binds the tag of its network (`[registry] network`, see
//! [`crate::chains::RelayChains::network_tag`]) into every signed relay request and stamps it on
//! newly admitted envelopes, so a client can tell which network a record was verified against.
//! The tag is derived from the configured canonical chain identifier, never read separately.
//!
//! `"LTUS"` is reserved for a future Lotus chain adapter; nothing emits it yet.

/// Monad testnet.
pub const MONAD_TESTNET_NETWORK_TAG: &[u8; 4] = b"MONT";

/// Monad mainnet.
pub const MONAD_MAINNET_NETWORK_TAG: &[u8; 4] = b"MON1";

/// Tag of a local Monad network (monad-solonet): chain ID 20143, a network in its own right.
pub const MONAD_REGTEST_NETWORK_TAG: &[u8; 4] = b"MONR";

/// Four-byte wire tag mapping for every canonical chain in [`cashweb_config::protocol_chain_registry`],
/// aligned with `@frank/wallet/chain/chains-registry` on the frontend.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolNetworkTagEntry {
    /// Four-byte ASCII wire tag (e.g. `b"MONT"`, `b"ETH1"`, `b"SOL1"`, `b"XECT"`).
    pub network_tag: &'static [u8; 4],
    /// Canonical protocol chain identifier in `docs/protocol/chains/v1.json`.
    pub chain_id: &'static str,
}

/// Canonical 4-byte wire tags for all chains in `docs/protocol/chains/v1.json`.
pub const PROTOCOL_NETWORK_TAGS: &[ProtocolNetworkTagEntry] = &[
    ProtocolNetworkTagEntry {
        network_tag: MONAD_MAINNET_NETWORK_TAG,
        chain_id: "monad-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: MONAD_TESTNET_NETWORK_TAG,
        chain_id: "monad-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: MONAD_REGTEST_NETWORK_TAG,
        chain_id: "monad-regtest",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BTC1",
        chain_id: "btc-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BTCT",
        chain_id: "btc-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BTC4",
        chain_id: "btc-testnet4",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BTCR",
        chain_id: "btc-regtest",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BCH1",
        chain_id: "bch-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BCHT",
        chain_id: "bch-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BCHR",
        chain_id: "bch-regtest",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"XEC1",
        chain_id: "xec-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"XECT",
        chain_id: "xec-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"XECR",
        chain_id: "xec-regtest",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"XPI1",
        chain_id: "xpi-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"XPIT",
        chain_id: "xpi-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"XPIR",
        chain_id: "xpi-regtest",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"SOL1",
        chain_id: "solana-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"SOLD",
        chain_id: "solana-devnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"SOLT",
        chain_id: "solana-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"HYPE",
        chain_id: "hyperliquid-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"HYPT",
        chain_id: "hyperliquid-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"TMPO",
        chain_id: "tempo-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"TMPT",
        chain_id: "tempo-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"ETH1",
        chain_id: "ethereum-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"SEPO",
        chain_id: "ethereum-sepolia",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"DOGE",
        chain_id: "doge-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"DOGT",
        chain_id: "doge-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BASE",
        chain_id: "base-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BSES",
        chain_id: "base-sepolia",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"ARB1",
        chain_id: "arbitrum-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"ARBS",
        chain_id: "arbitrum-sepolia",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"POL1",
        chain_id: "polygon-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"AMOY",
        chain_id: "polygon-amoy",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BSC1",
        chain_id: "bnb-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"BSCT",
        chain_id: "bnb-testnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"LTC1",
        chain_id: "litecoin-mainnet",
    },
    ProtocolNetworkTagEntry {
        network_tag: b"LTCT",
        chain_id: "litecoin-testnet",
    },
];

/// Look up the 4-byte wire network tag for any canonical protocol `chain_id`.
pub fn network_tag_for_chain_id(chain_id: &str) -> Option<&'static [u8; 4]> {
    PROTOCOL_NETWORK_TAGS
        .iter()
        .find(|entry| entry.chain_id == chain_id)
        .map(|entry| entry.network_tag)
}

/// Look up the canonical `chain_id` for a 4-byte wire tag or canonical identifier.
pub fn chain_id_for_network_tag(tag: &[u8]) -> Option<&'static str> {
    if let Some(entry) = PROTOCOL_NETWORK_TAGS
        .iter()
        .find(|entry| entry.network_tag.as_slice() == tag || entry.chain_id.as_bytes() == tag)
    {
        return Some(entry.chain_id);
    }
    let text = std::str::from_utf8(tag).ok()?;
    cashweb_config::protocol_chain(text)
        .or_else(|| cashweb_config::protocol_chain_by_caip2(text))
        .map(|chain| chain.id.as_str())
}

/// Resolve the [`cashweb_config::ProtocolChainDescriptor`] for any 4-byte wire tag, canonical
/// `chain_id`, or CAIP-2 string in `docs/protocol/chains/v1.json`.
pub fn protocol_chain_for_tag(
    tag_or_id: &[u8],
) -> Option<&'static cashweb_config::ProtocolChainDescriptor> {
    let chain_id = chain_id_for_network_tag(tag_or_id)?;
    cashweb_config::protocol_chain(chain_id)
}

/// Resolve the numeric EIP-155 chain ID for any EVM chain by 4-byte wire tag, canonical `chain_id`,
/// or CAIP-2 identifier.
pub fn evm_chain_id_for_tag(tag_or_id: &[u8]) -> Option<u64> {
    protocol_chain_for_tag(tag_or_id)?.evm_chain_id()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn bridges_every_protocol_chain_registry_entry_with_unique_wire_tags() {
        let registry = cashweb_config::protocol_chain_registry();
        let mut seen_tags = HashSet::new();
        for chain in &registry.chains {
            let tag = network_tag_for_chain_id(&chain.id)
                .unwrap_or_else(|| panic!("missing 4-byte wire tag for {}", chain.id));
            assert!(
                seen_tags.insert(tag),
                "duplicate 4-byte wire tag {:?} for {}",
                std::str::from_utf8(tag),
                chain.id
            );
            assert_eq!(chain_id_for_network_tag(tag), Some(chain.id.as_str()));
            assert_eq!(
                chain_id_for_network_tag(chain.id.as_bytes()),
                Some(chain.id.as_str())
            );
            let resolved = protocol_chain_for_tag(tag).unwrap();
            assert_eq!(resolved.id, chain.id);
            assert_eq!(resolved.family, chain.family);
            assert_eq!(resolved.evm_chain_id(), evm_chain_id_for_tag(tag));
        }
    }

    #[test]
    fn unknown_or_differently_cased_tags_have_no_chain() {
        for tag in [&b""[..], b"mont", b"MONX", b"MONT ", b"LTUS"] {
            assert_eq!(chain_id_for_network_tag(tag), None);
        }
    }
}
