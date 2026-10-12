//! Public fixed construction only. Never proves private derivation or grants signing authority.
use super::*;
use sender::{Authorization, ReceivedSource};
use serde::Deserialize;
use transfer::{Spend, WireAsset, WireDescriptor};

pub(super) const FEE_PROBE_DOMAIN: &str = "frank:solana-custody-fee-probe:v1";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Source {
    Primary {},
    Received { received: ReceivedSource },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TransferRequest {
    descriptor: WireDescriptor,
    spend: Spend,
    authorization: Authorization,
    source: Source,
}

impl TransferRequest {
    pub(super) fn message(&self) -> Result<Vec<u8>, Error> {
        authorized_message(
            &self.descriptor,
            &self.spend,
            &self.authorization,
            match &self.source {
                Source::Primary {} => None,
                Source::Received { received } => Some(received),
            },
        )
    }
}

/// Public tuple and authorization binding shared with the private signer. Only the
/// private signer recomputes R/P and proves primary/received key ownership.
pub(super) fn authorized_message(
    descriptor: &WireDescriptor,
    spend: &Spend,
    authorization: &Authorization,
    received: Option<&ReceivedSource>,
) -> Result<Vec<u8>, Error> {
    if !valid_chain(&descriptor.chain_identifier)
        || descriptor.chain_identifier != spend.chain_identifier
    {
        return Err(Error::InvalidChain);
    }
    if descriptor.asset != spend.asset
        || descriptor.recipient_amount != spend.amount
        || descriptor.operation_id != spend.operation_id
        || descriptor.message_context != spend.message_context
    {
        return Err(Error::InvalidMessage);
    }
    let d = descriptor.descriptor()?;
    for value in [&d.recipient, &d.ephemeral, &spend.owner, &spend.destination] {
        point(value)?;
    }
    let mut auth = authorization.validate(&spend.asset, transfer::amount(&spend.amount)?)?;
    if let Some(source) = received {
        if source.descriptor.chain_identifier != descriptor.chain_identifier
            || source.public_key != spend.owner
        {
            return Err(Error::WrongRecipient);
        }
        let original = source.descriptor.descriptor()?;
        point(&original.recipient)?;
        point(&original.ephemeral)?;
        point(&source.public_key)?;
        let mut binding = vec![0x84];
        text(&mut binding, "frank:solana-custody-received:v1");
        bytes(&mut binding, &transcript(&original));
        bytes(&mut binding, &source.public_key);
        bytes(&mut binding, &auth);
        auth = binding;
    }
    transfer::primary_message(&d, spend, &auth, authorization.create_destination_ata)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FeeProbeRequest {
    domain: String,
    chain_identifier: String,
    asset: WireAsset,
    owner: [u8; 32],
    destination: [u8; 32],
    amount: String,
    recent_blockhash: [u8; 32],
    decimals: Option<u8>,
    create_destination_ata: bool,
}

impl FeeProbeRequest {
    pub(super) fn message(&self) -> Result<Vec<u8>, Error> {
        if self.domain != FEE_PROBE_DOMAIN {
            return Err(Error::InvalidMessage);
        }
        if !valid_chain(&self.chain_identifier) {
            return Err(Error::InvalidChain);
        }
        point(&self.owner)?;
        point(&self.destination)?;
        // These fixed public placeholders have no derivation/authorization meaning.
        let descriptor = WireDescriptor {
            chain_identifier: self.chain_identifier.clone(),
            asset: self.asset.clone(),
            recipient: self.destination,
            ephemeral: self.owner,
            operation_id: [0; 32],
            member_index: 0,
            message_context: [1; 32],
            recipient_amount: self.amount.clone(),
        };
        let spend = Spend {
            chain_identifier: self.chain_identifier.clone(),
            asset: self.asset.clone(),
            owner: self.owner,
            destination: self.destination,
            amount: self.amount.clone(),
            recent_blockhash: self.recent_blockhash,
            operation_id: descriptor.operation_id,
            message_context: descriptor.message_context,
            decimals: self.decimals,
        };
        transfer::fee_probe_message(
            &descriptor.descriptor()?,
            &spend,
            self.create_destination_ata,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn scope(seed: [u8; 32]) -> CustodyScope {
        CustodyScope::new([7; 32], "solana-devnet".into(), Zeroizing::new(seed)).unwrap()
    }
    fn request(owner: &CustodyScope, intent: Value, source: Value) -> TransferRequest {
        let intent: sender::Intent = serde_json::from_value(intent).unwrap();
        let destination = sender::derive(owner, &intent).unwrap();
        let d = &destination.descriptor;
        let create = matches!(d.asset, WireAsset::Spl { .. });
        let source_owner = if source["kind"] == "received" {
            source["received"]["publicKey"].clone()
        } else {
            json!(sender::primary_public_key(owner).unwrap())
        };
        serde_json::from_value(json!({
            "descriptor": d,
            "spend": {"chainIdentifier": d.chain_identifier, "asset":d.asset,
                "owner":source_owner, "destination":destination.public_key,
                "amount":d.recipient_amount, "recentBlockhash":([85;32]),
                "operationId":d.operation_id,"messageContext":d.message_context,
                "decimals":if create {json!(6)} else {Value::Null}},
            "authorization":{"feeLamports":if create {"5000"} else {"0"},"maxFeeLamports":if create {"6000"} else {"0"},
                "rentLamports":if create {"2039280"} else {"0"},
                "maxRentLamports":if create {"2040000"} else {"0"},
                "maxNativeDebitLamports":if create {"2046000".to_owned()} else {d.recipient_amount.clone()},
                "createDestinationAta":create},
            "source": source
        })).unwrap()
    }
    fn sender_intent(row: &Value) -> Value {
        let mut intent = row["intent"].clone();
        let a = intent["asset"].clone();
        intent["asset"] = if a[0] == 0 {
            json!({"kind":"native"})
        } else {
            json!({"kind":"spl","mint":a[1],"tokenProgram":a[2]})
        };
        intent
    }
    #[test]
    fn public_messages_equal_private_primary_native_spl_and_ata_messages() {
        let owner = scope([99; 32]);
        let fixtures: Value = serde_json::from_str(include_str!("sender-vectors.json")).unwrap();
        for row in fixtures.as_array().unwrap() {
            let mut req = request(&owner, sender_intent(row), json!({"kind":"primary"}));
            assert_eq!(
                req.message().unwrap(),
                sender::sign(&owner, &req.descriptor, &req.spend, &req.authorization)
                    .unwrap()
                    .1
            );
            if matches!(req.spend.asset, WireAsset::Spl { .. }) {
                req.authorization.create_destination_ata = false;
                // Authorization without ATA creation is still exactly the old fixed builder.
                req.authorization = serde_json::from_value(json!({"feeLamports":"5000","maxFeeLamports":"6000","rentLamports":"0","maxRentLamports":"0","maxNativeDebitLamports":"6000","createDestinationAta":false})).unwrap();
                assert_eq!(
                    req.message().unwrap(),
                    sender::sign(&owner, &req.descriptor, &req.spend, &req.authorization)
                        .unwrap()
                        .1
                );
            }
        }
    }
    #[test]
    fn public_received_wrapper_matches_private_source_proof_and_preserves_cross_asset_spends() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../solana-stealth-vectors/vectors.json")).unwrap();
        for row in fixtures["vectors"].as_array().unwrap() {
            let raw = |field: &str| -> Vec<u8> {
                (0..row[field].as_str().unwrap().len())
                    .step_by(2)
                    .map(|i| {
                        u8::from_str_radix(&row[field].as_str().unwrap()[i..i + 2], 16).unwrap()
                    })
                    .collect()
            };
            let seed: [u8; 32] = raw("seed").try_into().unwrap();
            let owner = scope(seed);
            let old_asset = &row["asset"];
            let asset = if old_asset[0] == 0 {
                json!({"kind":"native"})
            } else {
                json!({"kind":"spl","mint":raw_asset(&old_asset[1]),"tokenProgram":raw_asset(&old_asset[2])})
            };
            let received = json!({"descriptor":{"chainIdentifier":"solana-devnet","asset":asset,"recipient":raw("B"),"ephemeral":raw("R"),"operationId":raw("operationId"),"memberIndex":row["memberIndex"],"messageContext":raw("messageContext"),"recipientAmount":row["amount"]},"publicKey":raw("P")});
            let next_asset = if old_asset[0] == 0 {
                json!({"kind":"spl","mint":([17;32]),"tokenProgram":transfer::plain_token_program()})
            } else {
                json!({"kind":"native"})
            };
            let req = request(
                &owner,
                json!({"chainIdentifier":"solana-devnet","asset":next_asset,"recipient":raw("B"),"operationId":([90;32]),"memberIndex":1,"messageContext":([91;32]),"recipientAmount":"42"}),
                json!({"kind":"received","received":received}),
            );
            let Source::Received { received } = &req.source else {
                panic!()
            };
            assert_eq!(
                req.message().unwrap(),
                sender::sign_received(
                    &owner,
                    received,
                    &req.descriptor,
                    &req.spend,
                    &req.authorization
                )
                .unwrap()
                .1
            );
        }
    }
    fn raw_asset(value: &Value) -> Vec<u8> {
        let h = value.as_str().unwrap();
        (0..h.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
            .collect()
    }
    #[test]
    fn public_construction_never_attests_private_derivation_or_authorizes_a_signer() {
        let owner = scope([99; 32]);
        let fixtures: Value = serde_json::from_str(include_str!("sender-vectors.json")).unwrap();
        let mut req = request(
            &owner,
            sender_intent(&fixtures[0]),
            json!({"kind":"primary"}),
        );
        req.descriptor.ephemeral = ED25519_BASEPOINT_POINT.compress().to_bytes();
        assert!(req.message().is_ok());
        assert!(sender::sign(&owner, &req.descriptor, &req.spend, &req.authorization).is_err());
        req.spend.amount = "43".into();
        assert!(req.message().is_err());
    }
    #[test]
    fn fee_probe_is_closed_explicitly_estimation_only_and_checks_public_policy() {
        let owner = scope([99; 32]);
        let fixtures: Value = serde_json::from_str(include_str!("sender-vectors.json")).unwrap();
        for row in fixtures.as_array().unwrap() {
            let req = request(&owner, sender_intent(row), json!({"kind":"primary"}));
            let input = json!({"domain":FEE_PROBE_DOMAIN,"chainIdentifier":req.spend.chain_identifier,"asset":req.spend.asset,"owner":req.spend.owner,"destination":req.spend.destination,"amount":req.spend.amount,"recentBlockhash":req.spend.recent_blockhash,"decimals":req.spend.decimals,"createDestinationAta":req.authorization.create_destination_ata});
            let probe = serde_json::from_value::<FeeProbeRequest>(input.clone())
                .unwrap()
                .message()
                .unwrap();
            let actual = req.message().unwrap();
            assert_ne!(probe, actual);
            assert_eq!(probe.len(), actual.len()); // Message size equivalence is not a fee claim.
            assert!(probe
                .windows(b"frank:solana-custody-feeonly:experimental-v1:".len())
                .any(|w| w == b"frank:solana-custody-feeonly:experimental-v1:"));
            for (field, value) in [
                ("domain", json!("authorization")),
                ("chainIdentifier", json!("solana")),
                ("owner", json!(([0; 32]))),
                ("destination", json!(([0; 32]))),
                ("amount", json!("01")),
            ] {
                let mut changed = input.clone();
                changed[field] = value;
                assert!(serde_json::from_value::<FeeProbeRequest>(changed)
                    .unwrap()
                    .message()
                    .is_err());
            }
            let mut arbitrary = input;
            arbitrary["instructions"] = json!([]);
            assert!(serde_json::from_value::<FeeProbeRequest>(arbitrary).is_err());
        }
    }
}
