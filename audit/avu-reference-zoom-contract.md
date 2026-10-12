# AVU reference zoom — Tier 2

Base ac340b63; isolated from frozen price-history candidate 53c11388.

The /avu page owns presentation of existing oracle observations. Add pointer drag selection snapped to actual visible observation timestamps, including touch, shared zoom for both USD-per-AVU curves, reset and range-change clearing. Keep selection inside the plot; cancel interruptions; ignore singleton/empty selections. Labels follow actual visible span, with at most two bounded endpoint labels. Preserve a trailing 30-day hourly request alongside coarse broad ranges so newly available history remains selectable. Request bounded finer history for the selected interval through the existing read-only oracle history capability. Preserve gaps, singleton points, current-price cards and existing monetary calculations. No persisted/wire changes, generated data, formula or invented historical points.

Acceptance: actual pointer events select/reverse/reset/cancel; range change resets; one point cannot zoom; mobile-coordinate scaling and out-of-bounds clamping; short-span labels show time; both curves remain on one axis. Focused page tests, typecheck and scoped lint/format only after parent slot grant. Scientific/Gold findings are evidence and proposals, not formula/feed implementation authorization.

Verification: page suite 12 PASS. Four positive interaction/label regressions FAIL against the unchanged base page, then all 12 PASS after restoring the candidate (audit/avu-reference-zoom-fail-before.log). Scoped ESLint: zero errors, three existing test-style warnings; Prettier source/test/two documents PASS. Broad typecheck belongs to combined integration, not repeated here. No browser or live feed inspection.
