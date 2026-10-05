// This file is NOT part of the Silence Laboratories library as published.
// It was added on 2026-10-04 by the Frank project, independently and without
// any involvement from Silence Laboratories. See ../CHANGES.
//
// It is a modification of the Library and is therefore covered by the
// Silence Laboratories License Agreement in ../LICENSE.md, like the rest of
// this directory.

//! Two-party adaptor pre-signing on top of the DKLs23 signing protocol.
//!
//! NOT REVIEWED. This is new cryptography built around an existing protocol.
//!
//! # What it produces
//!
//! An ECDSA adaptor ("encrypted") signature in the encoding of the DLC
//! specification (`ECDSA-adaptor.md`), 162 bytes:
//!
//! ```text
//! R (33) || R_a (33) || s_a (32) || b (32) || c (32)
//! R_a = k*G,  R = k*T,  r = x(R) mod n,  s_a = (m + r*x) / k
//! (b, c): proof that log_G(R_a) = log_T(R)
//! ```
//!
//! `T` is the lock point, `x` the joint key, `k = r_0 + r_1` the joint nonce.
//! Whoever knows `t` with `T = t*G` turns it into the ordinary signature
//! `(r, s_a / t)`, and that signature reveals `t`.
//!
//! # How it differs from plain DKLs23 signing
//!
//! Rounds 1 and 2 (commitments, the two multiplications) are the library's,
//! unchanged, except that the session is bound to the lock and the digest
//! (below). The differences:
//!
//! 1. In round 1 each party also commits to `Z_i = r_i*T` and to the
//!    announcement `(A_i, B_i) = (a_i*G, a_i*T)` of the joint equality proof.
//! 2. In round 3 each party opens that commitment and adds a Chaum-Pedersen
//!    proof that `Z_i` has the same discrete log to base `T` as its nonce
//!    share `R_i` has to base `G`. `R_i` itself is checked against its
//!    round-1 commitment by the library, as before.
//! 3. The signature's `r` is taken from `R = Z_0 + Z_1` instead of from
//!    `R_a = R_0 + R_1`. In the library `r` only ever multiplies a party's
//!    additive share (`s_0 = r * (sk_i * phi + v)`), so this is a change of
//!    one public scalar.
//! 4. The last message carries, besides the partial signature, the party's
//!    response `c_i = a_i + b*r_i` to the joint challenge `b`. Each response
//!    is checked on its own, then `c = c_0 + c_1`.
//! 5. The final check verifies the whole 162-byte encrypted signature the way
//!    a third party would, instead of an ordinary signature.
//!
//! # What a lock is
//!
//! The lock point is never chosen freely. It comes from a lock in the format
//! of Frank's `@frank/threshold-ecdsa` (`src/lock.ts`), whose proofs are
//! verified here before a session exists:
//!
//! * point lock: `T = t*G` with two Schnorr proofs of knowledge of `t`;
//! * commitment lock: a Pedersen commitment `C = s*G + v*H` with an Okamoto
//!   proof of knowledge of an opening, and an index `i`; `T = C - i*H`.
//!
//! # Who may pre-sign under a lock
//!
//! The lock's proofs only show that *someone* knows its secret and wrote the
//! holder's name into the proof. That is not enough for the holder: the
//! other party could make a lock from a secret of its own, name the holder
//! in it, and later complete the pre-signature alone. So the party that
//! holds the lock (the "prover") must hand its own opening of the lock to
//! [`AdaptorState::new`], which checks it against the lock before anything
//! else happens. The other party (the "verifier", who will extract the
//! secret later) starts with the public lock only.
//!
//! # Binding
//!
//! The lock (all of its bytes), the lock point, the caller's key id, both
//! identities, the digest and the public key are hashed into one value that
//! is mixed into the session's `final_session_id` in round 1, before either
//! party reveals anything that depends on its nonce. Parties that disagree on
//! any of them fail the library's session-id check in round 2.
//!
//! # One pre-signature, one digest, one lock
//!
//! The digest and the lock are fixed when the session is created. Round 3
//! goes straight from the incoming messages to the partial signature; no
//! message-independent pre-signature is ever returned or stored, and the
//! nonce share and the other one-time secrets are wiped in the same call.

use derivation_path::DerivationPath;
use k256::{
    elliptic_curve::{
        group::{prime::PrimeCurveAffine, GroupEncoding},
        ops::Reduce,
        point::AffineCoordinates,
        subtle::ConstantTimeEq,
        PrimeField,
    },
    AffinePoint, FieldBytes, NonZeroScalar, ProjectivePoint, Scalar, U256,
};
use rand::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

use sl_mpc_mate::bip32::BIP32Error;

use crate::{
    dkg::Keyshare,
    dsg::{SignError, SignMsg1, SignMsg2, SignMsg3, State},
    pairs::Pairs,
};

/// Length of the encrypted signature.
pub const ADAPTOR_SIGNATURE_BYTES: usize = 162;

/// Domain prefix of `@frank/threshold-ecdsa`; lock proofs use it.
const FRANK_TAG_PREFIX: &str = "FRANK-TECDSA-V1/";
/// Domain prefix of everything that exists only in this fork.
const FORK_TAG_PREFIX: &str = "FRANK-DKLS23-FORK-V1/";

const KIND_POINT: u8 = 1;
const KIND_COMMITMENT: u8 = 2;
const POINT_BYTES: usize = 33;
const SCALAR_BYTES: usize = 32;
const POINT_LOCK_BYTES: usize = 1 + 33 + 65 + 65;
const COMMITMENT_LOCK_BYTES: usize = 1 + 33 + 33 + 97 + 4;
const MAX_ID_BYTES: usize = 64;

// --- hashing, exactly as the TypeScript packages do it ----------------------

