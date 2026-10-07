//! Pure encoder and validator helpers for Type 25 relay forwarding delivery envelopes.

use crate::cbor::CborValue;
use crate::error::UsageError;
use crate::frame::{encode_frame, EnvelopeFields, FramePayload};
use crate::hash::forwarding_payload_digest;
use crate::limits::{
    MAX_FORWARDING_DELIVERY_FRAME_BYTES, MAX_PAYMENT_MEMBERS, TYPE_FORWARDING_DELIVERY,
};
use crate::model::{AccountRef, ParsedFrame, PaymentMember, PaymentValue, TypedPayload};

fn bad(message: impl Into<String>) -> UsageError {
    UsageError(message.into())
}

/// Canonical input to encode a Type 25 forwarding delivery envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardingDeliveryEnvelope {
    /// Field 0: Destination relay network.
    pub network: String,
    /// Field 1: Destination relay routing identity / stamp key (key type 1).
    pub destination: AccountRef,
    /// Field 2: Serialized inner direct message delivery (Type 1) frame.
    pub payload_frame: Vec<u8>,
    /// Field 3: Forwarding payload digest of field 2 (computed if None).
    pub payload_digest: Option<Vec<u8>>,
    /// Field 4: Storage payment stamps compensating the destination relay.
    pub payments: Vec<PaymentMember>,
    /// Field 5: Optional destination relay endpoint URI.
    pub endpoint: Option<String>,
    /// Field 6: Optional delivery TTL / expiration timestamp (seconds).
    pub expires_at: Option<u64>,
    /// Unknown additive fields.
    pub unknown: Vec<(u64, CborValue)>,
}

fn encode_account(acc: &AccountRef) -> Result<CborValue, UsageError> {
    if acc.key_type != 1 {
        return Err(bad("destination account must be key type 1"));
    }
    if acc.key_bytes.len() != 33 {
        return Err(bad("key type 1 requires 33 key bytes"));
    }
    Ok(CborValue::Map(vec![
        (0, CborValue::Int(i128::from(acc.key_type))),
        (1, CborValue::Bytes(acc.key_bytes.clone())),
    ]))
}

fn encode_payment_member(p: &PaymentMember) -> CborValue {
    let mut entries = vec![
        (0, CborValue::Int(i128::from(p.child_index))),
        (1, CborValue::Bytes(p.transaction_id.clone())),
        (
            2,
            match &p.value {
                PaymentValue::Quantity(b) => CborValue::Bytes(b.clone()),
                PaymentValue::Satoshis(s) => CborValue::Int(i128::from(*s)),
            },
        ),
        (3, CborValue::Bytes(p.address.clone())),
        (4, CborValue::Bytes(p.commitment.clone())),
    ];
    if let Some(vout) = p.vout {
        entries.push((5, CborValue::Int(i128::from(vout))));
    }
    if let Some(ref raw) = p.raw_tx {
        entries.push((6, CborValue::Bytes(raw.clone())));
    }
    CborValue::Map(entries)
}

/// Encodes a canonical Type 25 forwarding delivery envelope frame.
pub fn encode_forwarding_delivery(
    envelope: &ForwardingDeliveryEnvelope,
) -> Result<Vec<u8>, UsageError> {
    if envelope.network.is_empty() || envelope.network.len() > 64 {
        return Err(bad("network must be 1..64 characters"));
    }
    if envelope.payload_frame.len() < 9 {
        return Err(bad("payload_frame must be at least 9 bytes"));
    }
    if envelope.payments.is_empty() || envelope.payments.len() > MAX_PAYMENT_MEMBERS {
        return Err(bad("payments must contain 1..64 members"));
    }

    let digest = match &envelope.payload_digest {
        Some(d) => {
            if d.len() != 32 {
                return Err(bad("payload_digest must be 32 bytes"));
            }
            d.clone()
        }
        None => {
            let computed = forwarding_payload_digest(&envelope.network, &envelope.payload_frame)?;
            computed.to_vec()
        }
    };

    let mut map_entries = vec![
        (0, CborValue::Text(envelope.network.clone())),
        (1, encode_account(&envelope.destination)?),
        (2, CborValue::Bytes(envelope.payload_frame.clone())),
        (3, CborValue::Bytes(digest)),
        (
            4,
            CborValue::Array(
                envelope
                    .payments
                    .iter()
                    .map(encode_payment_member)
                    .collect(),
            ),
        ),
    ];

    if let Some(endpoint) = &envelope.endpoint {
        if endpoint.is_empty() || endpoint.len() > 256 {
            return Err(bad("endpoint must be 1..256 characters"));
        }
        map_entries.push((5, CborValue::Text(endpoint.clone())));
    }

    if let Some(expires_at) = envelope.expires_at {
        if expires_at > u32::MAX as u64 {
            return Err(bad("expires_at must fit in u32"));
        }
        map_entries.push((6, CborValue::Int(i128::from(expires_at))));
    }

    for (k, v) in &envelope.unknown {
        map_entries.push((*k, v.clone()));
    }

    // Canonical CBOR requires map keys to be sorted.
    map_entries.sort_by_key(|(k, _)| *k);

    let payload_val = CborValue::Map(map_entries);
    let frame = encode_frame(
        EnvelopeFields {
            type_id: TYPE_FORWARDING_DELIVERY,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&payload_val),
    )?;

    if frame.len() > MAX_FORWARDING_DELIVERY_FRAME_BYTES {
        return Err(bad("frame exceeds MAX_FORWARDING_DELIVERY_FRAME_BYTES"));
    }

    Ok(frame)
}

/// Returns true if the parsed frame is a Type 25 forwarding envelope.
pub fn is_forwarding_delivery_frame(frame: &ParsedFrame) -> bool {
    frame.type_id == TYPE_FORWARDING_DELIVERY
        && matches!(
            frame.typed.as_deref(),
            Some(TypedPayload::ForwardingDelivery { .. })
        )
}
