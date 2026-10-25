//! Paid group writes on the hosting relay: the operator's policy, the payment carried by a
//! write, and its broadcast after the write commits. The checks themselves are pure and live in
//! [`crate::group_write_payment`].

use std::sync::Arc;

use frank_cbor::{decode_canonical, message_fields, CborValue};
use serde::{Deserialize, Serialize};

use crate::{
    chains::EvmChainAdapter,
    group_write_payment::{
        canonical_host_origin, verify_group_write_payment, GroupPaymentError, GroupWritePayee,
        GroupWritePolicy, GroupWriteTarget, VerifiedGroupPayment, BURN_ADDRESS,
    },
    store::groups::{parse_group_id_hex, GroupError, GroupMessageEnvelope, GroupWritePaymentFact},
};

/// The payment field of a group write (`group-write-payment`), as JSON carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupWritePaymentWire {
    /// Canonical chain identifier the payment is on.
    pub network: String,
    /// Hex-encoded signed raw transaction (optional `0x`).
    pub raw_transaction: String,
}

/// `PUT /groups/:group_id/messages` body: the sealed envelope plus its payment. The payment is
/// an admission fact of the hosting relay and is never part of the stored message row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupWriteRequest {
    /// The sealed-sender envelope the group's write key signed.
    #[serde(flatten)]
    pub envelope: GroupMessageEnvelope,
    /// The payment for this write. Required for every new write.
    #[serde(default)]
    pub payment: Option<GroupWritePaymentWire>,
}

impl GroupWriteRequest {
    /// Decode the CBOR body (`group-message-envelope`, with `payment` at its key).
    pub fn from_cbor_bytes(bytes: &[u8]) -> Result<Self, GroupError> {
        use message_fields::{group_message_envelope as E, group_write_payment as P};
        let envelope = GroupMessageEnvelope::from_cbor_bytes(bytes)?;
        let CborValue::Map(entries) =
            decode_canonical(bytes).map_err(|error| GroupError::InvalidInput(error.to_string()))?
        else {
            return Err(GroupError::InvalidInput("expected CBOR map".into()));
        };
        let payment = match entries.iter().find(|(key, _)| *key == E::PAYMENT) {
            None => None,
            Some((_, CborValue::Map(fields))) => {
                let mut network = None;
                let mut raw_transaction = None;
                for (key, value) in fields {
                    match (*key, value) {
                        (P::NETWORK, CborValue::Text(text)) => network = Some(text.clone()),
                        (P::RAW_TRANSACTION, CborValue::Bytes(bytes)) => {
                            raw_transaction = Some(hex::encode(bytes))
                        }
                        (P::RAW_TRANSACTION, CborValue::Text(text)) => {
                            raw_transaction = Some(text.clone())
                        }
                        _ => {}
                    }
                }
                Some(GroupWritePaymentWire {
                    network: network.ok_or_else(|| {
                        GroupError::InvalidInput("missing payment network".into())
                    })?,
                    raw_transaction: raw_transaction.ok_or_else(|| {
                        GroupError::InvalidInput("missing payment raw_transaction".into())
                    })?,
                })
            }
            Some(_) => return Err(GroupError::InvalidInput("payment must be a map".into())),
        };
        Ok(Self { envelope, payment })
    }
}

/// Payee as `GET /groups/:group_id/write-policy` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GroupWritePayeeBody {
    /// Every write pays `address`, the burn address.
    Burn {
        /// `0x`-prefixed burn address.
        address: String,
    },
    /// Every write pays `address`.
    Address {
        /// `0x`-prefixed payee address.
        address: String,
    },
    /// Each write pays `xpub/0/i`, `i = u32_be(commitment[0..4]) & 0x7fffffff`.
    Xpub {
        /// The operator's extended public key.
        xpub: String,
    },
}

/// Body of `GET /groups/:group_id/write-policy`: what a write to a group this relay hosts must
/// pay. Every value is the hosting relay's; a home relay proxies the request to the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupWritePolicyBody {
    /// Canonical chain identifier payments are made on.
    pub network: String,
    /// Least value of a payment, decimal wei.
    pub price_wei: String,
    /// The origin every payment's commitment names.
    pub host_origin: String,
    /// Who is paid.
    pub payee: GroupWritePayeeBody,
}

/// The relay's group-write policy and the node it checks and broadcasts payments through.
#[derive(Debug)]
pub struct GroupWriteRuntime {
    node: PaymentNode,
    policy: GroupWritePolicy,
    body: GroupWritePolicyBody,
}

