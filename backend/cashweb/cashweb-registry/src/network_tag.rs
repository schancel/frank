//! Frank-specific network tag stamped onto Monad wire envelopes (ticket #39, see PLAN.md
//! constraint 9 for the full design rationale).
//!
//! Once one relay deployment could plausibly serve multiple chains (PLAN.md constraint 2's whole
//! point), a client needs a way to tell which network a given stored record was actually verified
//! against, so it can detect "the relay I'm talking to is on a different network than I expect."
//! A raw EVM `chainId` doesn't generalize for this -- Lotus (and any future non-EVM
//! [`cashweb_payload::chain_adapter::ChainAdapter`]) has no such concept, so tagging at that level
//! would tie the wire format back to EVM specifically, which constraint 2 explicitly avoids.
//! Instead, this is a short Frank/Stamp-specific tag, stamped by the relay from its own
//! configuration -- never embedded in on-chain calldata (already committed-to by every existing
//! client/relay) and never derived from *which* RPC URL happens to be configured (fragile and
//! silently wrong if an operator points `MONAD_TESTNET_HTTP_RPC_URL` at a different network
//! without also updating this).
//!
//! This lands on the *stored/served* envelopes only (`proto::StoredMonadMessage`,
//! `proto::StoredMonadTopicPost`) -- never the client-submitted `proto::MonadStampedMessage`/
//! `proto::MonadTopicPost` -- since the relay is the one asserting which network it actually
//! verified against; the client can't meaningfully assert this itself.
//!
//! Client-side mismatch detection (warning/rejecting when a fetched tag doesn't match what a
//! client expects) is deliberately out of scope here -- this ticket only needs the field to
//! exist, be populated by the relay, and be decodable. A real follow-on once there's an actual
//! second network to compare against.
//!
//! ## Reserved tag values
//!
//! 4-byte, LOKAD-style codes (exact strings were this ticket's call, per the issue):
//! - [`MONAD_TESTNET_NETWORK_TAG`] (`"MONT"`) -- Monad testnet.
//! - [`MONAD_MAINNET_NETWORK_TAG`] (`"MON1"`) -- Monad mainnet.
//! - `"LTUS"` -- reserved for a hypothetical future Lotus [`cashweb_payload::chain_adapter::
//!   ChainAdapter`]. Not defined as a Rust constant here since nothing in this codebase emits it
//!   yet (Lotus stays pluggable-but-unused per PLAN.md constraint 2) -- documented here only so
//!   the code point isn't picked twice by whoever eventually wires it up.
//!
//! ## Configuration
//!
//! `FRANK_NETWORK_TAG` (see `.env.example`), read once from the environment via
//! [`frank_network_tag`], a process-wide [`OnceLock`] mirroring `crate::http::monad_topics`'s own
//! gate-config convention. `cashwebd-exe` reads it once at startup and hands it to the enabled
//! mailbox runtime (`crate::monad_mailbox::MonadMailboxRuntime`), which admits only envelopes
//! carrying that tag; the topic routes read it directly.
//!
//! **Required when the durable Monad mailbox is enabled** (the shipped default): the relay admits
//! only envelopes whose `networkTag` equals this value, so an unset or invalid tag would reject
//! every direct message. `cashwebd-exe` therefore refuses to start (and `--check-config` fails)
//! unless [`is_valid_network_tag`] accepts it. With the mailbox disabled the variable stays
//! optional: an unset value only means newly-stored topic records get an empty tag, the same as
//! records stored before ticket #39, which must keep decoding. Topic routes are unaffected by
//! the startup check.

use std::sync::OnceLock;

/// Monad testnet (see `.env.example`'s `MONAD_TESTNET_HTTP_RPC_URL`).
pub const MONAD_TESTNET_NETWORK_TAG: &[u8; 4] = b"MONT";

/// Monad mainnet (see `.env.example`'s `MONAD_MAINNET_HTTP_RPC_URL`).
pub const MONAD_MAINNET_NETWORK_TAG: &[u8; 4] = b"MON1";

/// Longest network tag, in UTF-8 bytes, that an envelope's `networkTag` may carry. Shared by the
/// relay's envelope validation and the startup check so the two cannot drift.
pub const MAX_NETWORK_TAG_BYTES: usize = 32;

/// Whether `tag` is a usable network tag: 1..=[`MAX_NETWORK_TAG_BYTES`] bytes (the relay's shape
/// rule for an envelope's `networkTag`) with no surrounding or blank whitespace, which no client
/// would ever send and so would make the relay reject every direct message.
pub fn is_valid_network_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= MAX_NETWORK_TAG_BYTES && tag.trim() == tag
}

/// One deployable Monad network's identities at the relay boundary.
///
/// Keeping the wire tag, Frank-CBOR identifier, and EVM chain ID in one row prevents a relay from
/// validating a frame for one network while broadcasting its burn on another (ticket #327).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MonadNetworkDescriptor {
    /// Four-byte Frank network tag stamped on stored records.
    pub network_tag: &'static [u8; 4],
    /// Lowercase identifier carried by Frank-CBOR frames.
    pub cbor_identifier: &'static str,
    /// EIP-155/EIP-1559 chain ID signed by every transaction on this network.
    pub evm_chain_id: u64,
}

