// Copyright (c) Silence Laboratories Pte. Ltd. All Rights Reserved.
// This software is licensed under the Silence Laboratories License Agreement.

use std::str::FromStr;

use derivation_path::DerivationPath;
use js_sys::{Array, Error, Uint8Array};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use dkls23_ll::dsg;

use crate::{
    errors::sign_error,
    keyshare::Keyshare,
    maybe_seeded_rng,
    message::{Message, MessageRouting},
};

#[derive(Serialize, Deserialize)]
enum Round {
    Init,
    WaitMsg1,
    WaitMsg2,
    WaitMsg3,
    // Changed by the Frank fork (2026-10-04): upstream had
    // `Pre(dsg::PreSignature)` here, a state that could sign any digest.
    // A session now goes from round 3 directly to its partial signature.
    Partial(dsg::PartialSignature, dsg::SignMsg4),
    WaitMsg4(dsg::PartialSignature),
    Failed,
    Finished,
}

#[derive(Serialize, Deserialize)]
#[wasm_bindgen]
pub struct SignSession {
    state: dsg::State,
    round: Round,
}

#[wasm_bindgen]
impl SignSession {
    /// Create a new session.
    ///
    /// Changed by the Frank fork (2026-10-04): the 32-byte digest to sign
    /// and a context both parties agree on (any bytes, may be empty) are
    /// given here and bound into the session. The session can sign nothing
    /// else, and two parties that disagree on either stop in round 2.
    #[wasm_bindgen(constructor)]
    pub fn new(
        keyshare: Keyshare,
        chain_path: &str,
        message_hash: &[u8],
        context: &[u8],
        seed: Option<Vec<u8>>,
    ) -> Self {
        let mut rng = maybe_seeded_rng(seed);

        let chain_path = DerivationPath::from_str(chain_path)
            .expect_throw("invalid derivation path");

        let hash: [u8; 32] =
            message_hash.try_into().expect_throw("invalid message hash");

        let state = dsg::State::new_bound(
            &mut rng,
            keyshare.into_inner(),
            &chain_path,
            hash,
            dsg::plain_binding(&hash, context),
        )
        .expect_throw("sign session init");

        SignSession {
            state,
            round: Round::Init,
        }
    }

    /// Serialize session into array of bytes.
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buffer = vec![];
        ciborium::into_writer(self, &mut buffer)
            .expect_throw("CBOR encode error");

