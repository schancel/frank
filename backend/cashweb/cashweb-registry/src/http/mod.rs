//! Modules for an HTTP endpoint for the Cashweb Registry.

pub mod bitcoin_proxy;
pub mod curated_defaults;
pub mod directory;
pub(crate) mod electrum_proxy;
pub mod error;
pub(crate) mod evm_direct_messages;
pub mod evm_profile;
pub mod evm_rpc;
pub mod evm_topics;
pub mod groups;
pub(crate) mod hourly_quota;
pub(crate) mod json_rpc;
pub mod oracle;
pub mod pop_protection;
pub mod server;
pub mod solana_proxy;
pub(crate) mod upstream_cooldown;
pub mod usernames;
