//! Unique usernames: a name points to exactly one account key, and a key holds at most one name.
//!
//! A name is taken by a *claim*: a `cashweb_payload::proto::SignedPayload` (the same envelope a
//! profile uses, checked by [`crate::monad_profile_verify::verify_signed_payload`]) whose payload
//! is the text built by [`claim_text`], signed by the key the name will point to. The stored
//! record keeps those exact bytes, so a record is a self-contained signed statement: anyone,
//! including another relay, can re-check it with [`verify_claim`] without trusting this store.
//!
//! Rules, all enforced in [`DbDirectoryUsernames::claim`]:
//! - the first key to claim a name holds it; a different key is refused ([`UsernameError::Taken`]);
//! - the holder claiming its own name again changes nothing;
//! - a key claiming a different name releases the one it held, but only with a claim issued
//!   later than the one it replaces, so an old claim cannot be replayed to move a key back.
//!
//! Layout of the `directory_usernames` column family: `n` + name -> record (JSON), and
//! `a` + 20-byte address -> name.

use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use bitcoinsuite_error::Result;
use prost::Message;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::OnceLock};
use thiserror::Error;

use crate::{
    monad_profile_verify::verify_signed_payload,
    store::db::{Db, CF},
};

/// Column family holding username records.
pub const CF_DIRECTORY_USERNAMES: &str = "directory_usernames";
/// First line of every claim. Nothing else an account signs starts with it.
pub const CLAIM_DOMAIN: &str = "frank-username-claim-v1";
/// Largest claim accepted. A real one is under 250 bytes.
pub const MAX_CLAIM_BYTES: u64 = 1024;
/// Most names one search returns.
pub const MAX_SEARCH_RESULTS: usize = 100;
/// A claim may be issued this far ahead of the relay's clock, no further.
const MAX_FUTURE_MS: u64 = 10 * 60 * 1000;

/// Why a name or a claim was refused.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum UsernameError {
    /// The name is not 3 to 32 of `a-z 0-9 - _` starting with a letter or digit.
    #[error("Invalid username: {0}")]
    InvalidName(String),
    /// The claim is malformed, wrongly signed, for another network, or issued in the future.
    #[error("Invalid username claim: {0}")]
    InvalidClaim(String),
    /// Another key already holds this name.
    #[error("This username is already taken")]
    Taken,
    /// The key has since claimed another name with a later claim.
    #[error("This claim is older than the one this account already made")]
    Stale,
    /// Operational mailbox names cannot be claimed by any account key.
    #[error("This username is reserved for mail operations")]
    Reserved,
}

impl UsernameError {
    /// Stable machine-readable code sent to clients.
    pub fn code(&self) -> &'static str {
        match self {
            UsernameError::InvalidName(_) => "invalid-username",
            UsernameError::InvalidClaim(_) => "invalid-claim",
            UsernameError::Taken => "taken",
            UsernameError::Stale => "stale-claim",
            UsernameError::Reserved => "reserved-username",
        }
    }
}

use self::UsernameError::*;

/// One source for the case-insensitive operational local parts that may never become a user
/// handle or user-issued mailbox. Existing stored claims are not modified by this policy.
pub fn is_operational_local_part(raw: &str) -> bool {
    static NAMES: OnceLock<BTreeSet<String>> = OnceLock::new();
    NAMES
        .get_or_init(|| {
            serde_json::from_str::<Vec<String>>(include_str!(
                "../../../../../docs/protocol/mail/reserved-local-parts-v1.json"
            ))
            .expect("valid operational mail policy")
            .into_iter()
            .collect()
        })
        .contains(&raw.trim().to_ascii_lowercase())
}

