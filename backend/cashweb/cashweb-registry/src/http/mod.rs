//! Modules for an HTTP endpoint for the Cashweb Registry.

pub mod bitcoin_proxy;
pub mod curated_defaults;
pub mod directory;
pub(crate) mod electrum_proxy;
pub mod error;
pub mod evm_rpc;
pub(crate) mod hourly_quota;
pub(crate) mod json_rpc;
pub(crate) mod monad_message_cbor;
pub mod monad_profile;
pub mod monad_topics;
pub mod pop_protection;
pub mod server;
pub mod solana_proxy;
pub(crate) mod upstream_cooldown;
pub mod usernames;
