# Monad testnet mail host

The executable is `yarn --cwd packages/mail-gateway start`. It refuses startup unless the existing Monad testnet wallet and journal pass read-only identity and format admission. First-run provisioning is a separate explicit operator action; restarting this command never generates wallet roots, resets wallet state, or creates a missing journal. Keep a single writable wallet owner and persist the complete wallet, journal, blob, and directory volumes together.

The host reads the following nonsecret environment variables:

| Variable | Meaning |
| --- | --- |
| `FRANK_MAIL_WALLET_STATE_DIR` | Absolute wallet-state base directory; wallet appends its account suffix. |
| `FRANK_MAIL_ROOTS_FILE` | Absolute 0400/0600 regular roots file; see `HOST-WALLET.md`. |
| `FRANK_MAIL_EXPECTED_IDENTITY` | Expected public gateway EVM identity. |
| `FRANK_MAIL_JOURNAL_FILE` | Absolute SQLite mail journal file. |
| `FRANK_MAIL_BLOB_DIR` | Absolute mail blob directory. |
| `FRANK_MAIL_DIRECTORY_DIR` | Absolute durable directory-cache directory. |
| `FRANK_MAIL_GATEWAY_DOMAIN` | Exact email domain, such as `signet.mx`. |
| `FRANK_MAIL_RELAY_URL` | HTTPS Frank relay base URL. |
| `FRANK_MAIL_RESEND_API_KEY_FILE` | Absolute 0400/0600 regular file containing the Resend API key. |
| `FRANK_MAIL_RESEND_WEBHOOK_SECRET_FILE` | Absolute 0400/0600 regular file containing the Resend webhook signing secret. |
| `FRANK_MAIL_RESEND_RAW_ORIGINS` | Comma-separated exact HTTPS origins allowed for raw MIME retrieval. |
| `FRANK_MAIL_STAMP_WEI` | Explicit unsigned base-unit stamp intent for newly admitted inbound mail. |
| `FRANK_MAIL_WEBHOOK_HOST` | Local HTTP bind address. |
| `FRANK_MAIL_WEBHOOK_PORT` | Local HTTP port. |
| `FRANK_MAIL_POLL_MS` | Positive recovery interval in milliseconds. |
| `FRANK_MAIL_JOURNAL_MODE` | `existing` by default; `provision` is an explicit one-time journal operation only. |

The secret files must be regular files, not Kubernetes projected Secret symlinks. A memory-backed copy with owner-only permissions is suitable. Do not place raw secrets in the environment, image, repository, or Terraform variables. The Monad wallet talks through the selected HTTPS relay's chain RPC route; the mail pod does not need an authenticated upstream RPC URL.

After wallet and journal admission, the host publishes its canonical directory identity, completes a recovery pass, and then listens for signed `POST /webhooks/resend` events. `GET /healthz` returns 200 only while this listener is active and the latest recovery pass succeeded. On startup failure, recovery failure, or shutdown it is unavailable or returns 503. An accepted webhook is acknowledged only after durable journal admission; background recovery and SMTP evidence continue on a nonoverlapping timer. Transient recovery failures are logged and retried without authorizing fresh payment. The Resend inbound adapter is the current deployment path; direct SMTP remains a supported gateway interface but is not wired to this executable until it uses the same durable journal.

The gateway is restricted to Monad testnet. Its wallet admission does not detect rollback of an older valid bound wallet snapshot, so this host is not approved for mainnet funds. No live credentials, wallet roots, or funded identity are supplied by the repository.
