//! Canonical chain identifiers from the protocol registry `docs/protocol/chains/v1.json`, the one
//! source shared with the TypeScript codec (`packages/frank-codec/src/chain-registry.ts`). A
//! payment that names the chain it settles on must name one of these.

const PROTOCOL_CHAIN_REGISTRY_V1: &str = include_str!("../../../../docs/protocol/chains/v1.json");

/// Every `"id": "<value>"` string in the registry, in file order. Only the chain rows carry an
/// `id` key; the unit test below checks this scan against a full JSON parse.
fn registry_ids() -> impl Iterator<Item = &'static str> {
    let text = PROTOCOL_CHAIN_REGISTRY_V1;
    text.match_indices("\"id\"").filter_map(move |(at, key)| {
        let rest = text[at + key.len()..].trim_start();
        let rest = rest.strip_prefix(':')?.trim_start();
        let rest = rest.strip_prefix('"')?;
        rest.find('"').map(|end| &rest[..end])
    })
}

/// True when `id` is exactly a canonical chain `id` in `docs/protocol/chains/v1.json`.
pub fn is_protocol_chain_identifier(id: &str) -> bool {
    registry_ids().any(|known| known == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_matches_the_parsed_registry() {
        let parsed: serde_json::Value = serde_json::from_str(PROTOCOL_CHAIN_REGISTRY_V1).unwrap();
        let ids: Vec<&str> = parsed["chains"]
            .as_array()
            .unwrap()
            .iter()
            .map(|chain| chain["id"].as_str().unwrap())
            .collect();
        assert!(!ids.is_empty());
        assert_eq!(registry_ids().collect::<Vec<_>>(), ids);
        assert!(is_protocol_chain_identifier("monad-testnet"));
        assert!(is_protocol_chain_identifier("xpi-mainnet"));
        for unknown in ["monad", "lotus", "zz-not-a-chain", "monad-testnet ", ""] {
            assert!(!is_protocol_chain_identifier(unknown), "{unknown:?}");
        }
    }
}
