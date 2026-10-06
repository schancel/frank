//! Stage 9 checks that need no cryptography (S3-S10 and T3a.5).

use std::cmp::Ordering;
use std::collections::HashSet;

use crate::error::{CodecError, ErrorCategory, ErrorStage};
use crate::hash::content_hash;
use crate::model::{
    AccountRef, KeyTransition, ParsedFrame, SignatureEntry, Timestamp, TypedPayload,
};
use crate::model::{ForumCursor, ForumCursorPosition, ForumDiscoveryPage, ForumTopicPage};

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

fn cursor_binding(
    c: &ForumCursor,
    network: &str,
    revision: u64,
    epoch: &[u8],
    topic: Option<(&str, &Timestamp)>,
) -> Result<(), CodecError> {
    if c.network != network || c.revision != revision || c.epoch != epoch {
        return Err(semantic("cursor page binding", "root"));
    }
    match (&c.position, topic) {
        (ForumCursorPosition::Topic { topic, since, .. }, Some((expected, time)))
            if topic == expected && since == time =>
        {
            Ok(())
        }
        (ForumCursorPosition::Discovery { .. }, None) => Ok(()),
        _ => Err(semantic("cursor query/family binding", "root")),
    }
}
fn cursor_incarnation(
    next: &Option<ForumCursor>,
    request: &Option<ForumCursor>,
) -> Result<(), CodecError> {
    if let (Some(next), Some(request)) = (next, request) {
        if next.incarnation != request.incarnation {
            return Err(semantic("cursor incarnation changed", "root"));
        }
    }
    Ok(())
}
fn forum_topic_page(page: &ForumTopicPage<ParsedFrame, ForumCursor>) -> Result<(), CodecError> {
    if page.rows.is_empty() && page.next_cursor.is_some() {
        return Err(semantic("empty page has continuation", "root"));
    }
    for c in [&page.next_cursor, &page.request_cursor]
        .into_iter()
        .flatten()
    {
        cursor_binding(
            c,
            &page.network,
            page.revision,
            &page.epoch,
            Some((&page.topic, &page.since)),
        )?;
    }
    cursor_incarnation(&page.next_cursor, &page.request_cursor)?;
    let mut previous = match page.request_cursor.as_ref().map(|c| &c.position) {
        Some(ForumCursorPosition::Topic {
            timestamp, hash, ..
        }) => Some((timestamp.clone(), hash.clone())),
        _ => None,
    };
    let mut ids = HashSet::new();
    for row in &page.rows {
        let TypedPayload::ForumView(view) = opened(row) else {
            unreachable!("required view")
        };
        let TypedPayload::TopicPost { topic, .. } = opened(&view.post_frame) else {
            unreachable!("required post")
        };
        if view.network != page.network
            || *topic != page.topic
            || view.revision != page.revision
            || view.epoch != page.epoch
        {
            return Err(semantic("Forum row binding", "root"));
        }
        let hash = content_hash(&view.post_frame)
            .expect("validated post")
            .to_vec();
        if cmp_timestamp(&view.first_visible, &page.since) == Ordering::Less {
            return Err(semantic("Forum row before inclusive since", "root"));
        }
        if let Some((time, id)) = &previous {
            if cmp_timestamp(time, &view.first_visible).then_with(|| id.cmp(&hash))
                != Ordering::Less
            {
                return Err(semantic("Forum rows not strictly ordered", "root"));
            }
        }
        if !ids.insert(hash.clone()) {
            return Err(semantic("duplicate Forum post", "root"));
        }
        previous = Some((view.first_visible.clone(), hash));
    }
    if let Some(ForumCursor {
        position: ForumCursorPosition::Topic {
            timestamp, hash, ..
        },
        ..
    }) = &page.next_cursor
    {
        if previous.as_ref() != Some(&(timestamp.clone(), hash.clone())) {
            return Err(semantic("continuation is not last Forum row", "root"));
        }
    }
    Ok(())
}
fn forum_discovery_page(page: &ForumDiscoveryPage<ForumCursor>) -> Result<(), CodecError> {
    if page.entries.is_empty() && page.next_cursor.is_some() {
        return Err(semantic("empty page has continuation", "root"));
    }
    for c in [&page.next_cursor, &page.request_cursor]
        .into_iter()
        .flatten()
    {
        cursor_binding(c, &page.network, page.revision, &page.epoch, None)?;
    }
    cursor_incarnation(&page.next_cursor, &page.request_cursor)?;
    let mut previous = match page.request_cursor.as_ref().map(|c| &c.position) {
        Some(ForumCursorPosition::Discovery { topic }) => Some(topic),
        _ => None,
    };
    for row in &page.entries {
        if previous.is_some_and(|p| p.as_bytes() >= row.topic.as_bytes()) {
            return Err(semantic("discovery rows not strictly ordered", "root"));
        }
        previous = Some(&row.topic);
    }
    if let Some(ForumCursor {
        position: ForumCursorPosition::Discovery { topic },
        ..
    }) = &page.next_cursor
    {
        if previous != Some(topic) {
            return Err(semantic("continuation is not last discovery row", "root"));
        }
    }
    Ok(())
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

/// 10^40 - 1 as a fixed 32-byte unsigned big-endian value. Comparing such values bytewise
/// preserves every quantity without an i64/f64 cast.
fn blackjack_quantity_limit() -> Vec<u8> {
    let mut limit = vec![0u8; 32];
    let mut n = 10u128.pow(38); // 10^40 exceeds u128; multiply bytes twice below.
    for b in limit.iter_mut().rev() {
        *b = (n & 255) as u8;
        n >>= 8;
    }
    for _ in 0..2 {
        let mut carry = 0u16;
        for b in limit.iter_mut().rev() {
            let v = u16::from(*b) * 10 + carry;
            *b = v as u8;
            carry = v >> 8;
        }
    }
    for b in limit.iter_mut().rev() {
        if *b > 0 {
            *b -= 1;
            break;
        }
        *b = 255;
    }
    limit
}

/// Stage 9 of the schema-2 hand shapes: unique cards, a distinct up-card, a positive bounded
/// maximum bet. The schema-1 welcome game ID reservation does not apply.
fn check_blackjack_hand(
    item: &crate::model::BlackjackHandMessageItem,
    path: &str,
) -> Result<(), CodecError> {
    use crate::model::BlackjackHandAction;
    let cards = match &item.action {
        BlackjackHandAction::Deal { player_cards, .. }
        | BlackjackHandAction::Card { player_cards } => Some(player_cards),
        BlackjackHandAction::Reveal { dealer_cards, .. } => Some(dealer_cards),
        _ => None,
    };
    if let Some(cards) = cards {
        if cards.iter().collect::<HashSet<_>>().len() != cards.len() {
            return Err(semantic("blackjack hand contains duplicate cards", path));
        }
    }
    if let BlackjackHandAction::Deal {
        player_cards,
        dealer_up_card,
    } = &item.action
    {
        if player_cards.contains(dealer_up_card) {
            return Err(semantic("deal up-card duplicates a player card", path));
        }
    }
    if let BlackjackHandAction::ChallengeDealer { max_bet_wei, .. }
    | BlackjackHandAction::ChallengePlayer { max_bet_wei }
    | BlackjackHandAction::Accept { max_bet_wei, .. } = &item.action
    {
        if max_bet_wei.iter().all(|b| *b == 0) || max_bet_wei > &blackjack_quantity_limit() {
            return Err(semantic("blackjack max bet range", path));
        }
    }
    Ok(())
}
/// Stage 9 of the schema-3 hand shapes: a positive bounded maximum bet on challenge and accept.
/// No shape carries a card or an outcome, so nothing else is checked here.
fn check_blackjack_hand_v3(
    item: &crate::model::BlackjackHandV3MessageItem,
    path: &str,
) -> Result<(), CodecError> {
    use crate::model::BlackjackHandV3Action;
    if let BlackjackHandV3Action::ChallengeDealer { max_bet_wei, .. }
    | BlackjackHandV3Action::ChallengePlayer { max_bet_wei }
    | BlackjackHandV3Action::Accept { max_bet_wei, .. } = &item.action
    {
        if max_bet_wei.iter().all(|b| *b == 0) || max_bet_wei > &blackjack_quantity_limit() {
            return Err(semantic("blackjack max bet range", path));
        }
    }
    Ok(())
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
        TypedPayload::BlackjackItem(item) => check_blackjack(item, path),
        TypedPayload::BlackjackHandItem(item) => check_blackjack_hand(item, path),
        TypedPayload::BlackjackHandV3Item(item) => check_blackjack_hand_v3(item, path),
        TypedPayload::ForwardingDelivery {
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
            let tx_keys: Vec<Vec<u8>> = payments
                .iter()
                .map(|p| {
                    if let Some(vout) = p.vout {
                        let mut key = Vec::with_capacity(p.transaction_id.len() + 4);
                        key.extend_from_slice(&p.transaction_id);
                        key.extend_from_slice(&vout.to_be_bytes());
                        key
                    } else {
                        p.transaction_id.clone()
                    }
                })
                .collect();
            let tx_key_refs: Vec<&[u8]> = tx_keys.iter().map(|k| k.as_slice()).collect();
            require_unique(&tx_key_refs, "transaction id", &format!("{path}.4"))?;
            let child_network = match opened(payload_frame) {
                TypedPayload::DirectMessage { network, .. } => network,
                _ => panic!("internal: expected an opened type-1 frame"),
            };
            if network != child_network {
                return Err(semantic(
                    "forwarding network differs from the type-1 network",
                    &format!("{path}.0"),
                ));
            }
            if destination.key_type != 1 {
                return Err(semantic(
                    "destination account must be key type 1",
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
        TypedPayload::DirectMessage {
            network,
            destination,
            payload_frame,
            payments,
            recipient,
            dleq_proof,
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
            let tx_keys: Vec<Vec<u8>> = payments
                .iter()
                .map(|p| {
                    if let Some(vout) = p.vout {
                        let mut key = Vec::with_capacity(p.transaction_id.len() + 4);
                        key.extend_from_slice(&p.transaction_id);
                        key.extend_from_slice(&vout.to_be_bytes());
                        key
                    } else {
                        p.transaction_id.clone()
                    }
                })
                .collect();
            let tx_key_refs: Vec<&[u8]> = tx_keys.iter().map(|k| k.as_slice()).collect();
            require_unique(&tx_key_refs, "transaction id", &format!("{path}.4"))?;
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
            if (recipient.is_some() && dleq_proof.is_none())
                || (recipient.is_none() && dleq_proof.is_some())
            {
                return Err(semantic(
                    "recipient and DLEQ proof must both be present if either is present",
                    path,
                ));
            }
            if let Some(rec) = recipient {
                if rec.key_type != 1 {
                    return Err(semantic(
                        "recipient account must be key type 1",
                        &format!("{path}.5"),
                    ));
                }
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
        TypedPayload::ForumView(view) => match opened(&view.post_frame) {
            TypedPayload::TopicPost { network, .. } if *network == view.network => Ok(()),
            _ => Err(semantic("Forum view network differs from post", path)),
        },
        TypedPayload::ForumTopicPage(page) => forum_topic_page(page),
        TypedPayload::ForumDiscoveryPage(page) => forum_discovery_page(page),
        TypedPayload::ForumOperationStatus(status) => {
            let (network, target) = match opened(&status.submitted_frame) {
                TypedPayload::TopicPostSubmission {
                    network,
                    post_frame,
                    ..
                } => (
                    network,
                    content_hash(post_frame).expect("validated post").to_vec(),
                ),
                TypedPayload::TopicVoteSubmission {
                    network,
                    target_hash,
                    ..
                } => (network, target_hash.clone()),
                _ => unreachable!("required operation"),
            };
            if *network != status.network || target != status.target_hash {
                return Err(semantic("status submission network/target binding", path));
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

fn check_blackjack(
    item: &crate::model::BlackjackMessageItem,
    path: &str,
) -> Result<(), CodecError> {
    use crate::model::BlackjackAction;
    let welcome = matches!(item.action, BlackjackAction::Welcome { .. });
    if (item.game_id == "welcome") != welcome {
        return Err(semantic(
            "welcome gameId is reserved iff action is welcome",
            path,
        ));
    }
    let cards = match &item.action {
        BlackjackAction::Deal { player_cards, .. }
        | BlackjackAction::HitResponse { player_cards }
        | BlackjackAction::DoubleResponse { player_cards } => Some(player_cards),
        BlackjackAction::Reveal { dealer_cards, .. } => Some(dealer_cards),
        _ => None,
    };
    if let Some(cards) = cards {
        if cards.iter().collect::<HashSet<_>>().len() != cards.len() {
            return Err(semantic("blackjack hand contains duplicate cards", path));
        }
    }
    if let BlackjackAction::Deal {
        player_cards,
        dealer_up_card,
        ..
    } = &item.action
    {
        if player_cards.contains(dealer_up_card) {
            return Err(semantic("deal up-card duplicates a player card", path));
        }
    }
    if let BlackjackAction::Welcome {
        min_wager_wei,
        max_wager_wei,
        fee_hint_wei,
        ..
    } = &item.action
    {
        let limit = blackjack_quantity_limit();
        if min_wager_wei.iter().all(|b| *b == 0)
            || max_wager_wei.iter().all(|b| *b == 0)
            || min_wager_wei > max_wager_wei
            || max_wager_wei > &limit
            || fee_hint_wei.as_ref().is_some_and(|fee| fee > &limit)
        {
            return Err(semantic("blackjack welcome quantity range/order", path));
        }
    }
    Ok(())
}
