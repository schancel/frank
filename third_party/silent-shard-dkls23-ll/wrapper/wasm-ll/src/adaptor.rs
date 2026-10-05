// This file is NOT part of the Silence Laboratories library as published.
// It was added on 2026-10-04 by the Frank project, independently and without
// any involvement from Silence Laboratories. See ../../../CHANGES.
//
// It is a modification of the Library and is therefore covered by the
// Silence Laboratories License Agreement in ../../../LICENSE.md.

//! JavaScript bindings for adaptor pre-signing (`dkls23_ll::adaptor`).

use std::str::FromStr;

use derivation_path::DerivationPath;
use js_sys::{Error, Uint8Array};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use dkls23_ll::adaptor::{
    self, AdaptorPartial, AdaptorSignMsg1, AdaptorSignMsg3, AdaptorSignMsg4,
    AdaptorState, LockOpening, VerifiedLock,
};

use crate::{
    errors::sign_error,
    keyshare::Keyshare,
    maybe_seeded_rng,
    message::{Message, MessageRouting},
};

#[derive(Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
enum Round {
    Init,
    WaitMsg1,
    WaitMsg2,
    WaitMsg3,
    Partial(AdaptorPartial, AdaptorSignMsg4),
    WaitMsg4(AdaptorPartial),
    Failed,
    Finished,
}

/// Verifies a lock (see `VerifiedLock::verify`) and returns its 33-byte lock
/// point. Throws if any proof fails.
#[wasm_bindgen(js_name = verifyLock)]
pub fn verify_lock(
    lock: &[u8],
    key_id: &[u8],
    prover_id: &[u8],
) -> Result<Uint8Array, Error> {
    let lock =
        VerifiedLock::verify(lock, key_id, prover_id).map_err(sign_error)?;
    Ok(Uint8Array::from(&lock.point_bytes() as &[u8]))
}

/// A two-party adaptor pre-signing session for one digest and one lock.
#[derive(Serialize, Deserialize)]
#[wasm_bindgen]
pub struct AdaptorSignSession {
    state: AdaptorState,
    round: Round,
}

#[wasm_bindgen]
impl AdaptorSignSession {
    /// Creates a session. Throws if the lock's proofs do not verify for
    /// `key_id` and `prover_id`, or if this party is the lock's holder
    /// (`local_id` equals `prover_id`) and `opening` does not open the lock.
    ///
    /// `opening` is `t` (32 bytes) for a point lock or `s || v` (32 + 4
    /// bytes, `v` big-endian) for a commitment lock. The holder must pass
    /// it; the other party must not.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = create)]
    pub fn create(
        keyshare: Keyshare,
        chain_path: &str,
        message_hash: &[u8],
        lock: &[u8],
        key_id: &[u8],
        prover_id: &[u8],
        verifier_id: &[u8],
        local_id: &[u8],
        opening: Option<Vec<u8>>,
        seed: Option<Vec<u8>>,
    ) -> Result<AdaptorSignSession, Error> {
        let seed: Option<[u8; 32]> = match seed {
            None => None,
            Some(seed) => Some(
                seed.try_into()
                    .map_err(|_| Error::new("invalid seed size"))?,
            ),
        };
        let mut rng = maybe_seeded_rng(seed);

        let chain_path = DerivationPath::from_str(chain_path)
            .map_err(|_| Error::new("invalid derivation path"))?;
        let hash: [u8; 32] = message_hash
            .try_into()
            .map_err(|_| Error::new("invalid message hash"))?;
        let lock = VerifiedLock::verify(lock, key_id, prover_id)
            .map_err(sign_error)?;
        let opening = match opening {
            None => None,
            Some(bytes) => {
                Some(LockOpening::from_bytes(&bytes).map_err(sign_error)?)
            }
        };

        let state = AdaptorState::new(
            &mut rng,
            keyshare.into_inner(),
            &chain_path,
            hash,
            lock,
            key_id,
            prover_id,
            verifier_id,
            local_id,
            opening.as_ref(),
        )
        .map_err(|err| match err {
            adaptor::AdaptorInitError::Lock(err) => sign_error(err),
            adaptor::AdaptorInitError::Path(_) => {
                Error::new("sign session init")
            }
        })?;

        Ok(AdaptorSignSession {
            state,
            round: Round::Init,
        })
    }

    /// The lock point `T`, 33 bytes.
    #[wasm_bindgen(js_name = lockPoint, getter)]
    pub fn lock_point(&self) -> Uint8Array {
        Uint8Array::from(&self.state.lock_point_bytes() as &[u8])
    }

