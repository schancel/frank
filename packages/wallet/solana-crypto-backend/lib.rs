//! Experimental custody-internal implementation of the UNALLOCATED review proposal.
//! No JS/FFI exports, application integration, capability enablement or recovery claims.
#![allow(dead_code)] // Isolated predecessor: production composition intentionally absent.

use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    edwards::{CompressedEdwardsY, EdwardsPoint},
    scalar::Scalar,
    traits::IsIdentity,
};
use ed25519_dalek::{
    hazmat::{raw_sign, ExpandedSecretKey},
    VerifyingKey,
};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha512};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use zeroize::{Zeroize, Zeroizing};

const REGISTRY: &str = include_str!("../../../docs/protocol/chains/v1.json");
const SCHEME: &str = "frank:solana-stealth:edwards-add:v1";

#[derive(Debug, PartialEq, Eq)]
enum Error {
    Revoked,
    InvalidChain,
    InvalidPoint,
    WrongRecipient,
    InvalidAmount,
    InvalidMessage,
    InvalidDestination,
    SignatureFailure,
}

// Public data only. They are not deserialized from untrusted JSON by this backend.
enum Asset {
    Native,
    Spl {
        mint: [u8; 32],
        token_program: [u8; 32],
    },
}
struct Descriptor {
    chain_identifier: String,
    asset: Asset,
    recipient: [u8; 32],
    ephemeral: [u8; 32],
    operation_id: [u8; 32],
    member_index: u32,
    message_context: [u8; 32],
    recipient_amount: u64,
}

// No Debug, Clone, scalar getter or seed getter. Dropping/revoking scope invalidates children.
struct CustodyScope {
    account_id: [u8; 32],
    chain_identifier: String,
    seed: Zeroizing<[u8; 32]>,
    active: Arc<AtomicBool>,
}

struct BoundSigner {
    account_id: [u8; 32],
    public_key: [u8; 32],
    secret: ExpandedSecretKey,
    message: Vec<u8>,
    active: Arc<AtomicBool>,
}

struct SignedMessage {
    account_id: [u8; 32],
    public_key: [u8; 32],
    signature: [u8; 64],
}

fn valid_chain(id: &str) -> bool {
    // Shared facts remain in the authoritative registry, not a second local network table.
    serde_json::from_str::<serde_json::Value>(REGISTRY)
        .ok()
        .and_then(|v| {
            v["chains"]
                .as_array()
                .map(|a| a.iter().any(|c| c["id"] == id && c["family"] == "solana"))
        })
        .unwrap_or(false)
}

fn point(bytes: &[u8; 32]) -> Result<EdwardsPoint, Error> {
    let p = CompressedEdwardsY(*bytes)
        .decompress()
        .ok_or(Error::InvalidPoint)?;
    if p.compress().to_bytes() != *bytes || p.is_identity() || !p.is_torsion_free() {
        return Err(Error::InvalidPoint);
    }
    Ok(p)
}

// Closed transcript writer only: not a new general CBOR implementation or wire codec.
fn head(out: &mut Vec<u8>, major: u8, n: u64) {
    if n < 24 {
        out.push(major * 32 + n as u8);
        return;
    }
    for (size, marker) in [(1, 24), (2, 25), (4, 26), (8, 27)] {
        if size == 8 || n < (1u64 << (size * 8)) {
            out.push(major * 32 + marker);
            out.extend_from_slice(&n.to_be_bytes()[8 - size..]);
            return;
        }
    }
}
fn bytes(out: &mut Vec<u8>, data: &[u8]) {
    head(out, 2, data.len() as u64);
    out.extend_from_slice(data);
}
fn text(out: &mut Vec<u8>, data: &str) {
    head(out, 3, data.len() as u64);
    out.extend_from_slice(data.as_bytes());
}

fn transcript(d: &Descriptor) -> Vec<u8> {
    let mut out = vec![0x89];
    text(&mut out, SCHEME);
    text(&mut out, &d.chain_identifier);
    match &d.asset {
        Asset::Native => out.extend_from_slice(&[0x81, 0]),
        Asset::Spl {
            mint,
            token_program,
        } => {
            out.extend_from_slice(&[0x83, 1]);
            bytes(&mut out, mint);
            bytes(&mut out, token_program);
        }
    }
    bytes(&mut out, &d.recipient);
    bytes(&mut out, &d.ephemeral);
    bytes(&mut out, &d.operation_id);
    head(&mut out, 0, d.member_index as u64);
    bytes(&mut out, &d.message_context);
    head(&mut out, 0, d.recipient_amount);
    out
}

