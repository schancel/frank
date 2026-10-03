# Relay observability and metrics

Status: design specification. This document defines the safety and interoperability contract for
instrumenting `cashwebd`. It does not make telemetry part of request correctness: a metrics or
analytics outage must not make a relay API unavailable.

## Goals

- Give operators low-cardinality Prometheus metrics for every public relay API.
- Measure chain-proxy HTTP and WebSocket traffic by shared chain identifier, normalized operation,
  authentication class, outcome, quota use, size, and latency.
- Support optional asynchronous OpenTelemetry export for traces and structured analytical events.
- Allow one Collector deployment to route telemetry independently to ClickHouse and to
  Kafka-backed Druid ingestion without adding database clients to request handlers.
- Inspect JSON-RPC envelopes with bounded memory, including when an allowed response is hundreds of
  megabytes.
- Make unsafe cardinality, queue, retry, and memory configurations fail validation at startup.

## Non-goals

- Prometheus is not an event store, audit log, billing ledger, or per-customer request history.
- Telemetry delivery is not guaranteed. Records that must survive a crash belong in a durable
  application journal with an explicit retention policy.
- The relay does not put ClickHouse or Druid query/schema logic in API handlers.
- Request parameters, response results, message bodies, transaction bytes, and wallet identifiers
  are not telemetry.

## Architecture

```text
cashwebd request handlers
  |-- typed, bounded instruments --> in-process Prometheus registry --> scrape
  `-- try_send(structured event/span)
          |-- bounded async OTLP queue --> OpenTelemetry Collector
          |                                |-- ClickHouse exporter
          |                                `-- Kafka exporter --> Druid
          `-- queue full/unavailable --> drop + Prometheus counter
```

Prometheus remains independent of the Collector. The relay updates counters, gauges, and
histograms in process and exposes them on a separately configured administrative listener. OTLP is
optional and must use a non-blocking bounded channel. ClickHouse and Druid fan-out, batching,
durability, and retry policy belong to Collector/deployment configuration, with independent queues
so one unhealthy destination cannot retain or delay the other destination's records.

The same typed instrumentation API covers profiles, messages, private mailbox operations, topics,
peer discovery, proof-of-payment, JSON-RPC, Chronik, and future API families. Common HTTP middleware
records transport-level measurements; handlers add domain outcomes that middleware cannot infer.

## Configuration

The relay configuration should expose only its local Prometheus and OTLP behavior. Secrets are read
from named environment variables, never literal TOML values.

```toml
[observability]
service_name = "cashwebd"

[observability.prometheus]
enabled = true
host = "127.0.0.1:9090"

