//! Store provides structs for storing and retrieving registry data.
//! Database is RocksDB, keys for metadata are (compact) scripts, values are protobuf encoded.

pub mod blob_store;
pub mod db;
pub(crate) mod directory_preview;
pub mod directory_store;
pub(crate) mod directory_subjects;
pub mod directory_usernames;
pub(crate) mod evm_direct_messages;
pub mod evm_profiles;
pub(crate) mod forum;
pub mod groups;
pub mod kv_store;
pub mod large_values;
pub mod metadata;
pub mod notification_policy;
pub mod pubkeyhash;
pub mod s3_objects;
pub mod topics;

#[cfg(feature = "foundationdb")]
pub mod foundationdb_driver;
#[cfg(all(test, feature = "foundationdb"))]
mod registry_fdb_tests;
