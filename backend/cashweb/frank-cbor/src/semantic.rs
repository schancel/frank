//! Stage 9 checks that need no cryptography (S3-S10 and T3a.5).

use std::cmp::Ordering;
use std::collections::HashSet;

use crate::error::{CodecError, ErrorCategory, ErrorStage};
use crate::model::{
    AccountRef, KeyTransition, ParsedFrame, SignatureEntry, Timestamp, TypedPayload,
};

pub(crate) struct PriorView {
    pub network: String,
    pub subject: AccountRef,
    pub revision: u64,
    pub schema_version: u32,
    pub recovery: Vec<AccountRef>,
}

fn semantic(message: impl Into<String>, location: &str) -> CodecError {
    CodecError::new(
        ErrorCategory::Semantic,
        ErrorStage::S9,
        message,
        location,
        None,
    )
}

fn cmp_account(a: &AccountRef, b: &AccountRef) -> Ordering {
    a.key_type
        .cmp(&b.key_type)
        .then_with(|| a.key_bytes.cmp(&b.key_bytes))
}

fn accounts_equal(a: &AccountRef, b: &AccountRef) -> bool {
    cmp_account(a, b) == Ordering::Equal
}

fn cmp_timestamp(a: &Timestamp, b: &Timestamp) -> Ordering {
    a.seconds
        .cmp(&b.seconds)
        .then_with(|| a.nanoseconds.cmp(&b.nanoseconds))
}

fn require_ordered<T>(
    items: &[T],
    mut cmp: impl FnMut(&T, &T) -> Ordering,
    what: &str,
    location: &str,
    strict: bool,
) -> Result<(), CodecError> {
    for i in 1..items.len() {
        let order = cmp(&items[i - 1], &items[i]);
        if order == Ordering::Greater || (strict && order == Ordering::Equal) {
            let unique = if strict { " unique" } else { "" };
            return Err(semantic(
                format!("{what} not in ascending{unique} order at index {i}"),
                location,
            ));
        }
    }
    Ok(())
}

fn require_unique(keys: &[&[u8]], what: &str, location: &str) -> Result<(), CodecError> {
    let mut seen = HashSet::new();
    for key in keys {
        if !seen.insert((*key).to_vec()) {
            return Err(semantic(format!("duplicate {what}"), location));
        }
    }
    Ok(())
}

fn opened(frame: &ParsedFrame) -> &TypedPayload {
    frame
        .typed
        .as_deref()
        .expect("opened required child has a typed projection")
}

struct TransitionParts<'a> {
    network: &'a str,
    subject: &'a AccountRef,
    prior_authority: &'a AccountRef,
    revision: u64,
    new_key: &'a AccountRef,
}

fn transition_parts(frame: &ParsedFrame) -> TransitionParts<'_> {
    match opened(frame) {
        TypedPayload::KeyTransitionStatement {
            network,
            subject,
            prior_authority,
            revision,
            new_key,
            ..
        } => TransitionParts {
            network,
            subject,
            prior_authority,
            revision: *revision,
            new_key,
        },
        _ => panic!("internal: expected an opened type-7 frame"),
    }
}