/// Where the host reads a payer's account and sends a payment.
#[derive(Debug)]
enum PaymentNode {
    /// The relay network's identity-checked upstreams.
    Upstream(Arc<EvmChainAdapter>),
    /// The relay network has no upstream: every new write is refused, retryably, because no
    /// payment can be checked.
    Missing,
    /// A loopback protocol fixture with no chain at all: payments are checked from their bytes
    /// only and never broadcast. Never built by the daemon.
    Fixture,
}

/// Longest the relay waits on the node, for a payer's account or a payment, before answering
/// the writer.
const NODE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

impl GroupWriteRuntime {
    /// Group writes on `chain` (the relay's `registry.network`), priced and paid as `conf` says,
    /// committed to the relay's public origin `host_origin`.
    pub fn new(
        chain: Arc<EvmChainAdapter>,
        conf: &cashweb_config::GroupWritesConf,
        host_origin: &url::Url,
    ) -> Result<Self, String> {
        Self::build(chain.id(), conf, host_origin, PaymentNode::Upstream(chain))
    }

    /// Group writes on `network` when the relay has no upstream for it: the policy is served,
    /// and every new write is refused with a retryable 503, since no payer can be checked.
    pub fn without_upstream(
        network: &str,
        conf: &cashweb_config::GroupWritesConf,
        host_origin: &url::Url,
    ) -> Result<Self, String> {
        Self::build(network, conf, host_origin, PaymentNode::Missing)
    }

    /// For loopback fixtures that test the protocol, not the chain: payments are checked from
    /// their bytes only (no payer account read) and never broadcast. Never use it in the daemon.
    pub fn loopback_fixture(
        network: &str,
        conf: &cashweb_config::GroupWritesConf,
        host_origin: &url::Url,
    ) -> Result<Self, String> {
        Self::build(network, conf, host_origin, PaymentNode::Fixture)
    }

    fn build(
        network: &str,
        conf: &cashweb_config::GroupWritesConf,
        host_origin: &url::Url,
        node: PaymentNode,
    ) -> Result<Self, String> {
        let chain = cashweb_config::protocol_chain(network)
            .ok_or_else(|| format!("{network} is not a protocol chain identifier"))?;
        let chain_id = chain
            .evm_chain_id()
            .ok_or_else(|| format!("{network} is not an EVM chain"))?;
        conf.validate().map_err(|error| error.to_string())?;
        let price_wei = conf.price_wei().map_err(|error| error.to_string())?;
        let host_origin = canonical_host_origin(host_origin)
            .ok_or_else(|| "the relay url is not an origin".to_owned())?;
        let payee = GroupWritePayee::from_conf(&conf.payee).map_err(|error| error.to_string())?;
        let payee_body = match &conf.payee {
            cashweb_config::GroupWritePayeeConf::Burn => GroupWritePayeeBody::Burn {
                address: format!("0x{}", hex::encode(BURN_ADDRESS)),
            },
            cashweb_config::GroupWritePayeeConf::Address(address) => GroupWritePayeeBody::Address {
                address: address.to_lowercase(),
            },
            cashweb_config::GroupWritePayeeConf::Xpub(xpub) => GroupWritePayeeBody::Xpub {
                xpub: xpub.trim().to_owned(),
            },
        };
        Ok(Self {
            node,
            body: GroupWritePolicyBody {
                network: chain.id.clone(),
                price_wei: price_wei.to_string(),
                host_origin: host_origin.clone(),
                payee: payee_body,
            },
            policy: GroupWritePolicy {
                network: chain.id.clone(),
                chain_id,
                host_origin,
                price_wei,
                payee,
            },
        })
    }

    /// The policy every new write is checked against.
    pub fn policy(&self) -> &GroupWritePolicy {
        &self.policy
    }

    /// The policy as `GET /groups/:group_id/write-policy` reports it.
    pub fn body(&self) -> &GroupWritePolicyBody {
        &self.body
    }

    /// Check `payment` pays for exactly `envelope` on this relay.
    pub fn verify(
        &self,
        path_group_id: &str,
        envelope: &GroupMessageEnvelope,
        payment: &GroupWritePaymentWire,
    ) -> Result<VerifiedGroupPayment, GroupWriteRefusal> {
        let target = GroupWriteTarget {
            group_id: parse_group_id_hex(path_group_id).map_err(GroupWriteRefusal::Group)?,
            epoch: envelope.epoch,
            signing_digest: envelope
                .signing_digest()
                .map_err(GroupWriteRefusal::Group)?,
        };
        let raw = payment
            .raw_transaction
            .strip_prefix("0x")
            .unwrap_or(&payment.raw_transaction);
        let raw = hex::decode(raw)
            .map_err(|_| GroupWriteRefusal::Payment(GroupPaymentError::Malformed))?;
        verify_group_write_payment(&self.policy, &target, &payment.network, &raw)
            .map_err(GroupWriteRefusal::Payment)
    }