    /// Serialize session into array of bytes.
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let mut buffer = vec![];
        ciborium::into_writer(self, &mut buffer)
            .map_err(|_| Error::new("CBOR encode error"))?;
        Ok(buffer)
    }

    /// Deserialize session from array of bytes.
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<AdaptorSignSession, Error> {
        ciborium::from_reader(bytes)
            .map_err(|_| Error::new("CBOR decode error"))
    }

    /// Create the first message.
    #[wasm_bindgen(js_name = createFirstMessage)]
    pub fn create_first_message(&mut self) -> Result<Message, Error> {
        match self.round {
            Round::Init => {
                self.round = Round::WaitMsg1;
                Ok(Message::new(self.state.generate_msg1()))
            }
            _ => Err(Error::new("invalid state")),
        }
    }

    /// Handle a batch of messages and return the messages to send.
    /// Any error leaves the session failed for good.
    #[wasm_bindgen(js_name = handleMessages)]
    pub fn handle_messages(
        &mut self,
        msgs: Vec<Message>,
        seed: Option<Vec<u8>>,
    ) -> Result<Vec<Message>, Error> {
        let seed: Option<[u8; 32]> = match seed {
            None => None,
            Some(seed) => Some(
                seed.try_into()
                    .map_err(|_| Error::new("invalid seed size"))?,
            ),
        };
        let mut rng = maybe_seeded_rng(seed);

        match core::mem::replace(&mut self.round, Round::Failed) {
            Round::WaitMsg1 => {
                let msgs: Vec<AdaptorSignMsg1> =
                    Message::try_decode_vector(&msgs)?;
                let out = self
                    .state
                    .handle_msg1(&mut rng, msgs)
                    .map_err(sign_error)?;
                self.round = Round::WaitMsg2;
                Ok(Message::encode_vector(out))
            }

            Round::WaitMsg2 => {
                let msgs = Message::try_decode_vector(&msgs)?;
                let out = self
                    .state
                    .handle_msg2(&mut rng, msgs)
                    .map_err(sign_error)?;
                self.round = Round::WaitMsg3;
                Ok(Message::encode_vector(out))
            }

            Round::WaitMsg3 => {
                let msgs: Vec<AdaptorSignMsg3> =
                    Message::try_decode_vector(&msgs)?;
                let (partial, msg4) =
                    self.state.handle_msg3(msgs).map_err(sign_error)?;
                self.round = Round::Partial(partial, msg4);
                Ok(vec![])
            }

            Round::Failed => Err(Error::new("failed")),

            previous => {
                self.round = previous;
                Err(Error::new("invalid session state"))
            }
        }
    }

    /// Returns the last message: this party's partial signature and its
    /// response to the joint proof challenge.
    #[wasm_bindgen(js_name = lastMessage)]
    pub fn last_message(&mut self) -> Result<Message, Error> {
        match core::mem::replace(&mut self.round, Round::Finished) {
            Round::Partial(partial, msg4) => {
                self.round = Round::WaitMsg4(partial);
                Ok(Message::new(msg4))
            }
            previous => {
                self.round = previous;
                Err(Error::new("invalid state"))
            }
        }
    }

    /// Combine the last messages and return the 162-byte encrypted
    /// signature `R || R_a || s_a || b || c`, verified. Never returns an
    /// ordinary signature. Consumes the session.
    #[wasm_bindgen(js_name = combine)]
    pub fn combine(self, msgs: Vec<Message>) -> Result<Uint8Array, Error> {
        match self.round {
            Round::WaitMsg4(partial) => {
                let msgs: Vec<AdaptorSignMsg4> =
                    Message::try_decode_vector(&msgs)?;
                let signature =
                    adaptor::combine_adaptor_signatures(partial, msgs)
                        .map_err(sign_error)?;
                Ok(Uint8Array::from(&signature as &[u8]))
            }
            _ => Err(Error::new("invalid state")),
        }
    }
}

impl MessageRouting for AdaptorSignMsg1 {
    fn src_party_id(&self) -> u8 {
        self.inner.from_id
    }

    fn dst_party_id(&self) -> Option<u8> {
        None
    }
}

impl MessageRouting for AdaptorSignMsg3 {
    fn src_party_id(&self) -> u8 {
        self.inner.from_id
    }

    fn dst_party_id(&self) -> Option<u8> {
        Some(self.inner.to_id)
    }
}

impl MessageRouting for AdaptorSignMsg4 {
    fn src_party_id(&self) -> u8 {
        self.from_id
    }

    fn dst_party_id(&self) -> Option<u8> {
        None
    }
}