/// `SHA256(SHA256(tag) || SHA256(tag) || parts...)`.
fn tagged_hash(tag: &str, parts: &[&[u8]]) -> [u8; 32] {
    let tag_hash = Sha256::digest(tag.as_bytes());
    let mut hasher = Sha256::new();
    hasher.update(tag_hash);
    hasher.update(tag_hash);
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Tagged hash in which every part is prefixed with its 4-byte length.
fn transcript(prefix: &str, label: &str, parts: &[&[u8]]) -> [u8; 32] {
    let tag_hash = Sha256::digest([prefix, label].concat().as_bytes());
    let mut hasher = Sha256::new();
    hasher.update(tag_hash);
    hasher.update(tag_hash);
    for part in parts {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn hash_to_scalar(hash: &[u8; 32]) -> Scalar {
    Scalar::reduce(U256::from_be_slice(hash))
}

fn point_bytes(point: &ProjectivePoint) -> [u8; POINT_BYTES] {
    let mut out = [0u8; POINT_BYTES];
    out.copy_from_slice(&point.to_affine().to_bytes());
    out
}

fn scalar_bytes(scalar: &Scalar) -> [u8; SCALAR_BYTES] {
    scalar.to_bytes().into()
}

/// A compressed point: 33 bytes, prefix 02 or 03, on the curve.
fn parse_point(bytes: &[u8]) -> Result<ProjectivePoint, SignError> {
    if bytes.len() != POINT_BYTES || (bytes[0] != 0x02 && bytes[0] != 0x03) {
        return Err(SignError::InvalidLock("point encoding"));
    }
    let mut array = [0u8; POINT_BYTES];
    array.copy_from_slice(bytes);
    let point: Option<AffinePoint> =
        AffinePoint::from_bytes(&array.into()).into();
    match point {
        Some(point) if !bool::from(point.is_identity()) => {
            Ok(point.to_curve())
        }
        _ => Err(SignError::InvalidLock("point not on curve")),
    }
}

/// A canonical 32-byte scalar below the group order.
fn parse_scalar(bytes: &[u8], allow_zero: bool) -> Result<Scalar, SignError> {
    if bytes.len() != SCALAR_BYTES {
        return Err(SignError::InvalidLock("scalar encoding"));
    }
    let scalar: Option<Scalar> =
        Scalar::from_repr(*FieldBytes::from_slice(bytes)).into();
    match scalar {
        Some(scalar) if allow_zero || !bool::from(scalar.is_zero()) => {
            Ok(scalar)
        }
        _ => Err(SignError::InvalidLock("scalar out of range")),
    }
}

fn x_scalar(point: &ProjectivePoint) -> Scalar {
    Reduce::<U256>::reduce_bytes(&point.to_affine().x())
}

fn is_identity(point: &ProjectivePoint) -> bool {
    point.to_affine().is_identity().into()
}

/// The second Pedersen generator of `@frank/threshold-ecdsa`: the first valid
/// point with even y whose x is `SHA256("FRANK-TECDSA-V1/pedersen-H" ||
/// counter)`, counter a 4-byte big-endian integer from 0.
pub fn pedersen_h() -> ProjectivePoint {
    let tag = [FRANK_TAG_PREFIX, "pedersen-H"].concat();
    for counter in 0u32..1000 {
        let x = Sha256::new()
            .chain_update(tag.as_bytes())
            .chain_update(counter.to_be_bytes())
            .finalize();
        let mut encoded = [0u8; POINT_BYTES];
        encoded[0] = 0x02;
        encoded[1..].copy_from_slice(&x);
        if let Ok(point) = parse_point(&encoded) {
            return point;
        }
    }
    unreachable!("no curve point among 1000 candidates")
}

// --- locks ------------------------------------------------------------------

/// A lock whose proofs have been verified. The only way to obtain one is
/// [`VerifiedLock::verify`], so a session can never be locked to a point
/// nobody is known to hold the secret of.
#[derive(Clone, Serialize, Deserialize)]
pub struct VerifiedLock {
    point: AffinePoint,
    encoded: Vec<u8>,
}

impl VerifiedLock {
    /// Parses and verifies a lock in the canonical encoding of
    /// `@frank/threshold-ecdsa`:
    ///
    /// ```text
    /// point lock:      01 || T (33) || proof R||z (65) || owner proof A||z (65)
    /// commitment lock: 02 || C (33) || H (33) || proof A||z1||z2 (97) || index (4, BE)
    /// ```
    ///
    /// `key_id` and `prover_id` are the context the lock's proofs were made
    /// for: the caller's identifier of the joint key and the identity of the
    /// party that created the lock.
    pub fn verify(
        encoded: &[u8],
        key_id: &[u8],
        prover_id: &[u8],
    ) -> Result<Self, SignError> {
        if prover_id.is_empty() || prover_id.len() > MAX_ID_BYTES {
            return Err(SignError::InvalidLock("prover id"));
        }
        let context =
            transcript(FRANK_TAG_PREFIX, "lock/context", &[key_id, prover_id]);
        let point = match encoded.first() {
            Some(&KIND_POINT) if encoded.len() == POINT_LOCK_BYTES => {
                Self::verify_point_lock(&encoded[1..], &context, prover_id)?
            }
            Some(&KIND_COMMITMENT)
                if encoded.len() == COMMITMENT_LOCK_BYTES =>
            {
                Self::verify_commitment_lock(
                    &encoded[1..],
                    &context,
                    prover_id,
                )?
            }
            _ => return Err(SignError::InvalidLock("encoding")),
        };
        Ok(Self {
            point: point.to_affine(),
            encoded: encoded.to_vec(),
        })
    }

    /// The lock point `T`, compressed.
    pub fn point_bytes(&self) -> [u8; POINT_BYTES] {
        point_bytes(&self.point.to_curve())
    }

    /// True if `opening` is the secret material of this very lock:
    /// `t*G == T` for a point lock, `s*G + v*H == C` for a commitment lock.
    fn opened_by(&self, opening: &LockOpening) -> bool {
        match (self.encoded.first(), opening) {
            (Some(&KIND_POINT), LockOpening::Point { secret }) => {
                !bool::from(secret.is_zero())
                    && ProjectivePoint::GENERATOR * secret
                        == self.point.to_curve()
            }
            (
                Some(&KIND_COMMITMENT),
                LockOpening::Commitment { secret, value },
            ) => {
                let Ok(commitment) = parse_point(&self.encoded[1..34]) else {
                    return false;
                };
                !bool::from(secret.is_zero())
                    && ProjectivePoint::GENERATOR * secret
                        + pedersen_h() * Scalar::from(*value)
                        == commitment
            }
            _ => false,
        }
    }

    fn verify_point_lock(
        body: &[u8],
        context: &[u8; 32],
        prover_id: &[u8],
    ) -> Result<ProjectivePoint, SignError> {
        let point_raw = &body[..33];
        let lock_point = parse_point(point_raw)?;

        // Proof of knowledge of `@frank/adaptor-signatures`:
        // e = H_tag("ADAPTOR-TWEAK-POK", T, R),  z*G = R + e*T.
        let pok_r_raw = &body[33..66];
        let pok_r = parse_point(pok_r_raw)?;
        let pok_z = parse_scalar(&body[66..98], false)?;
        let e = hash_to_scalar(&tagged_hash(
            "ADAPTOR-TWEAK-POK",
            &[point_raw, pok_r_raw],
        ));
        if ProjectivePoint::GENERATOR * pok_z != pok_r + lock_point * e {
            return Err(SignError::InvalidLock("proof of knowledge"));
        }

        // Owner proof, bound to the key and the lock's creator:
        // e = H("proof/dlog", context, prover, T, A),  z*G = A + e*T.
        let owner_a_raw = &body[98..131];
        let owner_a = parse_point(owner_a_raw)?;
        let owner_z = parse_scalar(&body[131..163], false)?;
        let e = hash_to_scalar(&transcript(
            FRANK_TAG_PREFIX,
            "proof/dlog",
            &[context, prover_id, point_raw, owner_a_raw],
        ));
        if bool::from(e.is_zero())
            || ProjectivePoint::GENERATOR * owner_z != owner_a + lock_point * e
        {
            return Err(SignError::InvalidLock("owner proof"));
        }
        Ok(lock_point)
    }

    fn verify_commitment_lock(
        body: &[u8],
        context: &[u8; 32],
        prover_id: &[u8],
    ) -> Result<ProjectivePoint, SignError> {
        let commitment_raw = &body[..33];
        let commitment = parse_point(commitment_raw)?;
        let h = pedersen_h();
        let h_raw = point_bytes(&h);
        if body[33..66] != h_raw {
            return Err(SignError::InvalidLock("second generator"));
        }

        // Okamoto proof of knowledge of (s, v) with C = s*G + v*H:
        // e = H("proof/opening", context, prover, C, H, A),
        // z1*G + z2*H = A + e*C.
        let announcement_raw = &body[66..99];
        let announcement = parse_point(announcement_raw)?;
        let z1 = parse_scalar(&body[99..131], true)?;
        let z2 = parse_scalar(&body[131..163], true)?;
        let e = hash_to_scalar(&transcript(
            FRANK_TAG_PREFIX,
            "proof/opening",
            &[context, prover_id, commitment_raw, &h_raw, announcement_raw],
        ));
        let left = ProjectivePoint::GENERATOR * z1 + h * z2;
        if bool::from(e.is_zero())
            || is_identity(&left)
            || left != announcement + commitment * e
        {
            return Err(SignError::InvalidLock("opening proof"));
        }

        let mut index_raw = [0u8; 4];
        index_raw.copy_from_slice(&body[163..167]);
        let index = u32::from_be_bytes(index_raw);
        let lock_point = commitment - h * Scalar::from(index);
        if is_identity(&lock_point) {
            return Err(SignError::InvalidLock("lock point is the identity"));
        }
        Ok(lock_point)
    }
}

/// The secret material of a lock, held by the party that created it.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub enum LockOpening {
    /// `t` with `T = t*G`.
    Point { secret: Scalar },
    /// `(s, v)` with `C = s*G + v*H`.
    Commitment { secret: Scalar, value: u32 },
}

impl LockOpening {
    /// Parses `t (32)` or `s (32) || v (4, big-endian)`.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, SignError> {
        match bytes.len() {
            32 => Ok(Self::Point {
                secret: parse_scalar(bytes, false)?,
            }),
            36 => {
                let mut value = [0u8; 4];
                value.copy_from_slice(&bytes[32..]);
                Ok(Self::Commitment {
                    secret: parse_scalar(&bytes[..32], false)?,
                    value: u32::from_be_bytes(value),
                })
            }
            _ => Err(SignError::InvalidLock("opening encoding")),
        }
    }
}

// --- messages ---------------------------------------------------------------

/// Round 1: the library's message plus a commitment to `Z_i`, `A_i`, `B_i`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdaptorSignMsg1 {
    pub inner: SignMsg1,
    pub adaptor_commitment: [u8; 32],
}

