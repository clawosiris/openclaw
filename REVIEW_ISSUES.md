# Review Issues - Matrix Thread Session Isolation

Reviewed by Opus 4.6 on 2026-03-08

## Critical (1)

### 1. No E2EE (encryption) consideration for thread bindings
**Document:** Both

Neither document mentions Matrix end-to-end encryption (E2EE). Many Matrix rooms use E2EE, which affects how the bot reads `m.relates_to` content (it's inside the encrypted payload). If the Matrix SDK isn't handling decryption before thread extraction, `resolveMatrixThreadRootId()` will fail silently in encrypted rooms.

**Fix:** Add E2EE considerations section. Confirm SDK decrypts before event handling, document decryption failure behavior, add E2EE test scenarios.

---

## High (4)

### 2. Thread root event ID stability after redaction is assumed but not verified
**Document:** Both

Documents assume the `event_id` in `m.relates_to` remains stable after redaction but don't verify this. Some homeserver implementations may strip thread aggregation bundles for redacted roots.

**Fix:** Verify via Synapse docs/testing that `m.relates_to` references to redacted roots remain intact in sync responses.

### 3. Persistence format and crash recovery not specified
**Document:** OpenSpec

No persistence mechanism specified. What's the file path? Serialization format? Write strategy? Crash recovery behavior?

**Fix:** Add persistence subsection: file path (`matrix/thread-bindings.json`), atomic write (write-tmp + rename), startup reload, corruption recovery.

### 4. Race condition between binding creation and first routed message
**Document:** Both

Window between spawn request and binding creation. If user sends follow-up during this window, it routes via suffix fallback to a different session key — split-brain scenario.

**Fix:** Document the race. Consider synchronous binding creation before spawn ack, or "pending bind" state that queues routing decisions.

---

## Medium (9)

### 5. `conversationId` separator collision risk
Uses `#` as separator in `<roomId>#<threadRootId>`. Could conflict with shell expansion or URL fragments.

**Fix:** Use safer separator like `||` or structured tuple object.

### 6. No consideration of Matrix Spaces and room hierarchy
Matrix Spaces not mentioned. Should explicitly state out of scope with rationale.

### 7. Missing handling for thread fallback reply chains (pre-MSC3440 clients)
Older clients/bridges may use `m.in_reply_to` without `m.thread` relation. These won't be detected as threaded.

**Fix:** Document limitation or consider reply-chain fallback detection.

### 8. No rate limiting or binding count cap
No limit on active bindings. Runaway scenario could create unbounded records.

**Fix:** Add configurable `maxActiveBindings` cap.

### 9. Sweep timer lifecycle not specified
Sweep interval, timer vs event-based, lifecycle management not specified.

**Fix:** Specify periodic timer (60s), started with monitor init, non-blocking bounded iteration.

### 10. Thread suffix normalization migration path is hand-waved
"Fallback compatibility" mentioned but no concrete strategy.

**Fix:** Define dual-lookup strategy (normalized first, then raw). Add config flag for migration window.

### 11. No logging/observability requirements specified
"Auditable through logs" mentioned but no specific log points defined.

**Fix:** Specify key log events with structured fields (binding created/resolved/expired/removed).

### 12. Complement test harness setup details are thin
Complement is Go-based for homeserver testing. Impedance mismatch with TypeScript app testing not addressed.

**Fix:** Clarify approach: use Complement's Docker provisioning but write tests in Node.js/TypeScript.

### 13. No consideration of federated rooms
Federation lag could cause binding lookups to fail (thread root not yet visible).

**Fix:** Add federation considerations section.

### 14. Hook registration order and error handling not specified
What if hook registration fails? What if hook handler throws during spawn?

**Fix:** Specify registration timing, error handling (non-fatal, proceed room-scoped).

---

## Low (1 - truncated)

### 15. Missing consideration of edited messages
Matrix message edits (`m.replace` relation) need correct thread resolution handling.
