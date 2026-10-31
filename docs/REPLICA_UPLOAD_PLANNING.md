# Exact upload sizing without repeated batch encoding

The producer now uses `lib/replica-upload-plan.mjs` to plan uploads after the
existing source validation. It encodes each partition once and sums the exact
UTF-8 bytes of the JSON envelope, file objects and comma separators. This
removes repeated encoding of a growing batch. The optional `reuseUnchanged`
field is included in the budget; previously a tightly packed batch could
exceed the server limit after this field was added by the transport.

The 35-file cap, ordinary/catalog budgets, partition contents, original order,
hash checks, checkpoint/resume validation, gzip and server-side storage reuse
remain in force. Tight batches may split differently and therefore safely
invalidate an older checkpoint under the existing batch-hash check. Other
batches retain their exact hashes. No network or database calls occur in the
planner. Collection and publication do not invoke language models.

## Verification

- Six packing tests cover escaped multibyte text, envelope boundary overflow,
  catalog isolation, file limits, streaming input, order, hashes, immutable
  input and sanitized errors. Related sync, publisher and recovery tests also
  pass: 70 tests in four files, independently in source and runtime directories.
- An offline audit read 11,767 real staging partitions (344,167,846 bytes),
  verified every source checksum, and matched 338 complete source-prefix batch
  hashes against the existing publication checkpoint. The final 18 source
  files were excluded from checkpoint comparison because derived summary/date
  sidecars can extend that batch. This is not a claim that all 343 checkpoint
  batches were reconstructed.
- A 120-file, 13,020,209-byte sample produced identical old/new batches. Three
  alternating timed runs gave median planning times 664.643 ms (old) and
  16.802 ms (new). These are local planning CPU measurements, not whole publish
  latency or network savings.

The full-body upload protocol is unchanged. A separate adjacent-generation
audit found most bytes differed only in the generation timestamp; existing
server-side reuse avoids redundant storage, but full bodies still travel over
the network. A compact upload protocol needs separate implementation and
end-to-end validation.

This publisher change does not repair upstream collection access. Daily
acceptance still requires independent follower and profile-total-like
observations, per-work like observations, and exact work IDs/publication dates
with sufficient publication coverage. Profile success is not work success;
missing observations are not zero or proof of no publication.