/// Round 3: the library's message plus the opening of that commitment and
/// the proof that `Z_i` and `R_i` share one discrete log.
#[derive(Clone, Serialize, Deserialize)]
pub struct AdaptorSignMsg3 {
    pub inner: SignMsg3,
    /// `Z_i = r_i * T`.
    pub big_z_i: AffinePoint,
    /// `A_i = a_i * G`.
    pub big_a_i: AffinePoint,
    /// `B_i = a_i * T`.
    pub big_b_i: AffinePoint,
    pub adaptor_blind: [u8; 32],
    /// Chaum-Pedersen proof for `(G, R_i, T, Z_i)`: challenge and response.
    pub share_proof_e: Scalar,
    pub share_proof_z: Scalar,
}

/// Round 4: the partial signature and the response to the joint challenge.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct AdaptorSignMsg4 {
    pub from_id: u8,
    pub session_id: [u8; 32],
    pub s_0: Scalar,
    pub s_1: Scalar,
    /// `c_i = a_i + b * r_i`.
    pub c_i: Scalar,
}

/// What a peer opened in round 3, kept to check its round-4 response.
#[derive(Clone, Serialize, Deserialize)]
struct PeerShare {
    big_r: AffinePoint,
    big_z: AffinePoint,
    big_a: AffinePoint,
    big_b: AffinePoint,
}

/// A party's state between sending round 4 and receiving the peer's.
/// It is bound to one digest and one lock and cannot produce anything else.
#[derive(Serialize, Deserialize)]
pub struct AdaptorPartial {
    party_id: u8,
    final_session_id: [u8; 32],
    public_key: AffinePoint,
    message_hash: [u8; 32],
    lock_point: AffinePoint,
    /// `R_a = k*G`.
    big_r_a: AffinePoint,
    /// `R = k*T`.
    big_r_t: AffinePoint,
    /// The joint challenge `b`.
    challenge: Scalar,
    s_0: Scalar,
    s_1: Scalar,
    c_i: Scalar,
    peers: Pairs<PeerShare>,
}

/// One party's adaptor pre-signing session.
#[derive(Serialize, Deserialize)]
pub struct AdaptorState {
    inner: State,
    lock: VerifiedLock,
    binding: [u8; 32],
    message_hash: [u8; 32],
    /// `Z_i = r_i * T`.
    big_z_i: AffinePoint,
    /// Nonce of the joint equality proof. Wiped in round 3.
    a_i: Scalar,
    big_a_i: AffinePoint,
    big_b_i: AffinePoint,
    adaptor_blind: [u8; 32],
    adaptor_commitments: Pairs<[u8; 32]>,
}

