//! Experimental deterministic sender derivation. See sender-contract.md before changing bytes.
use super::*;
use serde::{Deserialize, Serialize};
use transfer::{Spend, WireAsset, WireDescriptor};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Intent {
    chain_identifier: String,
    asset: WireAsset,
    recipient: [u8; 32],
    operation_id: [u8; 32],
    member_index: u32,
    message_context: [u8; 32],
    recipient_amount: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Destination {
    pub descriptor: WireDescriptor,
    pub public_key: [u8; 32],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReceivedSource {
    pub descriptor: WireDescriptor,
    pub public_key: [u8; 32],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Authorization {
    fee_lamports: String,
    max_fee_lamports: String,
    rent_lamports: String,
    max_rent_lamports: String,
    max_native_debit_lamports: String,
    create_destination_ata: bool,
}

fn unsigned(value: &str) -> Result<u64, Error> {
    let n = value.parse::<u64>().map_err(|_| Error::InvalidAmount)?;
    if n.to_string() != value {
        return Err(Error::InvalidAmount);
    }
    Ok(n)
}

impl Authorization {
    fn validate(&self, asset: &WireAsset, value: u64) -> Result<Vec<u8>, Error> {
        let fee = unsigned(&self.fee_lamports)?;
        let max_fee = unsigned(&self.max_fee_lamports)?;
        let rent = unsigned(&self.rent_lamports)?;
        let max_rent = unsigned(&self.max_rent_lamports)?;
        let max_debit = unsigned(&self.max_native_debit_lamports)?;
        if fee > max_fee
            || rent > max_rent
            || (self.create_destination_ata && (matches!(asset, WireAsset::Native {}) || rent == 0))
            || (!self.create_destination_ata && rent != 0)
        {
            return Err(Error::InvalidAmount);
        }
        let native = if matches!(asset, WireAsset::Native {}) {
            value
        } else {
            0
        };
        // Reserve the fee ceiling, rather than assuming the quoted fee exhausts authorization.
        let debit = native
            .checked_add(max_fee)
            .and_then(|n| {
                n.checked_add(if self.create_destination_ata {
                    max_rent
                } else {
                    0
                })
            })
            .ok_or(Error::InvalidAmount)?;
        if debit > max_debit {
            return Err(Error::InvalidAmount);
        }
        let mut out = vec![0x86];
        for n in [fee, max_fee, rent, max_rent, max_debit] {
            head(&mut out, 0, n);
        }
        out.push(if self.create_destination_ata {
            0xf5
        } else {
            0xf4
        });
        Ok(out)
    }
}

fn expanded(scope: &CustodyScope) -> Result<Zeroizing<[u8; 64]>, Error> {
    if !scope.active.load(Ordering::SeqCst) {
        return Err(Error::Revoked);
    }
    Ok(Zeroizing::new(Sha512::digest(&scope.seed[..]).into()))
}

pub(super) fn primary_public_key(scope: &CustodyScope) -> Result<[u8; 32], Error> {
    let h = expanded(scope)?;
    let secret = ExpandedSecretKey::from_bytes(&h);
    let key = (ED25519_BASEPOINT_POINT * secret.scalar)
        .compress()
        .to_bytes();
    point(&key)?;
    Ok(key)
}

fn candidate(raw: [u8; 32]) -> Option<Scalar> {
    Option::<Scalar>::from(Scalar::from_canonical_bytes(raw)).filter(|r| *r != Scalar::ZERO)
}

impl Intent {
    fn from_descriptor(d: &WireDescriptor) -> Self {
        Self {
            chain_identifier: d.chain_identifier.clone(),
            asset: d.asset.clone(),
            recipient: d.recipient,
            operation_id: d.operation_id,
            member_index: d.member_index,
            message_context: d.message_context,
            recipient_amount: d.recipient_amount.clone(),
        }
    }
    fn descriptor(&self, ephemeral: [u8; 32]) -> WireDescriptor {
        WireDescriptor {
            chain_identifier: self.chain_identifier.clone(),
            asset: self.asset.clone(),
            recipient: self.recipient,
            ephemeral,
            operation_id: self.operation_id,
            member_index: self.member_index,
            message_context: self.message_context,
            recipient_amount: self.recipient_amount.clone(),
        }
    }
}

pub(super) fn derive(scope: &CustodyScope, intent: &Intent) -> Result<Destination, Error> {
    if intent.chain_identifier != scope.chain_identifier {
        return Err(Error::InvalidChain);
    }
    if let WireAsset::Spl { token_program, .. } = &intent.asset {
        if *token_program != transfer::plain_token_program() {
            return Err(Error::InvalidMessage);
        }
    }
    let recipient = point(&intent.recipient)?;
    let template = intent.descriptor([0; 32]).descriptor()?;
    // J is Q with only the R field omitted. The remaining encodings are identical.
    let mut j = vec![0x88];
    text(&mut j, SCHEME);
    text(&mut j, &template.chain_identifier);
    match &template.asset {
        Asset::Native => j.extend_from_slice(&[0x81, 0]),
        Asset::Spl {
            mint,
            token_program,
        } => {
            j.extend_from_slice(&[0x83, 1]);
            bytes(&mut j, mint);
            bytes(&mut j, token_program);
        }
    }
    bytes(&mut j, &template.recipient);
    bytes(&mut j, &template.operation_id);
    head(&mut j, 0, template.member_index as u64);
    bytes(&mut j, &template.message_context);
    head(&mut j, 0, template.recipient_amount);
    let h = expanded(scope)?;
    for counter in 0..4096u32 {
        let mut nonce_input = vec![0x83];
        text(&mut nonce_input, "frank:solana-stealth:sender-ephemeral:v1");
        bytes(&mut nonce_input, &j);
        head(&mut nonce_input, 0, counter as u64);
        let mut mac =
            Hmac::<Sha512>::new_from_slice(&h[32..]).map_err(|_| Error::SignatureFailure)?;
        mac.update(&nonce_input);
        let mut digest = mac.finalize().into_bytes();
        let mut raw = Zeroizing::new([0u8; 32]);
        raw.copy_from_slice(&digest[..32]);
        digest.zeroize();
        let Some(r) = candidate(*raw) else {
            continue;
        };
        let r = Zeroizing::new(r);
        let ephemeral = (ED25519_BASEPOINT_POINT * *r).compress().to_bytes();
        let wire = intent.descriptor(ephemeral);
        let d = wire.descriptor()?;
        let shared = Zeroizing::new(recipient * *r);
        let mut input = Zeroizing::new(vec![0x83]);
        text(&mut input, "frank:solana-stealth:tweak:v1");
        bytes(&mut input, &transcript(&d));
        bytes(&mut input, shared.compress().as_bytes());
        let hash = Zeroizing::new(<[u8; 64]>::from(Sha512::digest(&*input)));
        let t = Zeroizing::new(Scalar::from_bytes_mod_order_wide(&hash));
        let destination = recipient + ED25519_BASEPOINT_POINT * *t;
        if *t == Scalar::ZERO || destination.is_identity() {
            continue;
        }
        if !scope.active.load(Ordering::SeqCst) {
            return Err(Error::Revoked);
        }
        let public_key = destination.compress().to_bytes();
        point(&public_key)?;
        return Ok(Destination {
            descriptor: wire,
            public_key,
        });
    }
    Err(Error::InvalidDestination)
}

fn authorized_message(
    scope: &CustodyScope,
    descriptor: &WireDescriptor,
    spend: &Spend,
    authorization: &Authorization,
    received: Option<&ReceivedSource>,
) -> Result<Vec<u8>, Error> {
    let value = transfer::amount(&spend.amount)?;
    let mut auth = authorization.validate(&spend.asset, value)?;
    if let Some(source) = received {
        if source.descriptor.chain_identifier != descriptor.chain_identifier
            || source.public_key != spend.owner
        {
            return Err(Error::WrongRecipient);
        }
        let original = source.descriptor.descriptor()?;
        let mut binding = vec![0x84];
        text(&mut binding, "frank:solana-custody-received:v1");
        bytes(&mut binding, &transcript(&original));
        bytes(&mut binding, &source.public_key);
        bytes(&mut binding, &auth);
        auth = binding;
    }
    if descriptor.chain_identifier != spend.chain_identifier
        || descriptor.asset != spend.asset
        || descriptor.recipient_amount != spend.amount
        || descriptor.operation_id != spend.operation_id
        || descriptor.message_context != spend.message_context
    {
        return Err(Error::InvalidMessage);
    }
    let destination = derive(scope, &Intent::from_descriptor(descriptor))?;
    if destination.descriptor.ephemeral != descriptor.ephemeral
        || destination.public_key != spend.destination
    {
        return Err(Error::InvalidDestination);
    }
    transfer::primary_message(
        &descriptor.descriptor()?,
        spend,
        &auth,
        authorization.create_destination_ata,
    )
}

pub(super) fn sign_received(
    scope: &CustodyScope,
    received: &ReceivedSource,
    descriptor: &WireDescriptor,
    spend: &Spend,
    authorization: &Authorization,
) -> Result<(SignedMessage, Vec<u8>), Error> {
    let message = authorized_message(scope, descriptor, spend, authorization, Some(received))?;
    let original = received.descriptor.descriptor()?;
    let signed = scope
        .prepare(&original, received.public_key, &message)?
        .sign()?;
    Ok((signed, message))
}

pub(super) fn sign(
    scope: &CustodyScope,
    descriptor: &WireDescriptor,
    spend: &Spend,
    authorization: &Authorization,
) -> Result<(SignedMessage, Vec<u8>), Error> {
    let message = authorized_message(scope, descriptor, spend, authorization, None)?;
    let public_key = primary_public_key(scope)?;
    if public_key != spend.owner {
        return Err(Error::WrongRecipient);
    }
    let h = expanded(scope)?;
    let secret = ExpandedSecretKey::from_bytes(&h);
    let key = VerifyingKey::from_bytes(&public_key).map_err(|_| Error::InvalidPoint)?;
    let signature = raw_sign::<Sha512>(&secret, &message, &key);
    key.verify_strict(&message, &signature)
        .map_err(|_| Error::SignatureFailure)?;
    if !scope.active.load(Ordering::SeqCst) {
        return Err(Error::Revoked);
    }
    Ok((
        SignedMessage {
            account_id: scope.account_id,
            public_key,
            signature: signature.to_bytes(),
        },
        message,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_ata_rent_and_fee_ceiling_fit_full_native_budget() {
        let spl = WireAsset::Spl {
            mint: [17; 32],
            token_program: transfer::plain_token_program(),
        };
        let mut a = Authorization {
            fee_lamports: "5000".into(),
            max_fee_lamports: "6000".into(),
            rent_lamports: "2039280".into(),
            max_rent_lamports: "2040000".into(),
            max_native_debit_lamports: "2046000".into(),
            create_destination_ata: true,
        };
        assert!(a.validate(&spl, 42).is_ok());
        assert!(a.validate(&WireAsset::Native {}, 42).is_err());
        a.max_native_debit_lamports = "2044280".into(); // quoted cost fits, approved ceilings do not.
        assert!(a.validate(&spl, 42).is_err());
        a.max_native_debit_lamports = "2046000".into();
        a.rent_lamports = "2040001".into();
        assert!(a.validate(&spl, 42).is_err());
        a.rent_lamports = "0".into();
        assert!(a.validate(&spl, 42).is_err());
        a.rent_lamports = "2039280".into();
        a.create_destination_ata = false;
        assert!(a.validate(&spl, 42).is_err());
        a.rent_lamports = "0".into();
        a.max_fee_lamports = u64::MAX.to_string();
        a.max_native_debit_lamports = u64::MAX.to_string();
        assert!(a.validate(&WireAsset::Native {}, 1).is_err());
    }
    fn intent_json(v: &serde_json::Value) -> serde_json::Value {
        let mut i = v["intent"].clone();
        i["asset"] = if i["asset"][0] == 0 {
            serde_json::json!({"kind":"native"})
        } else {
            serde_json::json!({"kind":"spl","mint":i["asset"][1],"tokenProgram":i["asset"][2]})
        };
        i
    }
    fn from_hex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|n| u8::from_str_radix(&value[n..n + 2], 16).unwrap())
            .collect()
    }
    #[test]
    fn independent_sender_vectors_and_all_intent_bindings() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("sender-vectors.json")).unwrap();
        let scope =
            CustodyScope::new([7; 32], "solana-devnet".into(), Zeroizing::new([99; 32])).unwrap();
        for v in fixtures.as_array().unwrap() {
            let json = intent_json(v);
            let intent = serde_json::from_value::<Intent>(json.clone()).unwrap();
            let d = derive(&scope, &intent).unwrap();
            assert_eq!(
                d.descriptor.ephemeral.as_slice(),
                from_hex(v["R"].as_str().unwrap())
            );
            assert_eq!(d.public_key.as_slice(), from_hex(v["P"].as_str().unwrap()));
            for field in [
                "operationId",
                "messageContext",
                "memberIndex",
                "recipientAmount",
                "recipient",
                "asset",
            ] {
                let mut changed = json.clone();
                match field {
                    "memberIndex" => changed[field] = serde_json::json!(intent.member_index + 1),
                    "recipientAmount" => changed[field] = serde_json::json!("42"),
                    "recipient" => {
                        changed[field] =
                            serde_json::json!(ED25519_BASEPOINT_POINT.compress().to_bytes())
                    }
                    "asset" => {
                        changed[field] = if intent.asset == (WireAsset::Native {}) {
                            serde_json::json!({"kind":"spl","mint":([17u8;32]),"tokenProgram":transfer::plain_token_program()})
                        } else {
                            serde_json::json!({"kind":"native"})
                        }
                    }
                    _ => {
                        changed[field][0] =
                            serde_json::json!(changed[field][0].as_u64().unwrap() ^ 1)
                    }
                }
                let altered = derive(&scope, &serde_json::from_value(changed).unwrap()).unwrap();
                assert_ne!(altered.public_key, d.public_key, "{field}");
                assert_ne!(
                    altered.descriptor.ephemeral, d.descriptor.ephemeral,
                    "{field}"
                );
            }
        }
    }
    #[test]
    fn nonce_candidates_reject_zero_order_and_noncanonical() {
        assert!(candidate([0; 32]).is_none());
        let mut order = Scalar::ZERO.to_bytes();
        order.copy_from_slice(&[
            237, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16,
        ]);
        assert!(candidate(order).is_none());
        assert!(candidate([255; 32]).is_none());
        let mut one = [0; 32];
        one[0] = 1;
        assert_eq!(candidate(one), Some(Scalar::ONE));
    }
}