/// The canonical form of a name: trimmed, one leading `@` dropped, ASCII lower-case, then 3 to
/// 32 characters of `a-z 0-9 - _` starting with a letter or digit. This is the only definition
/// of a valid name; clients may pre-check but the relay decides.
pub fn normalize(raw: &str) -> std::result::Result<String, UsernameError> {
    let trimmed = raw.trim();
    let name = trimmed
        .strip_prefix('@')
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    if !(3..=32).contains(&name.len()) {
        return Err(InvalidName("use 3 to 32 characters".to_string()));
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    {
        return Err(InvalidName(
            "use only letters, digits, hyphens and underscores".to_string(),
        ));
    }
    if matches!(name.as_bytes()[0], b'-' | b'_') {
        return Err(InvalidName("start with a letter or digit".to_string()));
    }
    Ok(name)
}

/// The operator's reserved names (`[registry.directory] reserved_usernames`: name -> key hex)
/// with names in canonical form and keys decoded. `None` when a name is not a valid username,
/// a key is not 33 bytes of hex starting 02 or 03, or two spellings give the same name.
pub fn reserved(
    configured: &std::collections::BTreeMap<String, String>,
) -> Option<std::collections::BTreeMap<String, [u8; 33]>> {
    let mut reserved = std::collections::BTreeMap::new();
    for (name, key) in configured {
        let key: [u8; 33] = hex::decode(key).ok()?.try_into().ok()?;
        if !matches!(key[0], 2 | 3) || reserved.insert(normalize(name).ok()?, key).is_some() {
            return None;
        }
    }
    Some(reserved)
}

/// The text a key signs to claim `username` (already canonical) on `network`.
pub fn claim_text(network: &str, username: &str, issued_ms: u64) -> String {
    format!("{CLAIM_DOMAIN}\n{network}\n{username}\n{issued_ms}")
}

/// One name and the key holding it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsernameRecord {
    /// Canonical name.
    pub username: String,
    /// Compressed secp256k1 key the name points to: the subject of its directory entry.
    pub subject: [u8; 33],
    /// Address of that key.
    pub address: [u8; 20],
    /// When the holder says it signed the claim, Unix milliseconds.
    pub issued_ms: u64,
    /// When this relay accepted the claim, Unix milliseconds. Zero until stored.
    pub accepted_ms: u64,
    /// The exact signed claim (`SignedPayload` bytes).
    pub claim: Vec<u8>,
}

/// Check a signed claim made for `network` and return what it claims. Verifies the signature
/// against the key named in the claim itself; whether the name is free is the store's question.
pub fn verify_claim(
    ecc: &EccSecp256k1,
    claim: &[u8],
    network: &str,
    now_ms: u64,
) -> std::result::Result<UsernameRecord, UsernameError> {
    if claim.len() as u64 > MAX_CLAIM_BYTES {
        return Err(InvalidClaim("too large".to_string()));
    }
    let signed = cashweb_payload::proto::SignedPayload::decode(claim)
        .map_err(|_| InvalidClaim("not a signed payload".to_string()))?;
    let signer =
        verify_signed_payload(ecc, &signed).map_err(|err| InvalidClaim(err.to_string()))?;
    let text = std::str::from_utf8(&signed.payload)
        .map_err(|_| InvalidClaim("payload is not text".to_string()))?;
    let lines: Vec<&str> = text.split('\n').collect();
    let [domain, claimed_network, username, issued] = lines.as_slice() else {
        return Err(InvalidClaim("payload is not a username claim".to_string()));
    };
    if *domain != CLAIM_DOMAIN {
        return Err(InvalidClaim("payload is not a username claim".to_string()));
    }
    if *claimed_network != network {
        return Err(InvalidClaim(format!(
            "claim is for network {claimed_network:?}, this relay serves {network:?}"
        )));
    }
    if normalize(username)? != *username {
        return Err(InvalidClaim(
            "the signed name is not in canonical form".to_string(),
        ));
    }
    let issued_ms: u64 = issued
        .parse()
        .ok()
        .filter(|ms: &u64| ms.to_string() == *issued)
        .ok_or_else(|| InvalidClaim("bad issue time".to_string()))?;
    if issued_ms > now_ms.saturating_add(MAX_FUTURE_MS) {
        return Err(InvalidClaim("issued in the future".to_string()));
    }
    Ok(UsernameRecord {
        username: username.to_string(),
        subject: signer.pubkey,
        address: signer.address.0,
        issued_ms,
        accepted_ms: 0,
        claim: claim.to_vec(),
    })
}

/// What an accepted claim did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimOutcome {
    /// The key now holds the name (and no longer holds any name it held before).
    Claimed,
    /// The key already held the name; nothing changed.
    Unchanged,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    subject: String,
    address: String,
    issued_ms: u64,
    accepted_ms: u64,
    claim: String,
}

fn name_key(name: &str) -> Vec<u8> {
    [b"n", name.as_bytes()].concat()
}

fn address_key(address: &[u8; 20]) -> Vec<u8> {
    [b"a".as_slice(), address].concat()
}

/// RocksDB store of username records.
pub struct DbDirectoryUsernames<'a> {
    db: &'a Db,
    cf: &'a CF,
}

