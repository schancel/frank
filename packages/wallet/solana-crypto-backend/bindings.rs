use super::*;
use wasm_bindgen::prelude::*;

fn failure(error: Error) -> JsValue {
    JsValue::from_str(&format!("solana-custody:{error:?}"))
}

/// Experimental private host handle. No key material or arbitrary signing exports.
#[wasm_bindgen]
pub struct RecipientCustody {
    scope: Option<CustodyScope>,
}

#[wasm_bindgen]
impl RecipientCustody {
    #[wasm_bindgen(constructor)]
    pub fn new(
        account_id: Vec<u8>,
        chain_identifier: String,
        seed: Vec<u8>,
    ) -> Result<RecipientCustody, JsValue> {
        let seed = Zeroizing::new(seed);
        let account: [u8; 32] = account_id
            .try_into()
            .map_err(|_| failure(Error::WrongRecipient))?;
        let secret = Zeroizing::new(
            <[u8; 32]>::try_from(seed.as_slice()).map_err(|_| failure(Error::WrongRecipient))?,
        );
        Ok(Self {
            scope: Some(CustodyScope::new(account, chain_identifier, secret).map_err(failure)?),
        })
    }

    pub fn close(&mut self) {
        self.scope.take();
    }

    #[wasm_bindgen(js_name = primaryPublicKey)]
    pub fn primary_public_key(&self) -> Result<Vec<u8>, JsValue> {
        sender::primary_public_key(self.scope.as_ref().ok_or_else(|| failure(Error::Revoked))?)
            .map(|key| key.to_vec())
            .map_err(failure)
    }

    #[wasm_bindgen(js_name = deriveDestination)]
    pub fn derive_destination(&self, intent: &str) -> Result<String, JsValue> {
        let intent = serde_json::from_str::<sender::Intent>(intent)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let destination = sender::derive(
            self.scope.as_ref().ok_or_else(|| failure(Error::Revoked))?,
            &intent,
        )
        .map_err(failure)?;
        serde_json::to_string(&destination).map_err(|_| failure(Error::InvalidMessage))
    }

    #[wasm_bindgen(js_name = signPrimaryTransfer)]
    pub fn sign_primary_transfer(
        &self,
        descriptor: &str,
        spend: &str,
        authorization: &str,
    ) -> Result<String, JsValue> {
        let scope = self.scope.as_ref().ok_or_else(|| failure(Error::Revoked))?;
        let descriptor = serde_json::from_str::<transfer::WireDescriptor>(descriptor)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let spend = serde_json::from_str::<transfer::Spend>(spend)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let authorization = serde_json::from_str::<sender::Authorization>(authorization)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let (signed, message) =
            sender::sign(scope, &descriptor, &spend, &authorization).map_err(failure)?;
        Ok(serde_json::json!({ "accountId": signed.account_id.as_slice(), "publicKey": signed.public_key.as_slice(),
            "signature": signed.signature.as_slice(), "message": message }).to_string())
    }

    #[wasm_bindgen(js_name = signReceivedTransfer)]
    pub fn sign_received_transfer(
        &self,
        received: &str,
        descriptor: &str,
        spend: &str,
        authorization: &str,
    ) -> Result<String, JsValue> {
        let scope = self.scope.as_ref().ok_or_else(|| failure(Error::Revoked))?;
        let received = serde_json::from_str::<sender::ReceivedSource>(received)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let descriptor = serde_json::from_str::<transfer::WireDescriptor>(descriptor)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let spend = serde_json::from_str::<transfer::Spend>(spend)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let authorization = serde_json::from_str::<sender::Authorization>(authorization)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let (signed, message) =
            sender::sign_received(scope, &received, &descriptor, &spend, &authorization)
                .map_err(failure)?;
        Ok(serde_json::json!({ "accountId": signed.account_id.as_slice(), "publicKey": signed.public_key.as_slice(),
            "signature": signed.signature.as_slice(), "message": message }).to_string())
    }

    #[wasm_bindgen(js_name = validateReceivedDescriptor)]
    pub fn validate_received_descriptor(&self, received: &str) -> Result<Vec<u8>, JsValue> {
        let scope = self.scope.as_ref().ok_or_else(|| failure(Error::Revoked))?;
        let received = serde_json::from_str::<sender::ReceivedSource>(received)
            .map_err(|_| failure(Error::InvalidMessage))?;
        let original = received.descriptor.descriptor().map_err(failure)?;
        // Reconstruct and immediately drop the capability; this performs no signature.
        scope
            .prepare(&original, received.public_key, &[])
            .map_err(failure)?;
        Ok(received.public_key.to_vec())
    }
}
