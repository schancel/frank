//! Pure encoder and validator helpers for Type 13 relay forwarding delivery envelopes.

use crate::cbor::CborValue;
use crate::error::UsageError;
use crate::frame::{encode_frame, EnvelopeFields, FramePayload};
use crate::hash::forwarding_payload_digest;
use crate::limits::{MAX_FORWARDING_DELIVERY_FRAME_BYTES, MAX_PAYMENT_MEMBERS};
use crate::message_fields as mf;
use crate::message_types::TYPE_FORWARDING_DELIVERY_ENVELOPE;
use crate::model::{
    AccountRef, ParsedFrame, PaymentMember, PaymentValue, StealthMetadata, TypedPayload, ViewTag,
};

fn bad(message: impl Into<String>) -> UsageError {
    UsageError(message.into())
}

/// Canonical input to encode a Type 13 forwarding delivery envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardingDeliveryEnvelope {
    /// Field 1: Destination relay routing identity / stamp key (key type 1).
    pub destination: AccountRef,
    /// Field 2: Serialized inner direct message delivery (Type 10) frame.
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
    if acc.key_type != mf::key_type::SECP256K1 {
        return Err(bad("destination account must be key type 1"));
    }
    if acc.key_bytes.len() != 33 {
        return Err(bad("key type 1 requires 33 key bytes"));
    }
    encode_account_ref(acc)
}

fn encode_account_ref(acc: &AccountRef) -> Result<CborValue, UsageError> {
    let expected = match acc.key_type {
        1 => Some(33),
        2 | 3 => Some(32),
        _ => None,
    };
    if let Some(length) = expected {
        if acc.key_bytes.len() != length {
            return Err(bad(format!(
                "key type {} requires {length} key bytes",
                acc.key_type
            )));
        }
    } else if acc.key_bytes.is_empty() || acc.key_bytes.len() > 128 {
        return Err(bad("key bytes must be 1..128"));
    }
    Ok(CborValue::Map(vec![
        (
            mf::account_ref::KEY_TYPE,
            CborValue::Int(i128::from(acc.key_type)),
        ),
        (
            mf::account_ref::KEY_BYTES,
            CborValue::Bytes(acc.key_bytes.clone()),
        ),
    ]))
}

fn encode_stealth(meta: &StealthMetadata) -> Result<CborValue, UsageError> {
    use mf::stealth_metadata as k;
    let mut entries = vec![(k::EPHEMERAL_PUB_KEY, encode_account_ref(&meta.ephemeral)?)];
    if let Some(tag) = &meta.view_tag {
        let value = match tag {
            ViewTag::Uint(n) => CborValue::Int(i128::from(*n)),
            ViewTag::Bytes(bytes) => {
                if bytes.is_empty() || bytes.len() > 32 {
                    return Err(bad("view tag bytes must be 1..32"));
                }
                CborValue::Bytes(bytes.clone())
            }
        };
        entries.push((k::VIEW_TAG, value));
    }
    Ok(CborValue::Map(entries))
}

