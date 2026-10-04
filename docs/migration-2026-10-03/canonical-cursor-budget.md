# Canonical page cursor accounting clarification

For both R and T, `max_bytes` charges the complete nested multipart body plus the logical next-cursor header when present. Exact cursor charge is ASCII byte length of `x-frank-mailbox-next-cursor` (27), plus `: ` (2), the opaque cursor value bytes, and CRLF (2): **31 + value bytes**. Missing header charges zero. No HTTP status line or unrelated header is included; this fixed logical accounting applies independently of HTTP protocol version.

Enforce before retaining/copying a complete page. A body plus value fitting the budget but body plus full cursor header exceeding it must reject without partial records or cursor advancement. This specifies framing for the already accepted header-size requirement; it introduces no protocol identifier, signature change, directory authority or financial policy.

Separate source verification confirmed LOW omission at T `30299de284284a5969417a58a39392be02cef97d`: only value bytes were charged. Narrow same-contract repair is authorized in existing T claim with exact-fit/one-over tests. R must use the same accounting before route activation.
