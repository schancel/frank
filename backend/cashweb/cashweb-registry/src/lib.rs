#![warn(
    missing_debug_implementations,
    missing_docs,
    rust_2018_idioms,
    unreachable_pub
)]

//! `cashweb-registry` is a library for the Registry part of a CashWeb server.
//! It allows storing and retrieving metadata by addresses (scripts).

pub mod directory_admission;
pub mod directory_federation;
pub mod directory_runtime;
pub mod disabled_chain_adapter;
pub mod events;
pub(crate) mod forum;
pub mod http;
pub mod lotus_adapter;
pub mod monad_adapter;
pub(crate) mod monad_dm_payment;
pub mod monad_dm_verify;
pub mod monad_evm_tx;
pub mod monad_http;
pub mod monad_mailbox;
pub mod monad_pop_verify;
pub mod monad_profile_verify;
pub mod monad_stamp_relay;
pub mod monad_stamp_stealth;
pub mod monad_stamp_verify;
pub mod monad_topic_cbor;
pub mod monad_topic_relay;
pub mod monad_topic_verify;
pub mod monad_ws;
pub mod network_tag;
pub mod p2p;
pub mod registry;
pub mod store;
pub mod test_instance;

use cashweb_payload::proto as payload;
pub mod proto {
    //! Protobuf structs for SignedPayload.
    include!(concat!(env!("OUT_DIR"), "/cashweb.registry.rs"));
}
