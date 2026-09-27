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
//! [`frank_network_tag`], a process-wide [`OnceLock`] mirroring `crate::http::monad_message`'s/
//! `crate::http::monad_topics`'s own gate-config convention. Lives in its own module (rather than
//! duplicated in each of those, the way `MONAD_TESTNET_HTTP_RPC_URL`/`MONAD_STAMP_BURN_ADDRESS`
//! are) because both need it and this ticket already touches both modules, so there's no reason to
//! repeat the env-read.
//!
//! Deliberately **optional** (unlike the burn-verification gate configs, which fail every request
//! closed when misconfigured, since an unverified stamp must never be silently accepted): an unset
//! `FRANK_NETWORK_TAG` simply means newly-stored records get an empty tag -- indistinguishable
//! from records stored before this ticket shipped, which the acceptance criteria already require
//! to decode fine. This is metadata for client-side mismatch detection, not a correctness gate, so
//! failing every `PUT` closed just because an operator hasn't set this yet would be a worse
//! default than "starts out untagged." (Judgment call -- the issue doesn't specify required vs.
//! optional; see this ticket's handoff for the full reasoning.)

use std::sync::OnceLock;

/// Monad testnet (see `.env.example`'s `MONAD_TESTNET_HTTP_RPC_URL`).
pub const MONAD_TESTNET_NETWORK_TAG: &[u8; 4] = b"MONT";

/// Monad mainnet (see `.env.example`'s `MONAD_MAINNET_HTTP_RPC_URL`).
pub const MONAD_MAINNET_NETWORK_TAG: &[u8; 4] = b"MON1";

/// Parse a raw `FRANK_NETWORK_TAG` env var value into the bytes stamped onto stored records: its
/// literal UTF-8 encoding, since the wire field is `bytes` (not `string`) and this repo's tag
/// constants are plain ASCII. `None` (unset) yields empty bytes -- see this module's docs for why
/// that's a deliberate fail-open default rather than a misconfiguration error. Kept as a pure
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
}