impl CustodyScope {
    fn new(
        account_id: [u8; 32],
        chain_identifier: String,
        seed: Zeroizing<[u8; 32]>,
    ) -> Result<Self, Error> {
        if !valid_chain(&chain_identifier) {
            return Err(Error::InvalidChain);
        }
        Ok(Self {
            account_id,
            chain_identifier,
            seed,
            active: Arc::new(AtomicBool::new(true)),
        })
    }

    fn revoke(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        self.seed.zeroize();
    }

    // Caller must already authenticate descriptor and review the EXACT wallet-policy message.
    // BoundSigner has no sign(message) API: the selected message cannot change after preparation.
    fn prepare(
        &self,
        d: &Descriptor,
        expected_destination: [u8; 32],
        reviewed_message: &[u8],
    ) -> Result<BoundSigner, Error> {
        if !self.active.load(Ordering::SeqCst) {
            return Err(Error::Revoked);
        }
        if d.chain_identifier != self.chain_identifier {
            return Err(Error::InvalidChain);
        }
        if d.recipient_amount == 0 {
            return Err(Error::InvalidAmount);
        }
        if reviewed_message.len() > 1232 {
            return Err(Error::InvalidMessage);
        }
        let recipient = point(&d.recipient)?;
        let ephemeral = point(&d.ephemeral)?;
        let expanded = Zeroizing::new(<[u8; 64]>::from(Sha512::digest(&self.seed[..])));
        let mut pruned = Zeroizing::new([0u8; 32]);
        pruned.copy_from_slice(&expanded[..32]);
        pruned[0] &= 248;
        pruned[31] &= 63;
        pruned[31] |= 64;
        let b = Zeroizing::new(Scalar::from_bytes_mod_order(*pruned));
        if *b == Scalar::ZERO || ED25519_BASEPOINT_POINT * *b != recipient {
            return Err(Error::WrongRecipient);
        }
        let shared = Zeroizing::new(ephemeral * *b);
        if shared.is_identity() {
            return Err(Error::InvalidPoint);
        }
        let q = transcript(d);
        let mut tweak_input = vec![0x83];
        text(&mut tweak_input, "frank:solana-stealth:tweak:v1");
        bytes(&mut tweak_input, &q);
        bytes(&mut tweak_input, shared.compress().as_bytes());
        let mut tweak_hash = <[u8; 64]>::from(Sha512::digest(&tweak_input));
        let t = Zeroizing::new(Scalar::from_bytes_mod_order_wide(&tweak_hash));
        tweak_hash.zeroize();
        tweak_input.zeroize();
        let destination = recipient + ED25519_BASEPOINT_POINT * *t;
        let p = Zeroizing::new(*b + *t);
        if *t == Scalar::ZERO
            || *p == Scalar::ZERO
            || destination.is_identity()
            || destination.compress().to_bytes() != expected_destination
        {
            return Err(Error::InvalidDestination);
        }
        point(&expected_destination)?;
        let mut nonce_input = vec![0x83];
        text(&mut nonce_input, "frank:solana-stealth:nonce-prefix:v1");
        bytes(&mut nonce_input, &q);
        bytes(&mut nonce_input, &expected_destination);
        let mut mac =
            Hmac::<Sha512>::new_from_slice(&expanded[32..]).map_err(|_| Error::SignatureFailure)?;
        mac.update(&nonce_input);
        let mut digest = mac.finalize().into_bytes();
        let mut prefix = Zeroizing::new([0u8; 32]);
        prefix.copy_from_slice(&digest[..32]);
        digest.zeroize();
        if !self.active.load(Ordering::SeqCst) {
            return Err(Error::Revoked);
        }
        Ok(BoundSigner {
            account_id: self.account_id,
            public_key: expected_destination,
            secret: ExpandedSecretKey {
                scalar: *p,
                hash_prefix: *prefix,
            },
            message: reviewed_message.to_vec(),
            active: self.active.clone(),
        })
    }
}

impl Drop for CustodyScope {
    fn drop(&mut self) {
        self.revoke();
    }
}

impl BoundSigner {
    fn sign(self) -> Result<SignedMessage, Error> {
        if !self.active.load(Ordering::SeqCst) {
            return Err(Error::Revoked);
        }
        let key =
            VerifyingKey::from_bytes(&self.public_key).map_err(|_| Error::InvalidDestination)?;
        let signature = raw_sign::<Sha512>(&self.secret, &self.message, &key);
        key.verify_strict(&self.message, &signature)
            .map_err(|_| Error::SignatureFailure)?;
        if !self.active.load(Ordering::SeqCst) {
            return Err(Error::Revoked);
        }
        Ok(SignedMessage {
            account_id: self.account_id,
            public_key: self.public_key,
            signature: signature.to_bytes(),
        })
    }
}

#[cfg(test)]
mod tests;

#[cfg(target_arch = "wasm32")]
mod bindings;
mod sender;
mod transfer;