/// The authoritative deployment mapping. Adding a Monad network is adding one complete row here;
/// the existing tag bytes and CBOR identifiers never change.
pub const MONAD_NETWORKS: &[MonadNetworkDescriptor] = &[
    MonadNetworkDescriptor {
        network_tag: MONAD_TESTNET_NETWORK_TAG,
        cbor_identifier: "monad-testnet",
        evm_chain_id: 10_143,
    },
    MonadNetworkDescriptor {
        network_tag: MONAD_MAINNET_NETWORK_TAG,
        cbor_identifier: "monad-mainnet",
        evm_chain_id: 143,
    },
];

/// Resolve all of the relay identities for `tag`, or `None` when the tag is not a configured
/// Monad deployment (which startup and `--check-config` refuse).
pub fn monad_network(tag: &[u8]) -> Option<&'static MonadNetworkDescriptor> {
    MONAD_NETWORKS.iter().find(|network| {
        network.network_tag.as_slice() == tag || network.cbor_identifier.as_bytes() == tag
    })
}

/// The Frank-CBOR network identifier for a relay network tag, or `None` for a tag with no mapping
/// (which startup and `--check-config` refuse).
pub fn cbor_network_identifier(tag: &[u8]) -> Option<&'static str> {
    monad_network(tag).map(|network| network.cbor_identifier)
}

/// Parse a raw `FRANK_NETWORK_TAG` env var value into the bytes stamped onto stored records: its
/// literal UTF-8 encoding, since the wire field is `bytes` (not `string`) and this repo's tag
/// constants are plain ASCII. `None` (unset) yields empty bytes -- see this module's docs for why
/// that is the fail-open default for topic records; an enabled mailbox is stricter (see the module docs and [`is_valid_network_tag`]). Kept as a pure
/// function, separate from [`frank_network_tag`]'s process-wide caching, so it's directly
/// unit-testable without touching real process environment state.
fn parse_network_tag(raw: Option<String>) -> Vec<u8> {
    raw.map(String::into_bytes).unwrap_or_default()
}

/// Read `FRANK_NETWORK_TAG` from the environment once per process (see module docs), returning
/// the bytes [`crate::registry::Registry::put_monad_message`]/[`crate::registry::Registry::
/// put_monad_topic_post`] stamp onto every newly-stored record.
pub fn frank_network_tag() -> &'static [u8] {
    static TAG: OnceLock<Vec<u8>> = OnceLock::new();
    TAG.get_or_init(|| parse_network_tag(std::env::var("FRANK_NETWORK_TAG").ok()))
        .as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validity_matches_the_relay_shape_rule_and_rejects_blank_tags() {
        assert!(is_valid_network_tag("MONT"));
        assert!(is_valid_network_tag(&"x".repeat(MAX_NETWORK_TAG_BYTES)));
        assert!(!is_valid_network_tag(
            &"x".repeat(MAX_NETWORK_TAG_BYTES + 1)
        ));
        for bad in ["", " ", "\t", " MONT", "MONT ", "MONT\n"] {
            assert!(!is_valid_network_tag(bad), "{bad:?}");
        }
    }

    #[test]
    fn empty_when_unset() {
        assert_eq!(parse_network_tag(None), Vec::<u8>::new());
    }

    #[test]
    fn passes_configured_value_through_as_utf8_bytes() {
        assert_eq!(
            parse_network_tag(Some("MONT".to_string())),
            MONAD_TESTNET_NETWORK_TAG.to_vec()
        );
        assert_eq!(
            parse_network_tag(Some("MON1".to_string())),
            MONAD_MAINNET_NETWORK_TAG.to_vec()
        );
    }

    #[test]
    fn maps_known_tags_to_cbor_identifiers_and_their_evm_chains() {
        assert_eq!(cbor_network_identifier(b"MONT"), Some("monad-testnet"));
        assert_eq!(cbor_network_identifier(b"MON1"), Some("monad-mainnet"));
        assert_eq!(monad_network(b"MONT").unwrap().evm_chain_id, 10_143);
        assert_eq!(monad_network(b"MON1").unwrap().evm_chain_id, 143);
        for network in MONAD_NETWORKS {
            let bytes = network.cbor_identifier.as_bytes();
            assert!(bytes.len() <= 64 && bytes[0].is_ascii_alphanumeric());
            assert!(bytes.iter().all(|c| c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || matches!(c, b'.' | b'_' | b'-')));
        }
    }

    #[test]
    fn unknown_or_differently_cased_tags_have_no_identifier() {
        for tag in [&b""[..], b"mont", b"MONX", b"MONT ", b"LTUS"] {
            assert_eq!(cbor_network_identifier(tag), None);
            assert_eq!(monad_network(tag), None);
        }
    }
}