        buffer
    }

    /// Deserialize session from array of bytes.
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> SignSession {
        ciborium::from_reader(bytes).expect_throw("CBOR decode error")
    }

    /// Return an error message, if any.
    #[wasm_bindgen(js_name = error)]
    pub fn error(&self) -> Option<Error> {
        match &self.round {
            Round::Failed => Some(Error::new("failed")),
            _ => None,
        }
    }

    /// Create a fist message and change session state from Init to WaitMg1.
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

    fn handle<T, U, H>(
        &mut self,
        msgs: Vec<Message>,
        mut h: H,
        next: Round,
    ) -> Result<Vec<Message>, Error>
    where
        T: DeserializeOwned,
        U: Serialize + MessageRouting,
        H: FnMut(&mut dsg::State, Vec<T>) -> Result<Vec<U>, dsg::SignError>,
    {
        // Changed by the Frank fork (2026-10-04): a malformed message is an
        // error, not a trap.
        let msgs: Vec<T> = match Message::try_decode_vector(&msgs) {
            Ok(msgs) => msgs,
            Err(err) => {
                self.round = Round::Failed;
                return Err(err);
            }
        };
        match h(&mut self.state, msgs) {
            Ok(msgs) => {
                let out = Message::encode_vector(msgs);
                self.round = next;
                Ok(out)
            }

            Err(err) => {
                self.round = Round::Failed;
                Err(sign_error(err))
            }
        }
    }

    /// Handle a batch of messages.
    /// Decode, process and return an array messages to send to other parties.
    #[wasm_bindgen(js_name = handleMessages)]
    pub fn handle_messages(
        &mut self,
        msgs: Vec<Message>,
        seed: Option<Vec<u8>>,
    ) -> Result<Vec<Message>, Error> {
        let mut rng = maybe_seeded_rng(seed);

        match &self.round {
            Round::WaitMsg1 => self.handle(
                msgs,
                |state, msgs| state.handle_msg1(&mut rng, msgs),
                Round::WaitMsg2,
            ),

            Round::WaitMsg2 => self.handle(
                msgs,
                |state, msgs| state.handle_msg2(&mut rng, msgs),
                Round::WaitMsg3,
            ),

            Round::WaitMsg3 => {
                // Changed by the Frank fork (2026-10-04): no pre-signature
                // is kept; the partial signature for the session's digest
                // is made here and the one-time secrets are wiped.
                self.round = Round::Failed;
                let msgs = Message::try_decode_vector(&msgs)?;
                let (partial, msg4) =
                    self.state.finish_bound(msgs).map_err(sign_error)?;

                self.round = Round::Partial(partial, msg4);

                Ok(vec![])
            }

            Round::Failed => Err(Error::new("failed")),

            _ => Err(Error::new("invalid session state")),
        }
    }

    /// Returns the last message: this party's partial signature for the
    /// digest the session was created with.
    ///
    /// Changed by the Frank fork (2026-10-04): upstream took the digest
    /// here.
    #[wasm_bindgen(js_name = lastMessage)]
    pub fn last_message(&mut self) -> Result<Message, Error> {
        match core::mem::replace(&mut self.round, Round::Finished) {
            Round::Partial(partial, msg4) => {
                self.round = Round::WaitMsg4(partial);

                Ok(Message::new(msg4))
            }

            prev => {
                self.round = prev;
                Err(Error::new("invalid state"))
            }
        }
    }

    /// Combine last messages and return signature as [R, S].
    /// R, S are 32 byte UintArray.
    ///
    /// This method consumes the session and deallocates all
    /// internal data.
    ///
    #[wasm_bindgen(js_name = combine)]
    pub fn combine_partial_signature(
        self,
        msgs: Vec<Message>,
    ) -> Result<Array, Error> {
        match self.round {
            Round::WaitMsg4(partial) => {
                let msgs = Message::try_decode_vector(&msgs)?;
                let sign = dsg::combine_signatures(partial, msgs)
                    .map_err(sign_error)?;

                let (r, s) = sign.split_bytes();

                let a = js_sys::Array::new_with_length(2);

                a.set(0, Uint8Array::from(&r as &[u8]).into());
                a.set(1, Uint8Array::from(&s as &[u8]).into());

                Ok(a)
            }

            _ => Err(Error::new("invalid state")),
        }
    }
}

impl MessageRouting for dsg::SignMsg1 {
    fn src_party_id(&self) -> u8 {
        self.from_id
    }

    fn dst_party_id(&self) -> Option<u8> {
        None
    }
}

impl MessageRouting for dsg::SignMsg2 {
    fn src_party_id(&self) -> u8 {
        self.from_id
    }

    fn dst_party_id(&self) -> Option<u8> {
        Some(self.to_id)
    }
}

impl MessageRouting for dsg::SignMsg3 {
    fn src_party_id(&self) -> u8 {
        self.from_id
    }

    fn dst_party_id(&self) -> Option<u8> {
        Some(self.to_id)
    }
}

impl MessageRouting for dsg::SignMsg4 {
    fn src_party_id(&self) -> u8 {
        self.from_id
    }

    fn dst_party_id(&self) -> Option<u8> {
        None
    }
}

impl MessageRouting for dsg::PreSignature {
    fn src_party_id(&self) -> u8 {
        self.from_id
    }

    fn dst_party_id(&self) -> Option<u8> {
        None
    }
}