impl std::fmt::Debug for DbDirectoryUsernames<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbDirectoryUsernames").finish()
    }
}

impl<'a> DbDirectoryUsernames<'a> {
    pub(crate) fn new(db: &'a Db) -> Self {
        let cf = db.cf(CF_DIRECTORY_USERNAMES).unwrap();
        Self { db, cf }
    }

    pub(crate) fn add_cfs(cfs: &mut Vec<ColumnFamilyDescriptor>) {
        cfs.push(ColumnFamilyDescriptor::new(
            CF_DIRECTORY_USERNAMES,
            rocksdb::Options::default(),
        ));
    }

    fn decode(username: &str, bytes: &[u8]) -> Result<UsernameRecord> {
        let stored: Stored = serde_json::from_slice(bytes)?;
        let fixed = |hex_text: &str| hex::decode(hex_text).ok();
        let (Some(subject), Some(address), Some(claim)) = (
            fixed(&stored.subject).and_then(|b| b.try_into().ok()),
            fixed(&stored.address).and_then(|b| b.try_into().ok()),
            fixed(&stored.claim),
        ) else {
            return Err(bitcoinsuite_error::Report::msg(format!(
                "corrupt username record for {username:?}"
            )));
        };
        Ok(UsernameRecord {
            username: username.to_string(),
            subject,
            address,
            issued_ms: stored.issued_ms,
            accepted_ms: stored.accepted_ms,
            claim,
        })
    }

    /// The record of a canonical name, if someone holds it.
    pub fn get(&self, username: &str) -> Result<Option<UsernameRecord>> {
        match self.db.rocksdb().get_cf(self.cf, name_key(username))? {
            Some(bytes) => Ok(Some(Self::decode(username, &bytes)?)),
            None => Ok(None),
        }
    }

    /// The record of the name `address` holds, if any.
    pub fn of_address(&self, address: &[u8; 20]) -> Result<Option<UsernameRecord>> {
        let Some(name) = self.db.rocksdb().get_cf(self.cf, address_key(address))? else {
            return Ok(None);
        };
        let name = String::from_utf8(name)?;
        self.get(&name)
    }

    /// Up to `limit` records whose name starts with the canonical `prefix`, in name order.
    pub fn search(&self, prefix: &str, limit: usize) -> Result<Vec<UsernameRecord>> {
        let start = name_key(prefix);
        let iter = self
            .db
            .rocksdb()
            .iterator_cf(self.cf, IteratorMode::From(&start, Direction::Forward));
        let mut found = Vec::new();
        for item in iter {
            let (key, value) = item?;
            if found.len() == limit.min(MAX_SEARCH_RESULTS) || !key.starts_with(&start) {
                break;
            }
            let name = std::str::from_utf8(&key[1..])?;
            found.push(Self::decode(name, &value)?);
        }
        Ok(found)
    }