    /// What the store records of a verified payment, in the write's acceptance transaction.
    pub fn fact(&self, payment: &VerifiedGroupPayment) -> GroupWritePaymentFact {
        GroupWritePaymentFact {
            network: self.policy.network.clone(),
            tx_hash: payment.tx_hash.0,
            payer: payment.sender.0,
            payee: payment.payee,
            value_wei: payment.value_wei,
            nonce: payment.nonce,
        }
    }

    /// Ask the node whether `payment` can land, before the write is accepted: its nonce is in
    /// `[pending, pending + PAYMENT_NONCE_WINDOW]` and the payer's balance covers its value and
    /// most gas cost. A payment the node already holds (an earlier attempt's copy) passes.
    /// Without an answer the write is deferred retryably: the relay never accepts a write it
    /// could not check. This check keeps no state; the store admits at most one accepted write
    /// per (network, payer, nonce) (`G_pnonce`), in the accept transaction.
    ///
    /// What this cannot rule out: an accepted payment that never lands because the payer gets
    /// another transaction included at its nonce. With one write per nonce, each such write
    /// still costs the payer one landed transaction at that nonce, and at most
    /// `PAYMENT_NONCE_WINDOW + 1` (64) of a payer's writes can be outstanding unlanded.
    pub async fn check_funded(
        &self,
        payment: &VerifiedGroupPayment,
    ) -> Result<(), GroupWriteRefusal> {
        let chain = match &self.node {
            PaymentNode::Fixture => return Ok(()),
            PaymentNode::Missing => {
                return Err(GroupWriteRefusal::CheckUnavailable(
                    "this relay has no upstream for its network".into(),
                ))
            }
            PaymentNode::Upstream(chain) => chain,
        };
        let Some(transport) = chain.transport() else {
            return Err(GroupWriteRefusal::CheckUnavailable(
                "no upstream of the relay network has proved its identity yet".into(),
            ));
        };
        let client = crate::monad_http::MonadHttpClient::with_transport(transport);
        let read = async {
            use crate::monad_http::BlockTag;
            let (nonce, balance) = futures::future::join(
                client.get_transaction_count(payment.sender, BlockTag::Pending),
                client.get_balance(payment.sender, BlockTag::Latest),
            )
            .await;
            let account = PayerAccount {
                pending_nonce: nonce?,
                balance_wei: balance?,
            };
            let held = if payment.nonce < account.pending_nonce {
                client
                    .get_transaction_by_hash(payment.tx_hash)
                    .await?
                    .is_some()
            } else {
                false
            };
            Ok::<_, crate::monad_http::MonadRpcError>((account, held))
        };
        match tokio::time::timeout(NODE_TIMEOUT, read).await {
            Ok(Ok((account, held))) => match judge_funding(payment, &account, held) {
                None => Ok(()),
                Some(FundingProblem::StaleNonce) => Err(GroupWriteRefusal::StaleNonce),
                Some(problem) => Err(GroupWriteRefusal::NotReady(problem.reason())),
            },
            Ok(Err(error)) => Err(GroupWriteRefusal::CheckUnavailable(error.to_string())),
            Err(_) => Err(GroupWriteRefusal::CheckUnavailable(
                "no answer from the node in time".into(),
            )),
        }
    }