[observability.otlp]
enabled = false
endpoint = "http://otel-collector:4317"
protocol = "grpc"
queue_capacity = 8192
batch_size = 512
max_record_bytes = 16384
memory_budget_bytes = 33554432
max_in_flight_batches = 2
flush_interval_ms = 1000
timeout_ms = 3000
retry_max_elapsed_ms = 30000
trace_sample_ratio = 0.01
headers_env = "CASHWEBD_OTLP_HEADERS"
```

`queue_capacity` counts records. Configuration validation must reject zero or unbounded queues,
batches larger than queues, unreasonable timeouts, invalid sampling ratios, a public wildcard
Prometheus bind unless explicitly acknowledged, and estimated telemetry buffers that exceed the
configured telemetry memory budget. That estimate covers queued records, in-flight and retry
batches, serialization buffers, and SDK-owned buffers. Attribute lengths and serialized record size
are bounded; oversized records are dropped before exporter allocation and counted locally.
Disabling observability installs a no-op implementation rather than scattering conditionals through
handlers.

Collector configuration is intentionally separate. A provided deployment example should include:

- a low-cardinality Prometheus remote-write pipeline;
- a ClickHouse pipeline with its own bounded persistent sending queue; and
- a Kafka pipeline whose JSON event schema is consumable by a Druid supervisor.

## Cardinality and privacy contract

Prometheus labels are an allowlist, not arbitrary key/value metadata.

Allowed bounded dimensions include:

| Dimension | Values |
| --- | --- |
| `api_family` | Enumerated families such as `profile`, `mailbox`, `topic`, `json_rpc`, `chronik`, `peer` |
| `chain` | An identifier from the versioned shared chain registry |
| `rpc_method` | A method from that family's server allowlist, plus `batch`, `invalid`, or `other` |
| `route` | A compile-time route template, never the concrete URI |
| `transport` | `http` or `ws` |
| `auth_class` | `anonymous` or `customer` |
| `outcome` | A finite handler-defined enum |
| `status_class` | `1xx`, `2xx`, `3xx`, `4xx`, `5xx`, or `no_response` |
| `broadcast_state` | `none`, `not_attempted`, `unknown`, or `accepted` |
| `quota_class` | A finite configured quota category, never an identity |

The following must never be Prometheus labels or unredacted log fields:

- capability tokens, authorization headers, or secret-bearing URLs;
- customer/profile addresses, public keys, IP addresses, or peer-specific identifiers;
- transaction hashes, block hashes, JSON-RPC IDs, Chronik path parameters, or mailbox cursors;
- raw method names not admitted by a bounded allowlist;
- request parameters, response bodies, error strings from an upstream, or arbitrary client values.

Structured analytical events may carry more dimensions than Prometheus only after a documented
privacy classification and retention decision. Capability tokens, private message material,
credentials, and raw transaction data remain forbidden. Collector processors provide a second
allowlist and aggregation boundary before Prometheus remote write; correctness does not rely on an
operator remembering to configure those processors.

## Required Prometheus instruments

Names may receive a project prefix during implementation, but their meanings and bounded dimensions
must remain stable.

- HTTP request count, request duration, request bytes, and response bytes by route template, API
  family, authentication class, outcome, and status class. Active requests use only dimensions known
  at admission: route template, API family, and authentication class.
- JSON-RPC call count and weighted quota units by family, chain, normalized method, transport,
  authentication class, and outcome. A batch increments one call observation for each validated
  member as well as one transport request observation.
- Upstream queue wait, upstream duration, timeout, rejection, malformed response, and response-size
  limit outcomes by family and chain.
- Quota permitted/denied units by quota class and family; never by customer or source IP.
- Transaction broadcast attempts and ambiguous outcomes by family and chain.
- WebSocket active connections, connection duration, messages, in-flight calls, subscriptions,
  close reason class, and policy-limit rejections.
- Mailbox/profile/topic/peer operation counts and durations using finite domain outcomes.
- OTLP queue depth, enqueued, exported, retried, and dropped events by signal and bounded reason.

Latency uses histograms with repository-wide bucket definitions. Histograms are merged by summing
bucket counts after high-cardinality dimensions are removed; medians or other quantiles are computed
at query time. A median of scalar medians is not an accepted aggregation.

## Streaming JSON-RPC inspection

### Current constraint

The initial proxy implementation bounds bodies but then collects each body and parses it as a full
`serde_json::Value`. Current configuration validation limits EVM responses to 16 MiB and Bitcoin
responses to 32 MiB. Raising those limits to accommodate legitimate large smart-contract or log
responses would make heap use proportional to the complete JSON tree and allow concurrent requests
to multiply that cost.

### Required behavior

JSON-RPC policy enforcement and instrumentation must use an incremental parser over bounded chunks.
It may retain only explicitly bounded envelope fields:

- top-level single-versus-batch shape and bounded batch length;
- `jsonrpc`, a bounded representation of `id`, and an allowlisted `method`;
- only the bounded parameter fields required by policy, such as a log range or fee-history count;
- response success versus error and a bounded numeric error code;
- byte counts and parser/policy outcomes.

All other parameter, result, error-data, and extension values are skipped without constructing a
generic object tree. Method strings, keys, IDs, numeric tokens, nesting depth, and batch member count
have independent limits. Duplicate security-relevant keys are rejected rather than resolved by
parser-specific last-value behavior.

Request policy must be completely validated before any bytes are sent upstream. Requests small
enough for the configured memory threshold may use a bounded memory buffer. If a future family
permits larger requests, the relay must stream them into a bounded temporary spool while parsing,
then stream the validated spool upstream. It must never optimistically forward a transaction or
other side-effecting request before validation completes. Inspection is observational: authentication
hashes the original request bytes, and the validated request forwards those same bytes without JSON
normalization. Temporary spools are removed on every terminal path. Unsupported request content
encodings are rejected rather than ambiguously authenticating one representation and forwarding
another.

Upstream responses are streamed to the client with backpressure while an incremental inspector
processes the JSON-RPC envelope. Inspection and mandatory sanitization complete before the
corresponding bytes reach the client. The relay must enforce its limit on decoded bytes, including
decompressed upstream responses, and enforce total and idle timeouts. It must not buffer or
deserialize a large `result` merely to identify the corresponding method: the validated request
already supplies that association. Batch correlation may retain only the configured bounded number
of IDs and normalized methods. Duplicate request IDs are rejected; unmatched, duplicate, or missing
response IDs produce a deterministic malformed-upstream outcome rather than guessed attribution.

Provider URLs and credentials must not leak through upstream errors. Transport failures and
non-success HTTP responses are normalized before forwarding. HTTP-200 JSON-RPC errors use a bounded
allowlist (for example, numeric code) and replace or discard upstream message, data, and extension
fields before their bytes are committed. If any other successful JSON must be rewritten, rewriting
is token-streamed with bounded token storage; it is never implemented by rebuilding a complete
`Value`. If a malformed, oversized, or timed-out response is discovered after response headers are
committed, the stream terminates and records a non-success outcome instead of attempting to append a
replacement JSON document.

### Proof requirements

Tests must feed the production forwarding pipeline fragmented tokens, deep nesting, oversized
keys/methods/IDs, duplicate fields, malformed trailing input, large skipped parameter/result strings,
many-small-value results, large batches, compressed responses, slow clients, and client/upstream
disconnects. A lazily generated 250 MiB result and smaller comparison sizes must prove a numeric
per-stream peak-live-allocation ceiling independent of payload size across receiving, decompression,
inspection, sanitization, and forwarding. Only a fixed test-harness baseline and explicitly listed
transport overhead may be excluded; the generator and draining client must not materialize the
payload. Tests must also prove that denied or malformed requests send zero upstream bytes and that
cancellation releases parser, spool, and correlation state.

### Relay implementation bounds

The relay's HTTP JSON-RPC response path uses an unlink-on-drop temporary-file spool. Decoded
upstream chunks are admitted under `max_response_bytes`, then a blocking inspector reads through a
64 KiB buffer and retains at most 32 envelope keys, one 256-byte representation per bounded batch
ID, and one rewrite range per response. Delivery uses one 64 KiB read buffer and applies bounded
constant-size error replacements while preserving opaque success bytes. Apart from HTTP-library
transport buffers, live application allocation is therefore bounded by roughly 128 KiB plus the
configured batch metadata and one decoded input chunk, independent of result size. Aggregate spool
disk is bounded by `max_concurrency * max_response_bytes`; both values are finite, validated
configuration, and enabled family budgets are checked together against one 2 GiB process ceiling.
The hard EVM per-response configuration ceiling is 512 MiB; the Bitcoin/Chronik family retains its
32 MiB ceiling.

`production_pipeline_streams_250_mib_result_without_materializing_it` is the intentionally ignored
large-fixture proof: its upstream generator reuses a 64 KiB chunk, its client counts chunks without
collecting them, and it traverses the production router, decoded-byte spool, inspector, rewrite
adapter, and response-permit lifetime. Run it explicitly when changing any of those layers.

## Reliability and rollout

- Telemetry recording must not hold an application database lock or an upstream concurrency permit.
- Each asynchronous exporter has independent bounded, non-blocking admission and a finite retry
  policy. The pinned Collector topology must prove that a full, unavailable, or storage-failed sink
  cannot stall delivery to another sink sharing the receiver; affected records are dropped or
  rejected promptly and retry-induced duplication is documented.
- Queue exhaustion drops telemetry and increments a local Prometheus counter; it does not await
  capacity on the request path.
- Collector self-metrics and container memory must be scraped and alerted independently.
- Collector examples include a memory limiter before batching, explicit queue bounds, and container
  headroom. A Collector restart or OOM must not affect relay readiness.
- Per-instrument label sets, histogram buckets, and a repository-wide maximum Prometheus series
  budget are checked in tests; a finite value vocabulary alone is not sufficient.
- WebSocket parsing applies the same limits across fragmented messages and bounds pending request
  IDs, active subscriptions, and per-connection buffered bytes. Close, timeout, and cancellation
  release all state.
- Operators can enable Prometheus first, then OTLP, then individual warehouse sinks. Each stage has
  an independent rollback switch.

## Related protocol work

The chain proxy and capability-URL/WebSocket contract is tracked by issue #383. This observability
spec applies to that proxy and to the relay's existing APIs. The implementation ticket for this
document should remain independently deployable so API work does not create a hard runtime
dependency on a Collector, ClickHouse, Druid, or Kafka.
