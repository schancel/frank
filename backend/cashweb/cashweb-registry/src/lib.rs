#![warn(
    missing_debug_implementations,
    missing_docs,
    rust_2018_idioms,
    unreachable_pub
)]

//! `cashweb-registry` is a library for the Registry part of a CashWeb server.
//! It allows storing and retrieving metadata by addresses (scripts).

pub mod chains;
pub mod directory_admission;
pub mod directory_federation;
pub mod directory_runtime;
pub mod disabled_chain_adapter;
pub mod events;
pub(crate) mod evm_dm_payment;
pub mod evm_dm_verify;
pub mod evm_mailbox;
pub mod evm_pop_verify;
pub mod evm_profile_verify;
pub mod evm_rpc;
pub mod evm_stamp_relay;
pub mod evm_stamp_stealth;
pub mod evm_stamp_verify;
pub mod evm_topic_cbor;
pub mod evm_topic_relay;
pub mod evm_topic_verify;
pub mod evm_transaction;
pub mod evm_ws;
pub(crate) mod forum;
pub mod group_write_payment;
pub mod http;
pub mod lotus_adapter;
pub mod metrics;
pub mod network_tag;
pub mod oracle;
pub mod p2p;
pub mod provisioned;
pub mod registry;
pub mod store;
pub mod test_instance;

use cashweb_payload::proto as payload;
pub mod proto {
    //! Protobuf structs for SignedPayload.
    include!(concat!(env!("OUT_DIR"), "/cashweb.registry.rs"));
}
