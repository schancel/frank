//! Closed experimental transfer builder; no arbitrary message/instruction signing API.
use super::*;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

#[derive(Deserialize, Serialize, PartialEq, Eq, Clone)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum WireAsset {
    Native {},
    Spl {
        mint: [u8; 32],
        #[serde(rename = "tokenProgram")]
        token_program: [u8; 32],
    },
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WireDescriptor {
    pub chain_identifier: String,
    pub asset: WireAsset,
    pub recipient: [u8; 32],
    pub ephemeral: [u8; 32],
    pub operation_id: [u8; 32],
    pub member_index: u32,
    pub message_context: [u8; 32],
    pub recipient_amount: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Spend {
    pub chain_identifier: String,
    pub asset: WireAsset,
    pub owner: [u8; 32],
    pub destination: [u8; 32],
    pub amount: String,
    pub recent_blockhash: [u8; 32],
    pub operation_id: [u8; 32],
    pub message_context: [u8; 32],
    pub decimals: Option<u8>,
}

pub(super) fn amount(value: &str) -> Result<u64, Error> {
    let n = value.parse::<u64>().map_err(|_| Error::InvalidAmount)?;
    if n == 0 || n.to_string() != value {
        return Err(Error::InvalidAmount);
    }
    Ok(n)
}
fn constant(hex: &str) -> [u8; 32] {
    let mut out = [0; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("reviewed public constant");
    }
    out
}
pub(super) fn plain_token_program() -> [u8; 32] {
    constant("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9")
}
fn ata(owner: &[u8; 32], mint: &[u8; 32], token: &[u8; 32]) -> Result<[u8; 32], Error> {
    let program = constant("8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859");
    for bump in (0u8..=255).rev() {
        let mut hash = Sha256::new();
        for seed in [
            owner.as_slice(),
            token.as_slice(),
            mint.as_slice(),
            &[bump],
            &program,
            b"ProgramDerivedAddress",
        ] {
            hash.update(seed);
        }
        let candidate: [u8; 32] = hash.finalize().into();
        if CompressedEdwardsY(candidate).decompress().is_none() {
            return Ok(candidate);
        }
    }
    Err(Error::InvalidDestination)
}

impl WireDescriptor {
    pub(super) fn descriptor(&self) -> Result<Descriptor, Error> {
        Ok(Descriptor {
            chain_identifier: self.chain_identifier.clone(),
            asset: match self.asset {
                WireAsset::Native {} => Asset::Native,
                WireAsset::Spl {
                    mint,
                    token_program,
                } => Asset::Spl {
                    mint,
                    token_program,
                },
            },
            recipient: self.recipient,
            ephemeral: self.ephemeral,
            operation_id: self.operation_id,
            member_index: self.member_index,
            message_context: self.message_context,
            recipient_amount: amount(&self.recipient_amount)?,
        })
    }
}

// The authorization memo binds all public operation facts to the exact signed message.
// This is an unallocated experimental on-chain memo, never a Frank wire schema allocation.
fn memo(d: &Descriptor, s: &Spend, n: u64) -> Vec<u8> {
    let mut auth = vec![0x88];
    bytes(&mut auth, &transcript(d));
    bytes(&mut auth, &s.owner);
    bytes(&mut auth, &s.destination);
    head(&mut auth, 0, n);
    bytes(&mut auth, &s.recent_blockhash);
    bytes(&mut auth, &s.operation_id);
    bytes(&mut auth, &s.message_context);
    if let Some(decimals) = s.decimals {
        head(&mut auth, 0, decimals as u64);
    } else {
        auth.push(0xf6);
    }
    let digest = Sha256::digest(auth);
    let mut out = b"frank:solana-custody-spend:experimental-v1:".to_vec();
    for byte in digest {
        out.extend_from_slice(format!("{byte:02x}").as_bytes());
    }
    out
}

pub(super) fn primary_message(
    d: &Descriptor,
    s: &Spend,
    authorization: &[u8],
    create_destination_ata: bool,
) -> Result<Vec<u8>, Error> {
    if d.chain_identifier != s.chain_identifier {
        return Err(Error::InvalidChain);
    }
    let n = amount(&s.amount)?;
    let memo_program = constant("054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d");
    let (mut keys, program_index, accounts, data, mut readonly) = match (&d.asset, &s.asset) {
        (Asset::Native, WireAsset::Native {}) => {
            if s.decimals.is_some() || create_destination_ata {
                return Err(Error::InvalidMessage);
            }
            let mut data = 2u32.to_le_bytes().to_vec();
            data.extend_from_slice(&n.to_le_bytes());
            (
                vec![s.owner, s.destination, [0; 32], memo_program],
                2,
                vec![0, 1],
                data,
                2,
            )
        }
        (
            Asset::Spl {
                mint,
                token_program,
            },
            WireAsset::Spl {
                mint: selected_mint,
                token_program: selected_program,
            },
        ) => {
            if mint != selected_mint
                || token_program != selected_program
                || *token_program != plain_token_program()
            {
                return Err(Error::InvalidMessage);
            }
            let decimals = s.decimals.ok_or(Error::InvalidMessage)?;
            let source = ata(&s.owner, mint, token_program)?;
            let destination = ata(&s.destination, mint, token_program)?;
            let mut data = vec![12];
            data.extend_from_slice(&n.to_le_bytes());
            data.push(decimals);
            (
                vec![
                    s.owner,
                    source,
                    destination,
                    *mint,
                    *token_program,
                    memo_program,
                ],
                4,
                vec![1, 3, 2, 0],
                data,
                3,
            )
        }
        _ => return Err(Error::InvalidMessage),
    };
    let memo_index = keys.len() - 1;
    if create_destination_ata {
        // Fixed idempotent classic ATA creation; no caller-provided accounts or instructions.
        keys.extend_from_slice(&[
            s.destination,
            [0; 32],
            constant("8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859"),
        ]);
        readonly += 3;
    }
    for (i, key) in keys.iter().enumerate() {
        if keys[..i].contains(key) {
            return Err(Error::InvalidMessage);
        }
    }
    let mut out = vec![0x80, 1, 0, readonly, keys.len() as u8];
    for key in &keys {
        out.extend_from_slice(key);
    }
    out.extend_from_slice(&s.recent_blockhash);
    out.push(if create_destination_ata { 3 } else { 2 });
    if create_destination_ata {
        // payer, destination ATA, destination owner, mint, SystemProgram, classic TokenProgram
        out.extend_from_slice(&[8, 6, 0, 2, 6, 3, 7, 4, 1, 1]);
    }
    out.extend_from_slice(&[program_index, accounts.len() as u8]);
    out.extend_from_slice(&accounts);
    out.push(data.len() as u8);
    out.extend_from_slice(&data);
    let mut memo = memo(d, s, n);
    {
        let mut input = vec![0x82];
        bytes(&mut input, &memo);
        bytes(&mut input, authorization);
        memo = b"frank:solana-custody-primary:experimental-v1:".to_vec();
        for byte in Sha256::digest(input) {
            memo.extend_from_slice(format!("{byte:02x}").as_bytes());
        }
    }
    out.extend_from_slice(&[memo_index as u8, 0, memo.len() as u8]);
    out.extend_from_slice(&memo);
    out.push(0); // no address lookup tables
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_parsing_rejects_unknown_fields_and_inexact_amounts() {
        for value in ["0", "01", "+1", "1.0", "1e3", "18446744073709551616"] {
            assert!(amount(value).is_err());
        }
        assert_eq!(amount("9007199254740993"), Ok(9007199254740993));
        assert!(
            serde_json::from_str::<WireAsset>(r#"{"kind":"native","hidden":"instruction"}"#)
                .is_err()
        );
    }
}