    /// Hand a committed write's payment to the node once. Logged, never retried here. The
    /// writer's wallet broadcasts the same bytes once the relay holds the write, so a failure
    /// here only delays the payment. A retry of the write is answered with its receipt and hands
    /// nothing over.
    pub async fn broadcast(&self, group_id: &str, payment: &VerifiedGroupPayment) {
        let tx_hash = hex::encode(payment.tx_hash.0);
        let transport = match &self.node {
            PaymentNode::Upstream(chain) => chain.transport(),
            PaymentNode::Missing | PaymentNode::Fixture => None,
        };
        let Some(transport) = transport else {
            tracing::event!(
                tracing::Level::WARN,
                group_id,
                tx_hash = %tx_hash,
                "Group write payment not broadcast by the relay: no proven upstream of its \
                 network. The writer's wallet broadcasts it"
            );
            return;
        };
        let client = crate::monad_http::MonadHttpClient::with_transport(transport);
        match tokio::time::timeout(
            NODE_TIMEOUT,
            client.send_raw_transaction(&payment.raw_transaction),
        )
        .await
        {
            Ok(Ok(_)) => tracing::event!(
                tracing::Level::DEBUG,
                group_id,
                tx_hash = %tx_hash,
                "Group write payment broadcast"
            ),
            Ok(Err(error)) if error.says_tx_already_held() => tracing::event!(
                tracing::Level::DEBUG,
                group_id,
                tx_hash = %tx_hash,
                "Group write payment already held by the node"
            ),
            Ok(Err(error)) => tracing::event!(
                tracing::Level::WARN,
                group_id,
                tx_hash = %tx_hash,
                error = %error,
                "Group write payment not broadcast by the relay; the write is stored and the \
                 writer's wallet broadcasts it"
            ),
            Err(_) => tracing::event!(
                tracing::Level::WARN,
                group_id,
                tx_hash = %tx_hash,
                "Group write payment: no answer from the node in time; the write is stored and \
                 the writer's wallet broadcasts it"
            ),
        }
    }
}

/// Why a write was refused before anything was stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupWriteRefusal {
    /// The envelope itself is invalid.
    Group(GroupError),
    /// The payment does not pay for this write.
    Payment(GroupPaymentError),
    /// The payment pays for this write but its nonce is already used (`402
    /// group_payment_unfunded`, reason `stale_nonce`): it can never land.
    StaleNonce,
    /// The payment pays for this write but the node does not show that it can land yet (`503
    /// group_payment_not_ready`, retryable): `nonce_gap` or `insufficient_balance`. Both may be
    /// the node lagging, a predecessor not yet broadcast, or a deposit not yet seen.
    NotReady(&'static str),
    /// The node could not be asked (`503`, retryable): nothing was stored.
    CheckUnavailable(String),
}

/// What the node says about a paying account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PayerAccount {
    /// `eth_getTransactionCount(pending)`. On Monad that counts included transactions only.
    pub(crate) pending_nonce: u64,
    /// `eth_getBalance(latest)`.
    pub(crate) balance_wei: u128,
}

/// How far above the payer's pending nonce a payment may sit. A writer's wallet signs the
/// payment inside a transaction set and shuffles it among the set's self-sends (change, split,
/// consolidation) on the same account, in random order, so the payment can follow up to that
/// many of them; they are broadcast by the wallet, in nonce order, only after the relay holds
/// the write. The EVM wallet allows at most 63 self-sends in one set (`maxChangeOutputs <= 63`,
/// checked in `packages/wallet/evm-transaction-set.ts`). A payment further ahead (for example on
/// a stacked successor whose predecessor set has not landed) is `nonce_gap`, which is
/// retryable: it is accepted once the predecessors reach the node.
pub(crate) const PAYMENT_NONCE_WINDOW: u64 = 63;

/// Why the node does not show that a payment can land.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FundingProblem {
    /// Its nonce is below the payer's pending one and the node does not hold it: it can never
    /// land. Definitive.
    StaleNonce,
    /// Its nonce is more than `PAYMENT_NONCE_WINDOW` above the pending one. Retryable.
    NonceGap,
    /// The payer's balance is below its value plus its most gas cost. Retryable.
    InsufficientBalance,
}

impl FundingProblem {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::StaleNonce => "stale_nonce",
            Self::NonceGap => "nonce_gap",
            Self::InsufficientBalance => "insufficient_balance",
        }
    }
}

/// Why `payment` cannot be shown to land, given the payer's account and whether the node already
/// holds the payment itself. `None` when it can: its nonce is in `[pending, pending + window]`
/// and the balance covers its value and gas.
pub(crate) fn judge_funding(
    payment: &VerifiedGroupPayment,
    account: &PayerAccount,
    held: bool,
) -> Option<FundingProblem> {
    if held {
        return None;
    }
    if payment.nonce < account.pending_nonce {
        return Some(FundingProblem::StaleNonce);
    }
    if payment.nonce - account.pending_nonce > PAYMENT_NONCE_WINDOW {
        return Some(FundingProblem::NonceGap);
    }
    let owed = payment.value_wei.saturating_add(payment.max_gas_cost_wei);
    (owed > account.balance_wei).then_some(FundingProblem::InsufficientBalance)
}