fn adaptor_commitment(
    binding: &[u8; 32],
    party_id: u8,
    session_id: &[u8; 32],
    big_z: &ProjectivePoint,
    big_a: &ProjectivePoint,
    big_b: &ProjectivePoint,
    blind: &[u8; 32],
) -> [u8; 32] {
    transcript(
        FORK_TAG_PREFIX,
        "adaptor/commitment",
        &[
            binding,
            &[party_id],
            session_id,
            &point_bytes(big_z),
            &point_bytes(big_a),
            &point_bytes(big_b),
            blind,
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn share_proof_challenge(
    final_session_id: &[u8; 32],
    binding: &[u8; 32],
    party_id: u8,
    lock_point: &ProjectivePoint,
    big_r: &ProjectivePoint,
    big_z: &ProjectivePoint,
    w_g: &ProjectivePoint,
    w_t: &ProjectivePoint,
) -> Scalar {
    hash_to_scalar(&transcript(
        FORK_TAG_PREFIX,
        "adaptor/share-proof",
        &[
            final_session_id,
            binding,
            &[party_id],
            &point_bytes(lock_point),
            &point_bytes(big_r),
            &point_bytes(big_z),
            &point_bytes(w_g),
            &point_bytes(w_t),
        ],
    ))
}

/// The challenge of the DLC specification's equality proof:
/// `H_tag("DLEQ", X, Y, Z, A_G, A_Y)` with `X = R_a`, `Y = T`, `Z = R`.
fn joint_challenge(
    big_r_a: &ProjectivePoint,
    lock_point: &ProjectivePoint,
    big_r_t: &ProjectivePoint,
    a_g: &ProjectivePoint,
    a_y: &ProjectivePoint,
) -> Scalar {
    hash_to_scalar(&tagged_hash(
        "DLEQ",
        &[
            &point_bytes(big_r_a),
            &point_bytes(lock_point),
            &point_bytes(big_r_t),
            &point_bytes(a_g),
            &point_bytes(a_y),
        ],
    ))
}

impl AdaptorState {
    /// Starts a session for one digest and one verified lock.
    ///
    /// `key_id`, `prover_id` (the lock's holder) and `verifier_id` (the
    /// other party) must be the same byte strings on both sides; they are
    /// bound into the session. `key_id` and `prover_id` must be the ones the
    /// lock was verified with.
    ///
    /// `local_id` says which of the two this party is. The holder
    /// (`local_id == prover_id`) must pass its own `opening` of the lock and
    /// is refused without one that fits; the other party must pass `None`.
    #[allow(clippy::too_many_arguments)]
    pub fn new<R: RngCore + CryptoRng>(
        rng: &mut R,
        keyshare: Keyshare,
        chain_path: &DerivationPath,
        message_hash: [u8; 32],
        lock: VerifiedLock,
        key_id: &[u8],
        prover_id: &[u8],
        verifier_id: &[u8],
        local_id: &[u8],
        opening: Option<&LockOpening>,
    ) -> Result<Self, AdaptorInitError> {
        if verifier_id.is_empty()
            || verifier_id.len() > MAX_ID_BYTES
            || verifier_id == prover_id
        {
            return Err(AdaptorInitError::Lock(SignError::InvalidLock(
                "verifier id",
            )));
        }
        let holds_lock = local_id == prover_id;
        if !holds_lock && local_id != verifier_id {
            return Err(AdaptorInitError::Lock(SignError::InvalidLock(
                "local id",
            )));
        }
        match (holds_lock, opening) {
            (true, Some(opening)) if lock.opened_by(opening) => {}
            (false, None) => {}
            (true, _) => {
                return Err(AdaptorInitError::Lock(SignError::InvalidLock(
                    "the holder cannot open this lock",
                )))
            }
            (false, Some(_)) => {
                return Err(AdaptorInitError::Lock(SignError::InvalidLock(
                    "only the holder passes an opening",
                )))
            }
        }
        // Re-verify: the lock must belong to exactly this key and prover.
        let lock = VerifiedLock::verify(&lock.encoded, key_id, prover_id)
            .map_err(AdaptorInitError::Lock)?;
        let lock_point = lock.point.to_curve();

        let (_, derived_public_key) = crate::dsg::derive_with_offset(
            &keyshare.public_key.to_curve(),
            &keyshare.root_chain_code,
            chain_path,
        )
        .map_err(AdaptorInitError::Path)?;

        let binding = transcript(
            FORK_TAG_PREFIX,
            "adaptor/binding",
            &[
                key_id,
                prover_id,
                verifier_id,
                &lock.encoded,
                &point_bytes(&lock_point),
                &message_hash,
                &point_bytes(&derived_public_key),
            ],
        );

        let inner =
            State::new_bound(rng, keyshare, chain_path, message_hash, binding)
                .map_err(AdaptorInitError::Path)?;

        let a_i = *NonZeroScalar::random(&mut *rng);
        let adaptor_blind: [u8; 32] = rng.gen();
        let big_z_i = lock_point * inner.r_i;
        let big_a_i = ProjectivePoint::GENERATOR * a_i;
        let big_b_i = lock_point * a_i;

        let party_id = inner.keyshare.party_id;
        let commitment = adaptor_commitment(
            &binding,
            party_id,
            inner.sid_list.find_pair(party_id),
            &big_z_i,
            &big_a_i,
            &big_b_i,
            &adaptor_blind,
        );

        Ok(Self {
            inner,
            lock,
            binding,
            message_hash,
            big_z_i: big_z_i.to_affine(),
            a_i,
            big_a_i: big_a_i.to_affine(),
            big_b_i: big_b_i.to_affine(),
            adaptor_blind,
            adaptor_commitments: Pairs::new_with_item(party_id, commitment),
        })
    }

    /// The lock point `T`, compressed.
    pub fn lock_point_bytes(&self) -> [u8; POINT_BYTES] {
        self.lock.point_bytes()
    }

    /// Round 1.
    pub fn generate_msg1(&mut self) -> AdaptorSignMsg1 {
        let party_id = self.inner.keyshare.party_id;
        AdaptorSignMsg1 {
            inner: self.inner.generate_msg1(),
            adaptor_commitment: *self.adaptor_commitments.find_pair(party_id),
        }
    }

    /// Round 1: stores every peer's commitments.
    pub fn handle_msg1<R: RngCore + CryptoRng>(
        &mut self,
        rng: &mut R,
        msgs: Vec<AdaptorSignMsg1>,
    ) -> Result<Vec<SignMsg2>, SignError> {
        let mut inner = Vec::with_capacity(msgs.len());
        for msg in msgs {
            let from = msg.inner.from_id;
            if self.adaptor_commitments.iter().any(|(p, _)| *p == from) {
                return Err(SignError::MissingMessage);
            }
            self.adaptor_commitments.push(from, msg.adaptor_commitment);
            inner.push(msg.inner);
        }
        self.inner.handle_msg1(rng, inner)
    }

    /// Round 2: the library's message 3, plus the opening of this party's
    /// adaptor commitment and its share proof.
    pub fn handle_msg2<R: RngCore + CryptoRng>(
        &mut self,
        rng: &mut R,
        msgs: Vec<SignMsg2>,
    ) -> Result<Vec<AdaptorSignMsg3>, SignError> {
        let inner = self.inner.handle_msg2(rng, msgs)?;

        let party_id = self.inner.keyshare.party_id;
        let lock_point = self.lock.point.to_curve();
        let big_r_i = self.inner.big_r_i.to_curve();
        let big_z_i = self.big_z_i.to_curve();

        // Chaum-Pedersen: knowledge of r_i with R_i = r_i*G and Z_i = r_i*T.
        let mut w = *NonZeroScalar::random(&mut *rng);
        let e = share_proof_challenge(
            &self.inner.final_session_id,
            &self.binding,
            party_id,
            &lock_point,
            &big_r_i,
            &big_z_i,
            &(ProjectivePoint::GENERATOR * w),
            &(lock_point * w),
        );
        let z = w + e * self.inner.r_i;
        w.zeroize();

        Ok(inner
            .into_iter()
            .map(|msg| AdaptorSignMsg3 {
                inner: msg,
                big_z_i: self.big_z_i,
                big_a_i: self.big_a_i,
                big_b_i: self.big_b_i,
                adaptor_blind: self.adaptor_blind,
                share_proof_e: e,
                share_proof_z: z,
            })
            .collect())
    }

    /// Round 3: checks every peer's opening and share proof, then produces
    /// this party's partial signature for the session's digest and lock.
    ///
    /// The session's one-time secrets are wiped before this returns, whether
    /// it succeeds or not; a session cannot run round 3 twice.
    pub fn handle_msg3(
        &mut self,
        msgs: Vec<AdaptorSignMsg3>,
    ) -> Result<(AdaptorPartial, AdaptorSignMsg4), SignError> {
        let result = self.round3(msgs);
        self.a_i.zeroize();
        self.inner.wipe_one_time_secrets();
        result
    }

    fn round3(
        &mut self,
        msgs: Vec<AdaptorSignMsg3>,
    ) -> Result<(AdaptorPartial, AdaptorSignMsg4), SignError> {
        if bool::from(self.a_i.is_zero()) {
            return Err(SignError::FailedCheck("session already used"));
        }
        if msgs.len() != self.inner.keyshare.threshold as usize - 1 {
            return Err(SignError::MissingMessage);
        }
        let party_id = self.inner.keyshare.party_id;
        let lock_point = self.lock.point.to_curve();

        let mut big_r_t = self.big_z_i.to_curve();
        let mut sum_a = self.big_a_i.to_curve();
        let mut sum_b = self.big_b_i.to_curve();
        let mut peers = Pairs::new();
        let mut inner = Vec::with_capacity(msgs.len());

        for msg in msgs {
            let from = msg.inner.from_id;
            if from == party_id || peers.iter().any(|(p, _)| *p == from) {
                return Err(SignError::MissingMessage);
            }
            let commitment = self
                .adaptor_commitments
                .iter()
                .find(|(p, _)| *p == from)
                .map(|(_, c)| *c)
                .ok_or(SignError::MissingMessage)?;
            let session_id = self
                .inner
                .sid_list
                .iter()
                .find(|(p, _)| *p == from)
                .map(|(_, sid)| *sid)
                .ok_or(SignError::MissingMessage)?;

            let big_r = msg.inner.big_r_i.to_curve();
            let big_z = msg.big_z_i.to_curve();
            let big_a = msg.big_a_i.to_curve();
            let big_b = msg.big_b_i.to_curve();
            if is_identity(&big_r)
                || is_identity(&big_z)
                || is_identity(&big_a)
                || is_identity(&big_b)
            {
                return Err(SignError::AbortProtocolAndBanParty(from));
            }

            let opened = adaptor_commitment(
                &self.binding,
                from,
                &session_id,
                &big_z,
                &big_a,
                &big_b,
                &msg.adaptor_blind,
            );
            if !bool::from(opened.ct_eq(&commitment)) {
                return Err(SignError::InvalidCommitment);
            }

            // W_G = z*G - e*R_j,  W_T = z*T - e*Z_j,  e == H(..., W_G, W_T).
            let e = msg.share_proof_e;
            let z = msg.share_proof_z;
            let w_g = ProjectivePoint::GENERATOR * z - big_r * e;
            let w_t = lock_point * z - big_z * e;
            let expected = share_proof_challenge(
                &self.inner.final_session_id,
                &self.binding,
                from,
                &lock_point,
                &big_r,
                &big_z,
                &w_g,
                &w_t,
            );
            if bool::from(e.is_zero()) || expected != e {
                return Err(SignError::AbortProtocolAndBanParty(from));
            }

            big_r_t += big_z;
            sum_a += big_a;
            sum_b += big_b;
            peers.push(
                from,
                PeerShare {
                    big_r: msg.inner.big_r_i,
                    big_z: msg.big_z_i,
                    big_a: msg.big_a_i,
                    big_b: msg.big_b_i,
                },
            );
            inner.push(msg.inner);
        }

        if is_identity(&big_r_t) || is_identity(&sum_a) || is_identity(&sum_b)
        {
            return Err(SignError::FailedCheck("degenerate adaptor nonce"));
        }
        let r_x = x_scalar(&big_r_t);
        if bool::from(r_x.is_zero()) {
            return Err(SignError::FailedCheck("degenerate adaptor nonce"));
        }

        // The library's round 3 with every one of its checks (it verifies
        // each R_j against its round-1 commitment), using r = x(k*T).
        let r_i = self.inner.r_i;
        let pre = self.inner.round3(inner, Some(r_x))?;

        let big_r_a = pre.r.to_curve();
        let challenge =
            joint_challenge(&big_r_a, &lock_point, &big_r_t, &sum_a, &sum_b);
        if bool::from(challenge.is_zero()) {
            return Err(SignError::FailedCheck("degenerate adaptor nonce"));
        }
        let c_i = self.a_i + challenge * r_i;

        let m = Scalar::reduce(U256::from_be_slice(&self.message_hash));
        let s_0 = m * pre.phi_i + pre.s_0;

        let partial = AdaptorPartial {
            party_id,
            final_session_id: pre.final_session_id,
            public_key: pre.public_key,
            message_hash: self.message_hash,
            lock_point: self.lock.point,
            big_r_a: pre.r,
            big_r_t: big_r_t.to_affine(),
            challenge,
            s_0,
            s_1: pre.s_1,
            c_i,
            peers,
        };
        let msg4 = AdaptorSignMsg4 {
            from_id: party_id,
            session_id: partial.final_session_id,
            s_0,
            s_1: partial.s_1,
            c_i,
        };
        Ok((partial, msg4))
    }
}

/// Why a session could not be created.
#[derive(Debug)]
pub enum AdaptorInitError {
    Lock(SignError),
    Path(BIP32Error),
}

/// Round 4: checks every peer's response, combines the partial signatures
/// and verifies the result as a third party would.
///
/// Returns `R || R_a || s_a || b || c`. This function never returns an
/// ordinary signature.
pub fn combine_adaptor_signatures(
    partial: AdaptorPartial,
    msgs: Vec<AdaptorSignMsg4>,
) -> Result<[u8; ADAPTOR_SIGNATURE_BYTES], SignError> {
    if msgs.len() != partial.peers.iter().count() {
        return Err(SignError::FailedCheck(
            "Invalid number of partial signatures",
        ));
    }
    let lock_point = partial.lock_point.to_curve();
    let big_r_a = partial.big_r_a.to_curve();
    let big_r_t = partial.big_r_t.to_curve();
    let b = partial.challenge;

    let mut sum_s_0 = partial.s_0;
    let mut sum_s_1 = partial.s_1;
    let mut c = partial.c_i;
    let mut seen: Vec<u8> = Vec::with_capacity(msgs.len());

    for msg in &msgs {
        if msg.session_id != partial.final_session_id {
            return Err(SignError::InvalidFinalSessionID);
        }
        if seen.contains(&msg.from_id) {
            return Err(SignError::MissingMessage);
        }
        let peer = partial
            .peers
            .iter()
            .find(|(p, _)| *p == msg.from_id)
            .map(|(_, peer)| peer)
            .ok_or(SignError::MissingMessage)?;
        seen.push(msg.from_id);

        // c_j*G = A_j + b*R_j  and  c_j*T = B_j + b*Z_j.
        let on_g = ProjectivePoint::GENERATOR * msg.c_i
            == peer.big_a.to_curve() + peer.big_r.to_curve() * b;
        let on_t = lock_point * msg.c_i
            == peer.big_b.to_curve() + peer.big_z.to_curve() * b;
        if !on_g || !on_t {
            return Err(SignError::AbortProtocolAndBanParty(msg.from_id));
        }

        sum_s_0 += msg.s_0;
        sum_s_1 += msg.s_1;
        c += msg.c_i;
    }

    let sum_s_1_inv: Option<Scalar> = sum_s_1.invert().into();
    let sum_s_1_inv = sum_s_1_inv
        .ok_or(SignError::FailedCheck("degenerate partial signatures"))?;
    let s_a = sum_s_0 * sum_s_1_inv;

    let mut out = [0u8; ADAPTOR_SIGNATURE_BYTES];
    out[..33].copy_from_slice(&point_bytes(&big_r_t));
    out[33..66].copy_from_slice(&point_bytes(&big_r_a));
    out[66..98].copy_from_slice(&scalar_bytes(&s_a));
    out[98..130].copy_from_slice(&scalar_bytes(&b));
    out[130..162].copy_from_slice(&scalar_bytes(&c));

    if !verify_adaptor_signature(
        &partial.public_key.to_curve(),
        &lock_point,
        &partial.message_hash,
        &out,
    ) {
        return Err(SignError::FailedCheck(
            "adaptor signature verification failed",
        ));
    }
    Ok(out)
}

/// Verifies an encrypted signature against a public key, a lock point and a
/// digest, from its bytes alone: the verification of the DLC specification.
pub fn verify_adaptor_signature(
    public_key: &ProjectivePoint,
    lock_point: &ProjectivePoint,
    message_hash: &[u8; 32],
    signature: &[u8; ADAPTOR_SIGNATURE_BYTES],
) -> bool {
    let parsed = (|| -> Result<_, SignError> {
        Ok((
            parse_point(&signature[..33])?,
            parse_point(&signature[33..66])?,
            parse_scalar(&signature[66..98], false)?,
            parse_scalar(&signature[98..130], false)?,
            parse_scalar(&signature[130..162], false)?,
        ))
    })();
    let Ok((big_r_t, big_r_a, s_a, b, c)) = parsed else {
        return false;
    };

    // Equality proof: A_G = c*G - b*R_a,  A_Y = c*T - b*R.
    let a_g = ProjectivePoint::GENERATOR * c - big_r_a * b;
    let a_y = *lock_point * c - big_r_t * b;
    if joint_challenge(&big_r_a, lock_point, &big_r_t, &a_g, &a_y) != b {
        return false;
    }

    // R_a = (m*G + r*P) / s_a  with r = x(R).
    let r = x_scalar(&big_r_t);
    if bool::from(r.is_zero()) {
        return false;
    }
    let s_inv: Option<Scalar> = s_a.invert().into();
    let Some(s_inv) = s_inv else {
        return false;
    };
    let m = Scalar::reduce(U256::from_be_slice(message_hash));
    ProjectivePoint::GENERATOR * (m * s_inv) + *public_key * (r * s_inv)
        == big_r_a
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use k256::ecdsa::{
        signature::hazmat::PrehashVerifier, Signature, VerifyingKey,
    };

    use super::*;
    use crate::dkg::tests::{check_serde, dkg};

    const KEY_ID: &[u8] = b"test key id, any bytes the caller likes.";
    const PROVER: &[u8] = b"bob";
    const VERIFIER: &[u8] = b"alice";
    const HASH: [u8; 32] = [0x5a; 32];

    fn context(key_id: &[u8], prover: &[u8]) -> [u8; 32] {
        transcript(FRANK_TAG_PREFIX, "lock/context", &[key_id, prover])
    }

    fn random_scalar() -> Scalar {
        *NonZeroScalar::random(&mut rand::thread_rng())
    }

    /// A lock's public encoding and its holder's opening.
    type Lock = (Vec<u8>, LockOpening);

    fn point_lock(t: &Scalar, key_id: &[u8], prover: &[u8]) -> Lock {
        (
            point_lock_bytes(t, key_id, prover),
            LockOpening::Point { secret: *t },
        )
    }

    fn commitment_lock(
        s: &Scalar,
        value: u32,
        index: u32,
        key_id: &[u8],
        prover: &[u8],
    ) -> Lock {
        (
            commitment_lock_bytes(s, value, index, key_id, prover),
            LockOpening::Commitment { secret: *s, value },
        )
    }

    /// A point lock for secret `t`, made the way lock.ts makes one.
    fn point_lock_bytes(t: &Scalar, key_id: &[u8], prover: &[u8]) -> Vec<u8> {
        let big_t = ProjectivePoint::GENERATOR * t;
        let t_raw = point_bytes(&big_t);

        let k = random_scalar();
        let big_k = point_bytes(&(ProjectivePoint::GENERATOR * k));
        let e =
            hash_to_scalar(&tagged_hash("ADAPTOR-TWEAK-POK", &[&t_raw, &big_k]));
        let pok_z = k + e * t;

        let n = random_scalar();
        let big_n = point_bytes(&(ProjectivePoint::GENERATOR * n));
        let e = hash_to_scalar(&transcript(
            FRANK_TAG_PREFIX,
            "proof/dlog",
            &[&context(key_id, prover), prover, &t_raw, &big_n],
        ));
        let owner_z = n + e * t;

        let mut out = vec![KIND_POINT];
        out.extend_from_slice(&t_raw);
        out.extend_from_slice(&big_k);
        out.extend_from_slice(&scalar_bytes(&pok_z));
        out.extend_from_slice(&big_n);
        out.extend_from_slice(&scalar_bytes(&owner_z));
        out
    }

    /// A commitment lock to `value` with secret `s`, for candidate `index`.
    fn commitment_lock_bytes(
        s: &Scalar,
        value: u32,
        index: u32,
        key_id: &[u8],
        prover: &[u8],
    ) -> Vec<u8> {
        let h = pedersen_h();
        let h_raw = point_bytes(&h);
        let v = Scalar::from(value);
        let c_raw = point_bytes(&(ProjectivePoint::GENERATOR * s + h * v));

        let a = random_scalar();
        let b = random_scalar();
        let big_a = point_bytes(&(ProjectivePoint::GENERATOR * a + h * b));
        let e = hash_to_scalar(&transcript(
            FRANK_TAG_PREFIX,
            "proof/opening",
            &[&context(key_id, prover), prover, &c_raw, &h_raw, &big_a],
        ));

        let mut out = vec![KIND_COMMITMENT];
        out.extend_from_slice(&c_raw);
        out.extend_from_slice(&h_raw);
        out.extend_from_slice(&big_a);
        out.extend_from_slice(&scalar_bytes(&(a + e * s)));
        out.extend_from_slice(&scalar_bytes(&(b + e * v)));
        out.extend_from_slice(&index.to_be_bytes());
        out
    }

    /// Party 0 is the verifier (extractor), party 1 the lock's holder.
    fn local_id(share: &Keyshare) -> &'static [u8] {
        if share.party_id == 1 {
            PROVER
        } else {
            VERIFIER
        }
    }

    fn sessions(
        shares: &[Keyshare],
        lock: &Lock,
        hash: [u8; 32],
    ) -> Vec<AdaptorState> {
        let mut rng = rand::thread_rng();
        let path = DerivationPath::from_str("m").unwrap();
        shares
            .iter()
            .map(|share| {
                let verified =
                    VerifiedLock::verify(&lock.0, KEY_ID, PROVER).unwrap();
                let opening = (share.party_id == 1).then_some(&lock.1);
                AdaptorState::new(
                    &mut rng,
                    share.clone(),
                    &path,
                    hash,
                    verified,
                    KEY_ID,
                    PROVER,
                    VERIFIER,
                    local_id(share),
                    opening,
                )
                .unwrap()
            })
            .collect()
    }

    struct Round3 {
        parties: Vec<AdaptorState>,
        msg3: Vec<AdaptorSignMsg3>,
    }

    /// Runs rounds 1 and 2 honestly.
    fn until_round3(mut parties: Vec<AdaptorState>) -> Round3 {
        let mut rng = rand::thread_rng();
        let msg1: Vec<AdaptorSignMsg1> =
            parties.iter_mut().map(|p| p.generate_msg1()).collect();
        check_serde(&msg1);
        let msg2: Vec<SignMsg2> = parties
            .iter_mut()
            .flat_map(|p| {
                let id = p.inner.keyshare.party_id;
                let batch = msg1
                    .iter()
                    .filter(|m| m.inner.from_id != id)
                    .cloned()
                    .collect();
                p.handle_msg1(&mut rng, batch).unwrap()
            })
            .collect();
        let msg3: Vec<AdaptorSignMsg3> = parties
            .iter_mut()
            .flat_map(|p| {
                let id = p.inner.keyshare.party_id;
                let batch =
                    msg2.iter().filter(|m| m.to_id == id).cloned().collect();
                p.handle_msg2(&mut rng, batch).unwrap()
            })
            .collect();
        check_serde(&msg3);
        Round3 { parties, msg3 }
    }

    fn for_party(msgs: &[AdaptorSignMsg3], id: u8) -> Vec<AdaptorSignMsg3> {
        msgs.iter().filter(|m| m.inner.to_id == id).cloned().collect()
    }

    /// The whole protocol; returns each party's encrypted signature.
    fn pre_sign(
        shares: &[Keyshare],
        lock: &Lock,
        hash: [u8; 32],
    ) -> Vec<[u8; ADAPTOR_SIGNATURE_BYTES]> {
        let Round3 { mut parties, msg3 } =
            until_round3(sessions(shares, lock, hash));
        let (partials, msg4): (Vec<_>, Vec<_>) = parties
            .iter_mut()
            .map(|p| {
                let id = p.inner.keyshare.party_id;
                p.handle_msg3(for_party(&msg3, id)).unwrap()
            })
            .unzip();
        check_serde(&msg4);
        partials
            .into_iter()
            .map(|partial| {
                let batch = msg4
                    .iter()
                    .filter(|m| m.from_id != partial.party_id)
                    .cloned()
                    .collect();
                combine_adaptor_signatures(partial, batch).unwrap()
            })
            .collect()
    }

    /// Completion as `@frank/adaptor-signatures` does it: s = s_a / t, low-s.
    fn complete(
        signature: &[u8; ADAPTOR_SIGNATURE_BYTES],
        secret: &Scalar,
    ) -> Signature {
        let big_r_t = parse_point(&signature[..33]).unwrap();
        let s_a = parse_scalar(&signature[66..98], false).unwrap();
        let s = s_a * secret.invert().unwrap();
        let sign = Signature::from_scalars(x_scalar(&big_r_t), s).unwrap();
        sign.normalize_s().unwrap_or(sign)
    }

    fn verifies(
        public_key: &AffinePoint,
        hash: &[u8; 32],
        signature: &Signature,
    ) -> bool {
        VerifyingKey::from_affine(*public_key)
            .unwrap()
            .verify_prehash(hash, signature)
            .is_ok()
    }

    /// Extraction: t = s_a / s, up to sign.
    fn extract(
        signature: &[u8; ADAPTOR_SIGNATURE_BYTES],
        completed: &Signature,
        lock_point: &ProjectivePoint,
    ) -> Option<Scalar> {
        let s_a = parse_scalar(&signature[66..98], false).unwrap();
        let s: Scalar = *completed.s();
        let t = s_a * s.invert().unwrap();
        [t, -t]
            .into_iter()
            .find(|c| ProjectivePoint::GENERATOR * c == *lock_point)
    }

    #[test]
    fn second_generator_matches_the_typescript_package() {
        // Value printed by PEDERSEN_H in @frank/threshold-ecdsa (lock.ts).
        let expected = include_str!("../frank-vectors/pedersen-h.hex").trim();
        let got: String = point_bytes(&pedersen_h())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(got, expected);
    }

    #[test]
    fn point_lock_honest_run_completes_and_extracts() {
        let shares = dkg(2, 2);
        let t = random_scalar();
        let lock = point_lock(&t, KEY_ID, PROVER);
        let big_t = ProjectivePoint::GENERATOR * t;

        let signatures = pre_sign(&shares, &lock, HASH);
        assert_eq!(signatures[0], signatures[1]);
        let public_key = shares[0].public_key;
        assert!(verify_adaptor_signature(
            &public_key.to_curve(),
            &big_t,
            &HASH,
            &signatures[0]
        ));

        // The encrypted signature is not itself a signature.
        let raw = Signature::from_scalars(
            x_scalar(&parse_point(&signatures[0][..33]).unwrap()),
            parse_scalar(&signatures[0][66..98], false).unwrap(),
        )
        .unwrap();
        assert!(!verifies(&public_key, &HASH, &raw));

        let completed = complete(&signatures[0], &t);
        assert!(verifies(&public_key, &HASH, &completed));
        assert_eq!(extract(&signatures[0], &completed, &big_t), Some(t));
    }

    #[test]
    fn completing_with_the_wrong_secret_fails() {
        let shares = dkg(2, 2);
        let t = random_scalar();
        let lock = point_lock(&t, KEY_ID, PROVER);
        let signatures = pre_sign(&shares, &lock, HASH);
        let wrong = complete(&signatures[0], &(t + Scalar::ONE));
        assert!(!verifies(&shares[0].public_key, &HASH, &wrong));
    }

    #[test]
    fn commitment_lock_completes_only_for_the_committed_value() {
        let shares = dkg(2, 2);
        let s = random_scalar();
        let value = 7u32;
        let public_key = shares[0].public_key;
        let h = pedersen_h();
        let commitment =
            ProjectivePoint::GENERATOR * s + h * Scalar::from(value);

        for index in [0u32, 7, 51] {
            let lock = commitment_lock(&s, value, index, KEY_ID, PROVER);
            let lock_point = commitment - h * Scalar::from(index);
            let verified =
                VerifiedLock::verify(&lock.0, KEY_ID, PROVER).unwrap();
            assert_eq!(verified.point_bytes(), point_bytes(&lock_point));

            let signatures = pre_sign(&shares, &lock, HASH);
            assert!(verify_adaptor_signature(
                &public_key.to_curve(),
                &lock_point,
                &HASH,
                &signatures[0]
            ));
            let completed = complete(&signatures[0], &s);
            assert_eq!(verifies(&public_key, &HASH, &completed), index == value);
            if index == value {
                assert_eq!(
                    extract(&signatures[0], &completed, &lock_point),
                    Some(s)
                );
            }
        }
    }

    #[test]
    fn lock_without_valid_proofs_is_refused() {
        let t = random_scalar();
        let good = point_lock_bytes(&t, KEY_ID, PROVER);
        assert!(VerifiedLock::verify(&good, KEY_ID, PROVER).is_ok());
        // Bound to the key and to the prover.
        assert!(VerifiedLock::verify(&good, b"another key", PROVER).is_err());
        assert!(VerifiedLock::verify(&good, KEY_ID, b"mallory").is_err());
        // A different point under the same proofs.
        let other = point_bytes(&(ProjectivePoint::GENERATOR * random_scalar()));
        let mut swapped = good.clone();
        swapped[1..34].copy_from_slice(&other);
        assert!(VerifiedLock::verify(&swapped, KEY_ID, PROVER).is_err());
        // Every single-bit change of a proof byte.
        for index in [40, 70, 100, 140, 163] {
            let mut bad = good.clone();
            bad[index] ^= 1;
            assert!(VerifiedLock::verify(&bad, KEY_ID, PROVER).is_err());
        }
        assert!(VerifiedLock::verify(&good[..163], KEY_ID, PROVER).is_err());
        assert!(VerifiedLock::verify(&[], KEY_ID, PROVER).is_err());

        let s = random_scalar();
        let good = commitment_lock_bytes(&s, 3, 3, KEY_ID, PROVER);
        assert!(VerifiedLock::verify(&good, KEY_ID, PROVER).is_ok());
        assert!(VerifiedLock::verify(&good, KEY_ID, b"mallory").is_err());
        for index in [5, 40, 70, 110, 150] {
            let mut bad = good.clone();
            bad[index] ^= 1;
            assert!(VerifiedLock::verify(&bad, KEY_ID, PROVER).is_err());
        }
        // The index is not covered by the proof: another index is another
        // valid lock of the same commitment, with another lock point.
        let mut other_index = good.clone();
        other_index[167] ^= 1;
        let a = VerifiedLock::verify(&good, KEY_ID, PROVER).unwrap();
        let b = VerifiedLock::verify(&other_index, KEY_ID, PROVER).unwrap();
        assert_ne!(a.point_bytes(), b.point_bytes());
    }

    fn try_start(
        share: &Keyshare,
        lock: &[u8],
        lock_key: &[u8],
        local: &[u8],
        opening: Option<&LockOpening>,
    ) -> Result<AdaptorState, AdaptorInitError> {
        let verified = VerifiedLock::verify(lock, lock_key, PROVER).unwrap();
        let path = DerivationPath::from_str("m").unwrap();
        AdaptorState::new(
            &mut rand::thread_rng(),
            share.clone(),
            &path,
            HASH,
            verified,
            KEY_ID,
            PROVER,
            VERIFIER,
            local,
            opening,
        )
    }

    #[test]
    fn session_refuses_a_lock_verified_for_another_key() {
        let shares = dkg(2, 2);
        let (lock, _) = point_lock(&random_scalar(), b"another key", PROVER);
        assert!(
            try_start(&shares[0], &lock, b"another key", VERIFIER, None)
                .is_err()
        );
    }

    #[test]
    fn holder_only_pre_signs_under_a_lock_it_can_open() {
        let shares = dkg(2, 2);
        let t = random_scalar();
        let (lock, opening) = point_lock(&t, KEY_ID, PROVER);
        let start = |share: &Keyshare, local: &[u8], opening| {
            try_start(share, &lock, KEY_ID, local, opening)
        };

        // The holder with its own opening, the other party without one.
        assert!(start(&shares[1], PROVER, Some(&opening)).is_ok());
        assert!(start(&shares[0], VERIFIER, None).is_ok());

        // The attack this rule exists for: the other party made the lock
        // from a secret of its own and named the holder in its proofs. The
        // proofs verify, but the holder has no opening and does not start.
        assert!(start(&shares[1], PROVER, None).is_err());
        let wrong = LockOpening::Point {
            secret: t + Scalar::ONE,
        };
        assert!(start(&shares[1], PROVER, Some(&wrong)).is_err());
        let wrong_kind = LockOpening::Commitment {
            secret: t,
            value: 0,
        };
        assert!(start(&shares[1], PROVER, Some(&wrong_kind)).is_err());

        // The other party never passes an opening, and a third identity is
        // not a party of the session.
        assert!(start(&shares[0], VERIFIER, Some(&opening)).is_err());
        assert!(start(&shares[0], b"mallory", None).is_err());

        // Commitment lock: the opening is (s, v) of C, whatever the index.
        let s = random_scalar();
        let (lock, opening) = commitment_lock(&s, 7, 3, KEY_ID, PROVER);
        let start = |opening| {
            try_start(&shares[1], &lock, KEY_ID, PROVER, opening)
        };
        assert!(start(Some(&opening)).is_ok());
        assert!(start(None).is_err());
        let wrong_value = LockOpening::Commitment {
            secret: s,
            value: 8,
        };
        assert!(start(Some(&wrong_value)).is_err());
        let wrong_secret = LockOpening::Commitment {
            secret: s + Scalar::ONE,
            value: 7,
        };
        assert!(start(Some(&wrong_secret)).is_err());
        assert!(LockOpening::from_bytes(&[1u8; 31]).is_err());
        assert!(LockOpening::from_bytes(&[0u8; 32]).is_err());
    }

    #[test]
    fn wrong_share_proof_is_rejected() {
        let shares = dkg(2, 2);
        let lock = point_lock(&random_scalar(), KEY_ID, PROVER);

        // A tampered response.
        let Round3 { mut parties, msg3 } =
            until_round3(sessions(&shares, &lock, HASH));
        let mut batch = for_party(&msg3, 0);
        batch[0].share_proof_z += Scalar::ONE;
        assert!(matches!(
            parties[0].handle_msg3(batch),
            Err(SignError::AbortProtocolAndBanParty(1))
        ));
        // The failed session is dead: the honest messages no longer work.
        assert!(parties[0].handle_msg3(for_party(&msg3, 0)).is_err());

        // Z_j that is not r_j*T, with the commitment recomputed to match so
        // that only the share proof stands in the way.
        let mut parties = sessions(&shares, &lock, HASH);
        let cheat = (parties[1].lock.point.to_curve() * random_scalar())
            .to_affine();
        parties[1].big_z_i = cheat;
        let sid = *parties[1].inner.sid_list.find_pair(1);
        let commitment = adaptor_commitment(
            &parties[1].binding,
            1,
            &sid,
            &cheat.to_curve(),
            &parties[1].big_a_i.to_curve(),
            &parties[1].big_b_i.to_curve(),
            &parties[1].adaptor_blind,
        );
        parties[1].adaptor_commitments = Pairs::new_with_item(1, commitment);
        let Round3 { mut parties, msg3 } = until_round3(parties);
        assert!(matches!(
            parties[0].handle_msg3(for_party(&msg3, 0)),
            Err(SignError::AbortProtocolAndBanParty(1))
        ));
    }

    #[test]
    fn nonce_share_swapped_after_commitment_is_rejected() {
        let shares = dkg(2, 2);
        let lock = point_lock(&random_scalar(), KEY_ID, PROVER);
        let Round3 { mut parties, msg3 } =
            until_round3(sessions(&shares, &lock, HASH));
        let mut batch = for_party(&msg3, 0);
        batch[0].big_z_i =
            (batch[0].big_z_i.to_curve() + ProjectivePoint::GENERATOR)
                .to_affine();
        assert!(matches!(
            parties[0].handle_msg3(batch),
            Err(SignError::InvalidCommitment)
        ));
    }

    #[test]
    fn lock_swapped_between_rounds_is_rejected() {
        let shares = dkg(2, 2);
        let lock_a = point_lock(&random_scalar(), KEY_ID, PROVER);
        let lock_b = point_lock(&random_scalar(), KEY_ID, PROVER);
        let mut rng = rand::thread_rng();

        // Party 0 runs with lock A, party 1 with lock B: they are in
        // different sessions and stop in round 2, before any nonce share,
        // lock share or partial signature has been sent.
        let mut a = sessions(&shares[..1], &lock_a, HASH);
        let mut b = sessions(&shares[1..], &lock_b, HASH);
        let a1 = a[0].generate_msg1();
        let b1 = b[0].generate_msg1();
        let a2 = a[0].handle_msg1(&mut rng, vec![b1]).unwrap();
        let b2 = b[0].handle_msg1(&mut rng, vec![a1]).unwrap();
        assert!(matches!(
            a[0].handle_msg2(&mut rng, b2),
            Err(SignError::InvalidFinalSessionID)
        ));
        assert!(matches!(
            b[0].handle_msg2(&mut rng, a2),
            Err(SignError::InvalidFinalSessionID)
        ));

        // The same for two digests under one lock.
        let mut a = sessions(&shares[..1], &lock_a, HASH);
        let mut b = sessions(&shares[1..], &lock_a, [0x11; 32]);
        let a1 = a[0].generate_msg1();
        let b1 = b[0].generate_msg1();
        let _ = a[0].handle_msg1(&mut rng, vec![b1]).unwrap();
        let b2 = b[0].handle_msg1(&mut rng, vec![a1]).unwrap();
        assert!(matches!(
            a[0].handle_msg2(&mut rng, b2),
            Err(SignError::InvalidFinalSessionID)
        ));

        // A party that changes its own lock after round 1 fails its own
        // peer's check of the round-1 commitment, which covers the binding.
        let Round3 { mut parties, mut msg3 } =
            until_round3(sessions(&shares, &lock_a, HASH));
        let other = VerifiedLock::verify(&lock_b.0, KEY_ID, PROVER).unwrap();
        let other_point = other.point.to_curve();
        for msg in msg3.iter_mut().filter(|m| m.inner.from_id == 1) {
            msg.big_z_i = (other_point * random_scalar()).to_affine();
        }
        assert!(parties[0].handle_msg3(for_party(&msg3, 0)).is_err());
    }

    #[test]
    fn messages_replayed_from_another_session_are_rejected() {
        let shares = dkg(2, 2);
        let lock = point_lock(&random_scalar(), KEY_ID, PROVER);

        // Round 3 messages of one session fed to another session of the
        // same key, lock and digest.
        let first = until_round3(sessions(&shares, &lock, HASH));
        let Round3 { mut parties, .. } =
            until_round3(sessions(&shares, &lock, HASH));
        assert!(parties[0].handle_msg3(for_party(&first.msg3, 0)).is_err());

        // Round 4 messages of one session fed to another.
        let Round3 { parties: mut old, msg3: old3 } = first;
        let (_, old4) = old[1].handle_msg3(for_party(&old3, 1)).unwrap();
        // (`parties[0]` above is dead after its failed round 3.)
        let Round3 { mut parties, msg3 } =
            until_round3(sessions(&shares, &lock, HASH));
        let (partial0, _) =
            parties[0].handle_msg3(for_party(&msg3, 0)).unwrap();
        assert!(matches!(
            combine_adaptor_signatures(partial0, vec![old4]),
            Err(SignError::InvalidFinalSessionID)
        ));
    }

    #[test]
    fn wrong_joint_response_or_partial_is_rejected() {
        let shares = dkg(2, 2);
        let lock = point_lock(&random_scalar(), KEY_ID, PROVER);

        for tamper in 0..3 {
            let Round3 { mut parties, msg3 } =
                until_round3(sessions(&shares, &lock, HASH));
            let (partial0, _) =
                parties[0].handle_msg3(for_party(&msg3, 0)).unwrap();
            let (_, mut msg4) =
                parties[1].handle_msg3(for_party(&msg3, 1)).unwrap();
            match tamper {
                0 => msg4.c_i += Scalar::ONE,
                1 => msg4.s_0 += Scalar::ONE,
                _ => msg4.s_1 += Scalar::ONE,
            }
            let result = combine_adaptor_signatures(partial0, vec![msg4]);
            if tamper == 0 {
                assert!(matches!(
                    result,
                    Err(SignError::AbortProtocolAndBanParty(1))
                ));
            } else {
                assert!(matches!(result, Err(SignError::FailedCheck(_))));
            }
        }
    }

    #[test]
    fn a_session_signs_once_and_only_for_its_digest() {
        let shares = dkg(2, 2);
        let lock = point_lock(&random_scalar(), KEY_ID, PROVER);
        let Round3 { mut parties, msg3 } =
            until_round3(sessions(&shares, &lock, HASH));

        // Round 3 cannot run twice, not even on a copy taken beforehand.
        let before = {
            let mut bytes = vec![];
            ciborium::into_writer(&parties[0], &mut bytes).unwrap();
            bytes
        };
        assert!(parties[0].handle_msg3(for_party(&msg3, 0)).is_ok());
        assert!(parties[0].handle_msg3(for_party(&msg3, 0)).is_err());
        assert!(bool::from(parties[0].inner.r_i.is_zero()));
        assert!(bool::from(parties[0].inner.phi_i.is_zero()));
        assert!(bool::from(parties[0].a_i.is_zero()));

        // A restored copy gives the same partial signature for the same
        // digest and lock; there is no way to give it another one.
        let mut restored: AdaptorState =
            ciborium::from_reader(before.as_slice()).unwrap();
        let (partial, _) =
            restored.handle_msg3(for_party(&msg3, 0)).unwrap();
        assert_eq!(partial.message_hash, HASH);

        // The library's own entry points refuse a bound session.
        let Round3 { mut parties, msg3 } =
            until_round3(sessions(&shares, &lock, HASH));
        let inner: Vec<SignMsg3> = for_party(&msg3, 0)
            .into_iter()
            .map(|m| m.inner)
            .collect();
        assert!(parties[0].inner.handle_msg3(inner).is_err());
    }
}