    /// Store a verified claim under the rules in the module docs. The outer error is storage;
    /// the inner one is a refusal.
    ///
    /// `reserved_for_claimant`: the operator reserved this name for the claiming key. Whoever
    /// took it before it was reserved loses it to that key.
    pub fn claim(
        &self,
        record: &UsernameRecord,
        accepted_ms: u64,
        reserved_for_claimant: bool,
    ) -> Result<std::result::Result<ClaimOutcome, UsernameError>> {
        if is_operational_local_part(&record.username) {
            return Ok(Err(Reserved));
        }
        let _guard = self.db.lock_usernames();
        let mut batch = rocksdb::WriteBatch::default();
        if let Some(holder) = self.get(&record.username)? {
            if holder.subject == record.subject {
                return Ok(Ok(ClaimOutcome::Unchanged));
            }
            if !reserved_for_claimant {
                return Ok(Err(Taken));
            }
            batch.delete_cf(self.cf, address_key(&holder.address));
        }
        if let Some(previous) = self.of_address(&record.address)? {
            if record.issued_ms <= previous.issued_ms {
                return Ok(Err(Stale));
            }
            batch.delete_cf(self.cf, name_key(&previous.username));
        }
        let stored = Stored {
            subject: hex::encode(record.subject),
            address: hex::encode(record.address),
            issued_ms: record.issued_ms,
            accepted_ms,
            claim: hex::encode(&record.claim),
        };
        batch.put_cf(
            self.cf,
            name_key(&record.username),
            serde_json::to_vec(&stored)?,
        );
        batch.put_cf(
            self.cf,
            address_key(&record.address),
            record.username.as_bytes(),
        );
        self.db.write_batch(batch)?;
        Ok(Ok(ClaimOutcome::Claimed))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use bitcoinsuite_core::{ecc::Ecc, Hashed, Sha256};
    use cashweb_payload::proto::signed_payload::SignatureScheme;
    use pretty_assertions::assert_eq;
    use rocksdb::IteratorMode;

    use super::*;

    pub(crate) const NETWORK: &str = "monad-testnet";
    pub(crate) const NOW_MS: u64 = 1_800_000_000_000;

    /// A claim exactly as a client builds it: the claim text in a `SignedPayload`, signed over
    /// its SHA-256 by the key whose secret is `secret` repeated.
    pub(crate) fn signed_claim(secret: [u8; 32], text: &str) -> Vec<u8> {
        let ecc = EccSecp256k1::default();
        let seckey = ecc.seckey_from_array(secret).unwrap();
        let payload = text.as_bytes().to_vec();
        let payload_hash = Sha256::digest(payload.clone().into());
        cashweb_payload::proto::SignedPayload {
            pubkey: ecc.derive_pubkey(&seckey).as_slice().to_vec(),
            sig: ecc
                .sign(&seckey, payload_hash.byte_array().clone())
                .to_vec(),
            sig_scheme: SignatureScheme::Ecdsa as i32,
            payload,
            payload_hash: payload_hash.as_slice().to_vec(),
            burn_amount: 0,
            burn_txs: vec![],
        }
        .encode_to_vec()
    }

    fn claim_for(secret: u8, name: &str, issued_ms: u64) -> Vec<u8> {
        signed_claim([secret; 32], &claim_text(NETWORK, name, issued_ms))
    }

    fn verified(secret: u8, name: &str, issued_ms: u64) -> UsernameRecord {
        verify_claim(
            &EccSecp256k1::default(),
            &claim_for(secret, name, issued_ms),
            NETWORK,
            NOW_MS,
        )
        .unwrap()
    }

    fn open() -> (tempdir::TempDir, Db) {
        let dir = tempdir::TempDir::new("cashweb-registry--usernames").unwrap();
        let db = Db::open(dir.path().join("db.rocksdb")).unwrap();
        (dir, db)
    }

    #[test]
    fn names_are_normalised_and_restricted() {
        assert_eq!(normalize("  @Alice_01 ").unwrap(), "alice_01");
        assert_eq!(normalize("a-b").unwrap(), "a-b");
        assert_eq!(normalize(&"x".repeat(32)).unwrap(), "x".repeat(32));
        for bad in [
            "",
            "ab",
            &"x".repeat(33),
            "_abc",
            "-abc",
            "al ice",
            "al.ice",
            "álice",
            "@@abc",
            "a/b",
        ] {
            assert!(
                matches!(normalize(bad), Err(InvalidName(_))),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn a_claim_is_verified_against_the_key_it_names() {
        let ecc = EccSecp256k1::default();
        let record = verified(1, "alice", NOW_MS);
        assert_eq!(record.username, "alice");
        assert_eq!(record.issued_ms, NOW_MS);
        let seckey = ecc.seckey_from_array([1; 32]).unwrap();
        assert_eq!(
            record.subject.as_slice(),
            ecc.derive_pubkey(&seckey).as_slice()
        );

        // Signed by key 2 but naming key 1 as the signer: refused.
        let mut forged =
            cashweb_payload::proto::SignedPayload::decode(claim_for(2, "alice", NOW_MS).as_slice())
                .unwrap();
        forged.pubkey = record.subject.to_vec();
        assert!(matches!(
            verify_claim(&ecc, &forged.encode_to_vec(), NETWORK, NOW_MS),
            Err(InvalidClaim(_))
        ));

        // A signature over other text does not carry over to this claim.
        let mut altered =
            cashweb_payload::proto::SignedPayload::decode(claim_for(1, "alice", NOW_MS).as_slice())
                .unwrap();
        altered.payload = claim_text(NETWORK, "alicf", NOW_MS).into_bytes();
        altered.payload_hash = vec![];
        assert!(matches!(
            verify_claim(&ecc, &altered.encode_to_vec(), NETWORK, NOW_MS),
            Err(InvalidClaim(_))
        ));

        let refused = |bytes: Vec<u8>| {
            assert!(matches!(
                verify_claim(&ecc, &bytes, NETWORK, NOW_MS),
                Err(InvalidClaim(_) | InvalidName(_))
            ))
        };
        // Another network, a non-canonical or invalid name, the future, other text, junk.
        refused(signed_claim(
            [1; 32],
            &claim_text("monad-mainnet", "alice", NOW_MS),
        ));
        refused(claim_for(1, "Alice", NOW_MS));
        refused(claim_for(1, "al", NOW_MS));
        refused(claim_for(1, "alice", NOW_MS + MAX_FUTURE_MS + 1));
        refused(signed_claim([1; 32], "hello"));
        refused(signed_claim(
            [1; 32],
            &format!("{CLAIM_DOMAIN}\n{NETWORK}\nalice\n+5"),
        ));
        refused(signed_claim(
            [1; 32],
            &format!("{CLAIM_DOMAIN}\n{NETWORK}\nalice\n5\nextra"),
        ));
        refused(vec![0xff; 40]);
        refused(vec![0; MAX_CLAIM_BYTES as usize + 1]);
    }

    #[test]
    fn first_claim_wins_and_the_holder_can_repeat_it() -> Result<()> {
        let (_dir, db) = open();
        let names = db.directory_usernames();
        let alice = verified(1, "alice", NOW_MS);
        assert_eq!(
            names.claim(&alice, NOW_MS + 5, false)?,
            Ok(ClaimOutcome::Claimed)
        );

        let stored = names.get("alice")?.unwrap();
        assert_eq!(stored.subject, alice.subject);
        assert_eq!(stored.address, alice.address);
        assert_eq!(stored.accepted_ms, NOW_MS + 5);
        // The stored record is the signed statement itself and verifies on its own.
        assert_eq!(
            verify_claim(&EccSecp256k1::default(), &stored.claim, NETWORK, NOW_MS).unwrap(),
            alice
        );
        assert_eq!(names.of_address(&alice.address)?.unwrap().username, "alice");

        // Another key is refused and changes nothing, however late its claim.
        let mallory = verified(2, "alice", NOW_MS + 60_000);
        assert_eq!(names.claim(&mallory, NOW_MS + 60_000, false)?, Err(Taken));
        assert_eq!(names.get("alice")?.unwrap(), stored);
        assert_eq!(names.of_address(&mallory.address)?, None);

        // The holder claiming again, with the same or a fresh claim, is a no-op.
        assert_eq!(
            names.claim(&alice, NOW_MS + 9, false)?,
            Ok(ClaimOutcome::Unchanged)
        );
        assert_eq!(
            names.claim(&verified(1, "alice", NOW_MS + 1), NOW_MS + 9, false)?,
            Ok(ClaimOutcome::Unchanged)
        );
        assert_eq!(names.get("alice")?.unwrap(), stored);
        Ok(())
    }

    #[test]
    fn changing_name_releases_the_old_one_and_cannot_be_replayed_back() -> Result<()> {
        let (_dir, db) = open();
        let names = db.directory_usernames();
        let first = verified(1, "alice", NOW_MS);
        names.claim(&first, NOW_MS, false)?.unwrap();

        let second = verified(1, "alice2", NOW_MS + 1);
        assert_eq!(
            names.claim(&second, NOW_MS + 1, false)?,
            Ok(ClaimOutcome::Claimed)
        );
        assert_eq!(names.get("alice")?, None);
        assert_eq!(
            names.of_address(&first.address)?.unwrap().username,
            "alice2"
        );

        // Anyone holding the old signed claim cannot move the key back with it.
        assert_eq!(names.claim(&first, NOW_MS + 2, false)?, Err(Stale));
        assert_eq!(
            names.of_address(&first.address)?.unwrap().username,
            "alice2"
        );

        // The released name is free for someone else.
        let bob = verified(2, "alice", NOW_MS + 3);
        assert_eq!(
            names.claim(&bob, NOW_MS + 3, false)?,
            Ok(ClaimOutcome::Claimed)
        );
        assert_eq!(names.get("alice")?.unwrap().subject, bob.subject);
        Ok(())
    }

    #[test]
    fn search_finds_names_by_prefix_in_order() -> Result<()> {
        let (_dir, db) = open();
        let names = db.directory_usernames();
        for (secret, name) in [(1, "alice"), (2, "alicia"), (3, "bob"), (4, "al")] {
            if let Ok(record) = verify_claim(
                &EccSecp256k1::default(),
                &claim_for(secret, name, NOW_MS),
                NETWORK,
                NOW_MS,
            ) {
                names.claim(&record, NOW_MS, false)?.unwrap();
            }
        }
        let found = |prefix: &str, limit: usize| -> Result<Vec<String>> {
            Ok(names
                .search(prefix, limit)?
                .into_iter()
                .map(|record| record.username)
                .collect())
        };
        assert_eq!(found("ali", 10)?, ["alice", "alicia"]);
        assert_eq!(found("ali", 1)?, ["alice"]);
        assert_eq!(found("b", 10)?, ["bob"]);
        assert_eq!(found("", 10)?, ["alice", "alicia", "bob"]);
        assert_eq!(found("zed", 10)?, Vec::<String>::new());
        // The address index shares the column family and never shows up as a name.
        assert_eq!(found("a", 10)?, ["alice", "alicia"]);
        Ok(())
    }

    #[test]
    fn operational_mail_names_are_case_insensitive_and_cannot_be_claimed() -> Result<()> {
        assert!(is_operational_local_part(" PoStMaStEr "));
        assert!(is_operational_local_part("SECURITY"));
        assert!(!is_operational_local_part("alice"));
        let (_dir, db) = open();
        let names = db.directory_usernames();
        let record = verify_claim(
            &EccSecp256k1::default(),
            &claim_for(1, "postmaster", NOW_MS),
            NETWORK,
            NOW_MS,
        )?;
        assert_eq!(names.claim(&record, NOW_MS, false)?, Err(Reserved));
        assert_eq!(names.get("postmaster")?, None);
        Ok(())
    }

    // Independent fixtures pin the durable CF/key allocation and JSON field order.
    fn raw_name(name: &str) -> Vec<u8> {
        let mut key = vec![b'n'];
        key.extend_from_slice(name.as_bytes());
        key
    }

    fn raw_address(address: &[u8; 20]) -> Vec<u8> {
        let mut key = vec![b'a'];
        key.extend_from_slice(address);
        key
    }

    fn frozen_record(record: &UsernameRecord, accepted_ms: u64) -> Vec<u8> {
        format!(
            "{{\"subject\":\"{}\",\"address\":\"{}\",\"issued_ms\":{},\"accepted_ms\":{},\"claim\":\"{}\"}}",
            hex::encode(record.subject), hex::encode(record.address), record.issued_ms,
            accepted_ms, hex::encode(&record.claim),
        ).into_bytes()
    }

    fn raw_rows(db: &Db) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        db.rocksdb()
            .iterator_cf(
                db.rocksdb().cf_handle("directory_usernames").unwrap(),
                IteratorMode::Start,
            )
            .map(|row| Ok(row.map(|(k, v)| (k.to_vec(), v.to_vec()))?))
            .collect()
    }

    fn raw_put(db: &Db, key: Vec<u8>, value: &[u8]) -> Result<()> {
        db.rocksdb().put_cf(
            db.rocksdb().cf_handle("directory_usernames").unwrap(),
            key,
            value,
        )?;
        Ok(())
    }

    fn expected_rows(mut rows: Vec<(Vec<u8>, Vec<u8>)>) -> Vec<(Vec<u8>, Vec<u8>)> {
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows
    }

    #[test]
    fn raw_layout_and_reopen_preserve_complete_reserved_replacement() -> Result<()> {
        let dir = tempdir::TempDir::new("usernames-frozen-layout")?;
        let path = dir.path().join("db.rocksdb");
        let alice = verified(1, "alice", NOW_MS);
        let bob = verified(2, "bobby", NOW_MS + 1);
        assert_eq!(
            claim_text(NETWORK, "alice", NOW_MS),
            format!("frank-username-claim-v1\nmonad-testnet\nalice\n{NOW_MS}")
        );
        let initial = expected_rows(vec![
            (raw_name("alice"), frozen_record(&alice, NOW_MS + 5)),
            (raw_address(&alice.address), b"alice".to_vec()),
            (raw_name("bobby"), frozen_record(&bob, NOW_MS + 6)),
            (raw_address(&bob.address), b"bobby".to_vec()),
        ]);
        {
            let db = Db::open(&path)?;
            let names = db.directory_usernames();
            names.claim(&alice, NOW_MS + 5, false)?.unwrap();
            names.claim(&bob, NOW_MS + 6, false)?.unwrap();
            assert_eq!(raw_rows(&db)?, initial);
        }
        let replacement = verified(2, "alice", NOW_MS + 2);
        let final_rows = expected_rows(vec![
            (raw_name("alice"), frozen_record(&replacement, NOW_MS + 99)),
            (raw_address(&bob.address), b"alice".to_vec()),
        ]);
        {
            let db = Db::open(&path)?;
            assert_eq!(raw_rows(&db)?, initial);
            let names = db.directory_usernames();
            assert_eq!(
                names.claim(&replacement, NOW_MS + 99, true)?,
                Ok(ClaimOutcome::Claimed)
            );
            // Both the displaced holder's reverse row and the claimant's former name disappear.
            assert_eq!(raw_rows(&db)?, final_rows);
        }
        let db = Db::open(&path)?;
        assert_eq!(raw_rows(&db)?, final_rows);
        let names = db.directory_usernames();
        assert_eq!(names.of_address(&alice.address)?, None);
        assert_eq!(names.get("bobby")?, None);
        let stored = names.of_address(&bob.address)?.unwrap();
        assert_eq!(stored.username, "alice");
        assert_eq!(stored.claim, replacement.claim);
        assert_eq!(stored.accepted_ms, NOW_MS + 99);
        Ok(())
    }

    #[test]
    fn refused_or_corrupt_reserved_replacements_never_publish_staged_deletions() -> Result<()> {
        let (_dir, db) = open();
        let names = db.directory_usernames();
        let alice = verified(1, "alice", NOW_MS + 10);
        let bob = verified(2, "bobby", NOW_MS + 20);
        names.claim(&alice, NOW_MS + 30, false)?.unwrap();
        names.claim(&bob, NOW_MS + 31, false)?.unwrap();
        let before = raw_rows(&db)?;
        // A reserved takeover stages the displaced holder's reverse deletion before discovering
        // the claimant's stale prior name. No part of that staged batch may become durable.
        for issued in [NOW_MS + 19, NOW_MS + 20] {
            assert_eq!(
                names.claim(&verified(2, "alice", issued), NOW_MS + 40, true)?,
                Err(Stale)
            );
            assert_eq!(raw_rows(&db)?, before);
        }
        let fresh = verified(2, "alice", NOW_MS + 21);
        raw_put(&db, raw_address(&bob.address), &[0xff])?;
        let corrupt_reverse = raw_rows(&db)?;
        // Taken is decided before the claimant's malformed reverse row is read.
        assert_eq!(names.claim(&fresh, NOW_MS + 41, false)?, Err(Taken));
        assert!(names.claim(&fresh, NOW_MS + 41, true).is_err());
        assert_eq!(raw_rows(&db)?, corrupt_reverse);
        raw_put(&db, raw_address(&bob.address), b"bobby")?;
        raw_put(&db, raw_name("bobby"), b"not JSON")?;
        let corrupt_prior = raw_rows(&db)?;
        assert!(names.claim(&fresh, NOW_MS + 42, true).is_err());
        assert_eq!(raw_rows(&db)?, corrupt_prior);
        // Operational refusal also precedes reading a corrupt record with that reserved name.
        raw_put(&db, raw_name("postmaster"), b"not JSON")?;
        let operational = raw_rows(&db)?;
        assert_eq!(
            names.claim(&verified(3, "postmaster", NOW_MS), NOW_MS, true)?,
            Err(Reserved)
        );
        assert_eq!(raw_rows(&db)?, operational);
        Ok(())
    }

    #[test]
    fn malformed_reverse_rows_keep_existing_error_noop_and_dangling_behavior() -> Result<()> {
        let (dir, db) = open();
        let names = db.directory_usernames();
        let alice = verified(1, "alice", NOW_MS);
        let next = verified(1, "alice2", NOW_MS + 1);
        names.claim(&alice, NOW_MS + 5, false)?.unwrap();
        raw_put(&db, raw_address(&alice.address), &[0xff])?;
        let corrupt = raw_rows(&db)?;
        assert!(names.of_address(&alice.address).is_err());
        // A same-holder no-op does not read, repair or replace the malformed reverse value.
        assert_eq!(
            names.claim(&alice, NOW_MS + 8, false)?,
            Ok(ClaimOutcome::Unchanged)
        );
        assert!(names.claim(&next, NOW_MS + 9, false).is_err());
        assert_eq!(raw_rows(&db)?, corrupt);
        raw_put(&db, raw_address(&alice.address), b"missing")?;
        assert_eq!(names.of_address(&alice.address)?, None);
        names.claim(&next, NOW_MS + 10, false)?.unwrap();
        // Pin the observed dangling-index limitation; this is not authority to repair it here.
        assert_eq!(
            raw_rows(&db)?,
            expected_rows(vec![
                (raw_name("alice"), frozen_record(&alice, NOW_MS + 5)),
                (raw_name("alice2"), frozen_record(&next, NOW_MS + 10)),
                (raw_address(&alice.address), b"alice2".to_vec()),
            ])
        );
        assert_eq!(
            names.of_address(&alice.address)?.unwrap().username,
            "alice2"
        );
        assert_eq!(names.get("alice")?.unwrap().subject, alice.subject);
        let before_reopen = raw_rows(&db)?;
        drop(names);
        drop(db);
        let reopened = Db::open(dir.path().join("db.rocksdb"))?;
        assert_eq!(raw_rows(&reopened)?, before_reopen);
        assert_eq!(
            reopened
                .directory_usernames()
                .get("alice")?
                .unwrap()
                .subject,
            alice.subject
        );
        Ok(())
    }

    #[test]
    fn concurrent_same_account_renames_leave_one_pair_for_the_latest_claim() -> Result<()> {
        let (_dir, db) = open();
        let initial = verified(1, "initial", NOW_MS);
        db.directory_usernames()
            .claim(&initial, NOW_MS, false)?
            .unwrap();
        let claims: Vec<_> = (1..=8)
            .map(|i| verified(1, &format!("rename{i:02}"), NOW_MS + i))
            .collect();
        let barrier = std::sync::Barrier::new(claims.len());
        std::thread::scope(|scope| {
            let attempts: Vec<_> = claims
                .iter()
                .map(|claim| {
                    let db = &db;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        db.directory_usernames()
                            .claim(claim, claim.issued_ms + 100, false)
                            .unwrap()
                    })
                })
                .collect();
            let outcomes: Vec<_> = attempts
                .into_iter()
                .map(|attempt| attempt.join().unwrap())
                .collect();
            assert_eq!(outcomes.last(), Some(&Ok(ClaimOutcome::Claimed)));
            assert!(outcomes
                .iter()
                .all(|outcome| matches!(outcome, Ok(ClaimOutcome::Claimed) | Err(Stale))));
        });
        let latest = claims.last().unwrap();
        assert_eq!(
            raw_rows(&db)?,
            expected_rows(vec![
                (
                    raw_name(&latest.username),
                    frozen_record(latest, latest.issued_ms + 100)
                ),
                (
                    raw_address(&latest.address),
                    latest.username.as_bytes().to_vec()
                ),
            ])
        );
        assert_eq!(
            db.directory_usernames()
                .of_address(&latest.address)?
                .unwrap()
                .username,
            latest.username
        );
        Ok(())
    }

    #[test]
    fn search_limits_and_prefix_stop_before_decoding_following_corruption() -> Result<()> {
        let (dir, db) = open();
        let names = db.directory_usernames();
        for i in 0..100 {
            names
                .claim(
                    &verified(i + 1, &format!("user{i:03}"), NOW_MS),
                    NOW_MS + 1,
                    false,
                )?
                .unwrap();
        }
        raw_put(&db, raw_name("user100"), b"not JSON")?;
        assert_eq!(names.search("user", usize::MAX)?.len(), 100);
        assert_eq!(names.search("user099", 10)?.len(), 1);
        assert!(names.search("user100", 0)?.is_empty());
        assert!(names.search("user100", 1).is_err());
        assert!(names.get("user100").is_err());
        // At limit zero neither JSON nor UTF-8 is decoded, although the iterator is opened.
        raw_put(&db, b"ninvalid\xff".to_vec(), b"not JSON")?;
        assert!(names.search("invalid", 0)?.is_empty());
        assert!(names.search("invalid", 1).is_err());
        let malformed =
            br#"{"subject":"zz","address":"00","issued_ms":1,"accepted_ms":2,"claim":"00"}"#;
        raw_put(&db, raw_name("malformed"), malformed)?;
        assert!(names.get("malformed").is_err());
        let before_reopen = raw_rows(&db)?;
        drop(names);
        drop(db);
        let reopened = Db::open(dir.path().join("db.rocksdb"))?;
        assert_eq!(raw_rows(&reopened)?, before_reopen);
        assert!(reopened.directory_usernames().get("malformed").is_err());
        Ok(())
    }
}