/// Stage 9 for one frame after its children have finished.
///
/// `prior_slot` is `Some` only for a type-2 frame. `Some(None)` is bootstrap.
/// Other frames ignore the slot.
pub(crate) fn check_semantics(
    typed: &TypedPayload,
    prior_slot: Option<Option<&PriorView>>,
) -> Result<(), CodecError> {
    let path = "root/payload";
    match typed {
        TypedPayload::DirectMessage {
            network,
            destination,
            payload_frame,
            payments,
            ..
        } => {
            require_ordered(
                payments,
                |a, b| {
                    a.child_index
                        .cmp(&b.child_index)
                        .then_with(|| a.transaction_id.cmp(&b.transaction_id))
                },
                "payment members",
                &format!("{path}.4"),
                false,
            )?;
            let mut seen_idx = HashSet::new();
            for payment in payments {
                if !seen_idx.insert(payment.child_index) {
                    return Err(semantic("duplicate child index", &format!("{path}.4")));
                }
            }
            let txids: Vec<&[u8]> = payments
                .iter()
                .map(|p| p.transaction_id.as_slice())
                .collect();
            require_unique(&txids, "transaction id", &format!("{path}.4"))?;
            let child_network = match opened(payload_frame) {
                TypedPayload::RecipientPayload { network, .. } => network,
                _ => panic!("internal: expected an opened type-5 frame"),
            };
            if network != child_network {
                return Err(semantic(
                    "delivery network differs from the type-5 network (S8)",
                    &format!("{path}.0"),
                ));
            }
            // The destination is the stamp key P' and is deliberately not compared with the
            // type-5 recipient (S8): the routing identity and the payment key are independent.
            if destination.key_type != 1 {
                return Err(semantic(
                    "destination account must be key type 1 (S9)",
                    &format!("{path}.1"),
                ));
            }
            let addresses: Vec<&[u8]> = payments.iter().map(|p| p.address.as_slice()).collect();
            require_unique(&addresses, "payment address", &format!("{path}.4"))?;
            for (i, payment) in payments.iter().enumerate() {
                if payment.child_index != i as u32 {
                    return Err(semantic(
                        "child indices must be exactly contiguous 0..n-1 (T3a.5)",
                        &format!("{path}.4[{i}]"),
                    ));
                }
            }
            Ok(())
        }
        TypedPayload::TopicPostSubmission {
            network,
            post_frame,
            ..
        } => match opened(post_frame) {
            TypedPayload::TopicPost {
                network: post_network,
                ..
            } if post_network == network => Ok(()),
            TypedPayload::TopicPost { .. } => Err(semantic(
                "submission network differs from the type-9 network (S11)",
                &format!("{path}.0"),
            )),
            _ => panic!("internal: expected an opened type-9 frame"),
        },
        TypedPayload::DirectoryAttestation {
            statement,
            signatures,
            ..
        } => {
            require_ordered(
                signatures,
                |a: &SignatureEntry, b: &SignatureEntry| {
                    a.algorithm
                        .cmp(&b.algorithm)
                        .then_with(|| cmp_account(&a.signer, &b.signer))
                },
                "signatures",
                &format!("{path}.1"),
                true,
            )?;
            let (st_network, st_subject, st_revision, st_schema, transitions) =
                match opened(statement) {
                    TypedPayload::DirectoryStatement {
                        network,
                        subject,
                        revision,
                        schema_version,
                        key_transitions,
                        ..
                    } => (
                        network.as_str(),
                        subject,
                        *revision,
                        *schema_version,
                        key_transitions.as_deref(),
                    ),
                    _ => panic!("internal: expected an opened type-4 frame"),
                };
            if !signatures
                .iter()
                .any(|sig| accounts_equal(&sig.signer, st_subject))
            {
                return Err(semantic(
                    "no signature entry is signed by the statement subject",
                    &format!("{path}.1"),
                ));
            }
            if crate::directory_preview::is_preview(opened(statement)) {
                if signatures.len() != 1 || signatures[0].algorithm != 1 {
                    return Err(semantic(
                        "directory preview requires exactly one algorithm-1 subject signature",
                        &format!("{path}.1"),
                    ));
                }
                return Ok(());
            }
            let prior = prior_slot.expect("internal: type-2 semantics need the prior slot");
            check_directory_update(
                st_network,
                st_subject,
                st_revision,
                st_schema,
                transitions,
                prior,
            )
        }
        TypedPayload::MailboxCheckpoint {
            facts, sections, ..
        } => {
            require_ordered(
                facts,
                |a, b| {
                    cmp_timestamp(&a.timestamp, &b.timestamp)
                        .then_with(|| a.fact_id.cmp(&b.fact_id))
                },
                "journal facts",
                &format!("{path}.4"),
                false,
            )?;
            let ids: Vec<&[u8]> = facts.iter().map(|fact| fact.fact_id.as_slice()).collect();
            require_unique(&ids, "fact_id", &format!("{path}.4"))?;
            if let Some(sections) = sections {
                require_ordered(
                    sections,
                    |a, b| {
                        a.section_type
                            .cmp(&b.section_type)
                            .then_with(|| a.section_schema_version.cmp(&b.section_schema_version))
                    },
                    "opaque sections",
                    &format!("{path}.5"),
                    false,
                )?;
                let mut seen = HashSet::new();
                for section in sections {
                    if !seen.insert(section.section_type) {
                        return Err(semantic("duplicate section_type", &format!("{path}.5")));
                    }
                }
            }
            Ok(())
        }
        TypedPayload::DirectoryStatement {
            relays,
            key_transitions,
            recovery,
            stamp_key,
            profile_entries,
            ..
        } => {
            crate::directory_preview::check_statement(typed)?;
            require_ordered(
                relays,
                |a, b| {
                    a.relay_id
                        .cmp(&b.relay_id)
                        .then_with(|| a.endpoint.cmp(&b.endpoint))
                },
                "relay bindings",
                &format!("{path}.4"),
                false,
            )?;
            let ids: Vec<&[u8]> = relays
                .iter()
                .map(|relay| relay.relay_id.as_slice())
                .collect();
            require_unique(&ids, "relay_id", &format!("{path}.4"))?;
            // S10a.1: the stamp key is key type 1. Whether it is a curve point is not a
            // statement check (a bad point makes every delivery to it fail at T3a.6, stage 10).
            if let Some(key) = stamp_key {
                if key.key_type != 1 {
                    return Err(semantic(
                        "stamp key must be key type 1 (S10a.1)",
                        &format!("{path}.8"),
                    ));
                }
            }
            if let Some(transitions) = key_transitions {
                let parts: Vec<TransitionParts<'_>> = transitions
                    .iter()
                    .map(|transition| transition_parts(&transition.statement))
                    .collect();
                require_ordered(
                    &parts,
                    |a, b| {
                        a.revision
                            .cmp(&b.revision)
                            .then_with(|| cmp_account(a.new_key, b.new_key))
                    },
                    "key transitions",
                    &format!("{path}.5"),
                    true,
                )?;
                for i in 1..parts.len() {
                    if parts[i - 1].revision == parts[i].revision {
                        return Err(semantic(
                            "two key transitions share a revision (S5)",
                            &format!("{path}.5"),
                        ));
                    }
                }
            }
            if let Some(authorities) = recovery {
                require_ordered(
                    authorities,
                    cmp_account,
                    "recovery authorities",
                    &format!("{path}.7"),
                    true,
                )?;
            }
            if let Some(entries) = profile_entries {
                for (i, entry) in entries.iter().enumerate() {
                    let names: Vec<&[u8]> =
                        entry.headers.iter().map(|h| h.name.as_bytes()).collect();
                    require_ordered(
                        &names,
                        Ord::cmp,
                        "profile-entry headers",
                        &format!("{path}.9[{i}].1"),
                        true,
                    )?;
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn check_directory_update(
    network: &str,
    subject: &AccountRef,
    revision: u64,
    schema_version: u32,
    transitions: Option<&[KeyTransition]>,
    prior: Option<&PriorView>,
) -> Result<(), CodecError> {
    let path = "root/payload.0";
    let Some(prior) = prior else {
        if transitions.is_some() {
            return Err(semantic(
                "a bootstrap statement must not carry key transitions (S10)",
                path,
            ));
        }
        return Ok(());
    };
    if revision <= prior.revision {
        return Err(semantic(
            "statement revision does not exceed the prior revision (S10)",
            path,
        ));
    }
    if network != prior.network {
        return Err(semantic(
            "statement network differs from the prior network (S10)",
            path,
        ));
    }
    let changed = !accounts_equal(subject, &prior.subject);
    // S10a.2: a same-subject statement may not lower schema_version, so a stamp key, once
    // published, cannot be dropped. A new subject starts fresh.
    if !changed && schema_version < prior.schema_version {
        return Err(semantic(
            "a same-subject statement lowers schema_version (S10a.2)",
            path,
        ));
    }
    if !changed {
        if transitions.is_some() {
            return Err(semantic(
                "key transitions with an unchanged subject (S10)",
                path,
            ));
        }
        return Ok(());
    }
    let Some(transitions) = transitions else {
        return Err(semantic(
            "a changed subject needs exactly one key transition (S10)",
            path,
        ));
    };
    if transitions.len() != 1 {
        return Err(semantic(
            "a changed subject needs exactly one key transition (S10)",
            path,
        ));
    }
    let transition = &transitions[0];
    let parts = transition_parts(&transition.statement);
    if parts.network != network || parts.network != prior.network {
        return Err(semantic(
            "transition network differs from the statement networks (S10)",
            path,
        ));
    }
    if !accounts_equal(parts.subject, &prior.subject) {
        return Err(semantic(
            "transition subject differs from the previous subject (S10)",
            path,
        ));
    }
    if parts.revision != revision || parts.revision <= prior.revision {
        return Err(semantic(
            "transition revision does not link the statements (S10)",
            path,
        ));
    }
    if !accounts_equal(parts.new_key, subject) {
        return Err(semantic(
            "transition new_key differs from the new subject (S10)",
            path,
        ));
    }
    let registered = accounts_equal(parts.prior_authority, &prior.subject)
        || prior
            .recovery
            .iter()
            .any(|authority| accounts_equal(authority, parts.prior_authority));
    if !registered {
        return Err(semantic(
            "prior authority is not registered in the last accepted statement (S4a)",
            path,
        ));
    }
    if !accounts_equal(&transition.signer, parts.prior_authority) {
        return Err(semantic(
            "transition signer differs from the statement prior_authority (T2a)",
            path,
        ));
    }
    Ok(())
}