fn is_network_tag(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    first_ok
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn encode_payment_member(p: &PaymentMember) -> Result<CborValue, UsageError> {
    use mf::payment_member as k;
    let stamp = p.child_index.is_some();
    if stamp == p.stealth.is_some() {
        return Err(bad(format!(
            "payment member requires exactly one of field {} or field {}",
            k::CHILD_INDEX,
            k::STEALTH_METADATA
        )));
    }
    if stamp && p.commitment.is_none() {
        return Err(bad("stamp payment requires a T4 commitment"));
    }
    if p.token.is_some() && p.stealth.is_none() {
        return Err(bad("token identifier is allowed only on a stealth payment"));
    }
    if !is_network_tag(&p.network) {
        return Err(bad("network tag does not match S1"));
    }
    if p.transaction_id.is_empty() || p.transaction_id.len() > 128 {
        return Err(bad("transaction id must be 1..128 bytes"));
    }
    if p.address.is_empty() || p.address.len() > 128 {
        return Err(bad("address must be 1..128 bytes"));
    }
    if let PaymentValue::Quantity(bytes) = &p.value {
        if bytes.len() != 32 {
            return Err(bad("quantity must be 32 bytes"));
        }
    }
    let mut entries = vec![
        (k::NETWORK, CborValue::Text(p.network.clone())),
        (
            k::TRANSACTION_ID,
            CborValue::Bytes(p.transaction_id.clone()),
        ),
        (
            k::VALUE,
            match &p.value {
                PaymentValue::Quantity(bytes) => CborValue::Bytes(bytes.clone()),
                PaymentValue::Satoshis(amount) => CborValue::Int(i128::from(*amount)),
            },
        ),
        (k::ADDRESS, CborValue::Bytes(p.address.clone())),
    ];
    if let Some(commitment) = &p.commitment {
        if commitment.len() != 32 {
            return Err(bad("commitment must be 32 bytes"));
        }
        entries.push((k::COMMITMENT, CborValue::Bytes(commitment.clone())));
    }
    if let Some(vout) = p.vout {
        entries.push((k::VOUT, CborValue::Int(i128::from(vout))));
    }
    if let Some(raw) = &p.raw_tx {
        if raw.is_empty() || raw.len() > 16384 {
            return Err(bad("raw transaction must be 1..16384 bytes"));
        }
        entries.push((k::RAW_TX, CborValue::Bytes(raw.clone())));
    }
    if let Some(index) = p.child_index {
        if index > 2_147_483_647 {
            return Err(bad("child index must be in 0..2147483647"));
        }
        entries.push((k::CHILD_INDEX, CborValue::Int(i128::from(index))));
    }
    if let Some(meta) = &p.stealth {
        entries.push((k::STEALTH_METADATA, encode_stealth(meta)?));
    }
    if let Some(token) = &p.token {
        if token.is_empty() || token.len() > 128 {
            return Err(bad("token identifier must be 1..128 bytes"));
        }
        entries.push((k::TOKEN, CborValue::Bytes(token.clone())));
    }
    Ok(CborValue::Map(entries))
}

/// Encodes a canonical Type 13 forwarding delivery envelope frame.
pub fn encode_forwarding_delivery(
    envelope: &ForwardingDeliveryEnvelope,
) -> Result<Vec<u8>, UsageError> {
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
        None => forwarding_payload_digest(&envelope.payload_frame)?.to_vec(),
    };

    let mut payments = Vec::with_capacity(envelope.payments.len());
    for payment in &envelope.payments {
        payments.push(encode_payment_member(payment)?);
    }
    let mut map_entries = vec![
        (
            mf::forwarding_delivery_envelope::DESTINATION,
            encode_account(&envelope.destination)?,
        ),
        (
            mf::forwarding_delivery_envelope::PAYLOAD_FRAME,
            CborValue::Bytes(envelope.payload_frame.clone()),
        ),
        (
            mf::forwarding_delivery_envelope::PAYLOAD_DIGEST,
            CborValue::Bytes(digest),
        ),
        (
            mf::forwarding_delivery_envelope::PAYMENTS,
            CborValue::Array(payments),
        ),
    ];

    if let Some(endpoint) = &envelope.endpoint {
        if endpoint.is_empty() || endpoint.len() > 256 {
            return Err(bad("endpoint must be 1..256 characters"));
        }
        map_entries.push((
            mf::forwarding_delivery_envelope::ENDPOINT,
            CborValue::Text(endpoint.clone()),
        ));
    }

    if let Some(expires_at) = envelope.expires_at {
        if expires_at > u32::MAX as u64 {
            return Err(bad("expires_at must fit in u32"));
        }
        map_entries.push((
            mf::forwarding_delivery_envelope::EXPIRES_AT,
            CborValue::Int(i128::from(expires_at)),
        ));
    }

    for (k, v) in &envelope.unknown {
        map_entries.push((*k, v.clone()));
    }

    // Canonical CBOR requires map keys to be sorted.
    map_entries.sort_by_key(|(k, _)| *k);

    let payload_val = CborValue::Map(map_entries);
    let frame = encode_frame(
        EnvelopeFields {
            type_id: TYPE_FORWARDING_DELIVERY_ENVELOPE,
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

/// Returns true if the parsed frame is a Type 13 forwarding envelope.
pub fn is_forwarding_delivery_frame(frame: &ParsedFrame) -> bool {
    frame.type_id == TYPE_FORWARDING_DELIVERY_ENVELOPE
        && matches!(
            frame.typed.as_deref(),
            Some(TypedPayload::ForwardingDelivery { .. })
        )
}
