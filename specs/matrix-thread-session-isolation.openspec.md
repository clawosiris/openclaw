---
summary: "Implement Matrix per-thread session isolation with explicit thread bindings and subagent lifecycle parity with Discord"
read_when:
  - Implementing Matrix thread-bound subagent or ACP session routing
  - Refactoring Matrix session key derivation and thread reply delivery
  - Adding channel-agnostic session binding adapters
owner: "openclaw"
status: "draft"
last_updated: "2026-03-08"
title: "Matrix Thread Session Isolation OpenSpec"
---

# Matrix Thread Session Isolation OpenSpec

## 1. Title and Summary

This OpenSpec defines how to implement per-thread session isolation for Matrix by adding explicit thread binding lifecycle support, routing overrides, and spawned-session delivery targeting.

The feature keeps current Matrix thread suffix routing as compatibility fallback while introducing Discord-parity behavior for spawned subagent/ACP sessions: bind to thread context, route follow-up messages to the bound session, deliver completions back to the same thread, and clean up bindings on end/expiry.

## 2. Motivation and Problem Statement

Matrix currently supports thread-aware routing only through derived session key suffixes (`:thread:<threadRootId>`). That is sufficient for passive thread separation, but insufficient for robust spawned-session lifecycle handling because:

- there is no explicit binding record for spawned subagent/ACP sessions in Matrix
- the Matrix plugin does not register subagent hooks (`subagent_spawning`, `subagent_delivery_target`, `subagent_ended`)
- no Matrix-specific binding state manager exists for TTL, lifecycle cleanup, or recovery
- completion delivery targeting lacks explicit thread-bound origin resolution

As a result, Matrix does not match Discord’s proven thread-binding model, especially for multi-turn spawned sessions, deterministic delivery targeting, and cleanup guarantees.

## 3. Detailed Requirements

### 3.1 Functional Requirements

1. Thread-scoped binding model
- Introduce Matrix thread binding records keyed by Matrix account, room, and thread root event.
- Binding identity must include `accountId`, `roomId`, and `threadRootId` to prevent cross-account and cross-room collisions.
- Binding records must include:
  - `bindingId`
  - `accountId`
  - `roomId`
  - `threadRootId`
  - `targetKind` (`subagent` | `acp`)
  - `targetSessionKey`
  - `boundAt`
  - `lastActivityAt`
  - `idleTimeoutMs`
  - `maxAgeMs`
  - optional metadata (`agentId`, label, boundBy)

2. Session binding service integration
- Register a Matrix adapter with the shared session binding service.
- Conversation ref for threaded Matrix context must map to:
  - `conversationId = "<roomId>||<threadRootId>"`
  - `parentConversationId = "<roomId>"`
- Conversation refs for non-thread room traffic remain room-scoped.
- DM behavior remains unchanged.

3. Matrix subagent hook registration
- Add Matrix hook module and register it in `extensions/matrix/index.ts`.
- Implement handlers for:
  - `subagent_spawning`: bind spawned session to current thread context when thread spawn is requested and allowed.
  - `subagent_delivery_target`: resolve bound thread origin (room + thread id) for completion delivery.
  - `subagent_ended`: unbind thread bindings for ended target session.

4. Inbound route resolution precedence
- In Matrix inbound handler, resolve route in this order:
  1. base route from existing room/DM logic
  2. explicit binding lookup for current conversation ref
  3. if binding exists, override session key with `targetSessionKey`
  4. otherwise apply deterministic thread suffix fallback (for threaded room messages only)
- This must preserve backward compatibility with existing thread suffix sessions when no explicit binding exists.

5. Thread suffix normalization
- Replace raw `threadRootId` suffix interpolation with normalized/encoded form.
- New helper must produce deterministic, collision-resistant, storage-safe suffixes for long or symbol-heavy event IDs.
- Existing persisted sessions must remain readable by fallback compatibility logic (see migration compatibility requirement).

6. Outbound delivery targeting
- Completion delivery for bound spawned sessions must return to the originating room/thread context.
- Outbound messages targeting bound thread sessions must include Matrix thread relation (`m.relates_to.rel_type = m.thread`) with the correct `threadRootId`.

7. Lifecycle cleanup
- Unbind on explicit spawned session end events.
- Add periodic or invoked sweep for idle and max-age expiration.
- Sweep logic must avoid deleting recently touched bindings in race windows.

8. Non-thread spawn behavior
- If thread session spawn is requested from non-thread room context, default behavior is strict error (no implicit room-scope bind), unless a future explicit fallback mode is added.

9. Multi-account isolation
- Binding resolution must always include normalized account scope.
- Two bot accounts in same room/thread namespace must never resolve each other’s bindings.

10. E2EE (end-to-end encryption) considerations
- The Matrix SDK must decrypt events before thread relation extraction. `resolveMatrixThreadRootId()` operates on decrypted event content; if the SDK has not decrypted the event, `m.relates_to` will be absent from the plaintext payload.
- If decryption fails (missing keys, unverified session, Olm/Megolm errors), the handler must treat the message as non-threaded (room-scoped fallback) and log a structured warning (`matrix.thread.decryption_failed`).
- The bot's device must be verified and have access to room key history for thread binding to function in E2EE rooms. Document this as an operator prerequisite.
- Thread bindings themselves (the binding records) are not encrypted; they contain only event IDs and session keys, not message content.

11. Persistence
- Binding state must be persisted to `<dataDir>/matrix/thread-bindings.json`.
- Write strategy: atomic write via write-to-temp-file + `fs.rename()` to prevent corruption on crash.
- On startup, reload bindings from the persisted file. If the file is missing, start with empty state. If the file is corrupt (invalid JSON), log an error (`matrix.thread.persistence_corrupt`), rename the corrupt file to `thread-bindings.json.corrupt.<timestamp>`, and start with empty state.
- Persist after every binding mutation (create, touch, unbind, sweep). Debounce writes to at most once per second to avoid I/O pressure from rapid touch updates.

12. Race condition mitigation for binding creation
- A race window exists between when a spawn request is received and when the binding record is created. If the user sends a follow-up message during this window, it may route via suffix fallback to a different session key, causing split-brain.
- Mitigation: create the binding record synchronously (in-memory) during the `subagent_spawning` hook, before returning the spawn acknowledgment. Persistence can be async/debounced, but the in-memory binding must be visible to the routing path immediately.
- If synchronous bind is not feasible, implement a "pending bind" state: the routing path must check for pending binds and queue routing decisions (hold the message for up to 2 seconds) until the bind completes or times out.

13. Thread root event ID stability after redaction
- Matrix spec (room version 11+): `m.relates_to` references in child events are preserved even after the root event is redacted. The `event_id` referenced in `rel_type: m.thread` remains stable.
- Synapse behavior (verified): redacting a thread root does not strip `m.relates_to` from existing child events in sync responses. New replies to a redacted root still carry the original `event_id` in their thread relation.
- Edge case: if a homeserver implementation strips thread aggregation bundles for redacted roots, thread resolution falls back to room-scoped routing. This is acceptable degraded behavior.
- Test requirement: E2E test must verify that messages sent after root redaction still resolve to the same thread binding.

14. `maxActiveBindings` rate limiting
- Add configurable `maxActiveBindings` per account (default: 100).
- When the limit is reached, new spawn requests return an operator-facing error ("thread binding limit reached for account <id>").
- Config key: `channels.matrix.threadBindings.maxActiveBindings: number` (and per-account override).
- Bindings approaching the limit (>80%) should log a warning (`matrix.thread.bindings_near_limit`).

15. Hook registration order and error handling
- Matrix subagent hooks must be registered during plugin `init()`, after the Matrix monitor is initialized but before the first sync event is processed.
- If hook registration fails (e.g., binding service unavailable), log a non-fatal error (`matrix.thread.hook_registration_failed`) and proceed with room-scoped routing only. Thread binding features are degraded but the plugin remains functional.
- If a hook handler throws during execution (e.g., `subagent_spawning` handler error), catch the error, log it (`matrix.thread.hook_handler_error`), and fall back to room-scoped behavior for that message. Do not crash or reject the inbound message.

### 3.2 Non-Functional Requirements

1. Backward compatibility
- Existing Matrix thread behavior (suffix-based isolation) must continue working when explicit bindings are disabled or absent.
- No regressions for Matrix DM routing.
- No regressions for non-thread room routing.

2. Determinism and correctness
- Session key derivation and binding lookup must be deterministic across restarts.
- Routing decisions must be auditable through structured logs (see logging requirements below).

3. Safety and resiliency
- Malformed or partial `m.relates_to` payloads must fail safe (no crash, no incorrect cross-thread bind).
- Redacted roots/messages must not break thread identity resolution when root event id is present.

4. Performance
- Binding lookup must be constant/near-constant by conversation key and by session key.
- TTL sweeps must be bounded and not block inbound message handling.

5. Sweep timer lifecycle
- Sweep runs on a periodic `setInterval` timer with a default interval of 60 seconds.
- Timer is started during monitor initialization and cleared on monitor shutdown/dispose.
- Each sweep iteration is bounded: iterate all bindings, check idle/max-age, remove expired. Must not block the event loop; use synchronous in-memory iteration (binding count is bounded by `maxActiveBindings`).
- Sweep must be non-reentrant: if a previous sweep is still running (e.g., slow persistence write), skip the current tick.

6. Logging and observability
- All log events use structured fields and the `matrix.thread` namespace prefix.
- Required log events:
  - `matrix.thread.binding_created` — fields: `accountId`, `roomId`, `threadRootId`, `targetKind`, `targetSessionKey`, `activeCount`
  - `matrix.thread.binding_resolved` — fields: `accountId`, `roomId`, `threadRootId`, `targetSessionKey`
  - `matrix.thread.binding_expired` — fields: `accountId`, `roomId`, `threadRootId`, `reason` (`idle` | `max_age`), `age_ms`
  - `matrix.thread.binding_removed` — fields: `accountId`, `roomId`, `threadRootId`, `reason` (`session_ended` | `expired` | `manual`)
  - `matrix.thread.route_override` — fields: `accountId`, `roomId`, `threadRootId`, `fromKey`, `toKey`
  - `matrix.thread.suffix_fallback` — fields: `accountId`, `roomId`, `threadRootId`, `derivedKey`
  - `matrix.thread.decryption_failed` — fields: `accountId`, `roomId`, `eventId`, `error`
  - `matrix.thread.persistence_corrupt` — fields: `path`, `error`
  - `matrix.thread.hook_registration_failed` — fields: `hookName`, `error`
  - `matrix.thread.hook_handler_error` — fields: `hookName`, `error`, `accountId`, `roomId`
  - `matrix.thread.bindings_near_limit` — fields: `accountId`, `activeCount`, `maxActiveBindings`
- Log levels: `binding_created`, `binding_resolved`, `route_override`, `suffix_fallback` at `debug`; `binding_expired`, `binding_removed` at `info`; error events at `warn` or `error`.

7. Federation considerations
- In federated rooms, thread root events may arrive with delay due to federation lag. If a message references a thread root that the bot's homeserver has not yet received, thread resolution will fail and the message routes as room-scoped.
- This is acceptable degraded behavior: once the thread root event arrives via federation, subsequent messages will resolve correctly.
- Binding creation requires the thread root event to be visible to the bot's homeserver. If a spawn request references an unknown thread root, the spawn should fail with a clear error rather than creating a dangling binding.
- No special retry or backfill logic is required; federation convergence is expected to resolve within seconds for well-connected homeservers.

## 4. Implementation Scope

### 4.1 Files to Create

- `extensions/matrix/src/subagent-hooks.ts`
- `extensions/matrix/src/matrix/monitor/thread-bindings.types.ts`
- `extensions/matrix/src/matrix/monitor/thread-bindings.state.ts`
- `extensions/matrix/src/matrix/monitor/thread-bindings.manager.ts`
- `extensions/matrix/src/matrix/monitor/thread-bindings.lifecycle.ts`
- `extensions/matrix/src/matrix/monitor/thread-session-key.ts` (or equivalent helper module for suffix normalization)

### 4.2 Files to Modify

- `extensions/matrix/index.ts`
  - Register Matrix subagent hooks.
- `extensions/matrix/src/matrix/monitor/index.ts`
  - Initialize Matrix binding manager/adapter at startup.
- `extensions/matrix/src/matrix/monitor/handler.ts`
  - Add binding-first route override behavior and normalized suffix fallback.
- `extensions/matrix/src/matrix/monitor/threads.ts`
  - Reuse thread root extraction contracts and ensure compatibility with normalization helper.
- `extensions/matrix/src/matrix/send.ts` and/or outbound monitor delivery modules
  - Ensure delivery path includes room + thread relation from resolved target.
- `extensions/matrix/src/types.ts`
  - Add `threadBindings` config types.
- `extensions/matrix/src/config-schema.ts`
  - Add Matrix `threadBindings.*` schema.
- `src/config/zod-schema.providers-core.ts`
  - Wire provider-level Matrix thread binding config.
- `src/config/schema.help.ts`
  - Add help text for new Matrix thread binding keys.
- `src/config/schema.labels.ts`
  - Add labels for new Matrix thread binding keys.

### 4.3 Optional/Conditional Integration Points

- `src/channels/thread-bindings-policy.ts`
  - Reuse policy resolution behavior and global fallback from `session.threadBindings.*`.
- Shared session binding adapter registration module(s)
  - If central registration exists, add Matrix adapter integration there instead of only extension-local wiring.

## 5. API and Config Changes

### 5.1 New Matrix Config Keys

At channel level:

- `channels.matrix.threadBindings.enabled: boolean`
- `channels.matrix.threadBindings.idleHours: number`
- `channels.matrix.threadBindings.maxAgeHours: number`
- `channels.matrix.threadBindings.spawnSubagentSessions: boolean`
- `channels.matrix.threadBindings.spawnAcpSessions: boolean`
- `channels.matrix.threadBindings.maxActiveBindings: number` (default: 100)

At account override level:

- `channels.matrix.accounts.<id>.threadBindings.enabled`
- `channels.matrix.accounts.<id>.threadBindings.idleHours`
- `channels.matrix.accounts.<id>.threadBindings.maxAgeHours`
- `channels.matrix.accounts.<id>.threadBindings.spawnSubagentSessions`
- `channels.matrix.accounts.<id>.threadBindings.spawnAcpSessions`
- `channels.matrix.accounts.<id>.threadBindings.maxActiveBindings`

### 5.2 Behavior Changes

- Spawned session routing in Matrix threads now uses explicit binding precedence over derived suffix-only routing.
- `threadRequested` spawn from non-thread room context fails with clear operator-facing error.
- Completion delivery target for bound sessions is resolved through `subagent_delivery_target` hook with explicit thread id.

### 5.3 Compatibility and Migration

- No config breaking changes.
- Existing thread suffix sessions remain valid fallback path.
- Suffix normalization migration uses a dual-lookup strategy:
  1. On routing, first look up the session key using the new normalized suffix.
  2. If no session is found, look up using the raw (pre-normalization) suffix.
  3. If found via raw suffix, optionally migrate: create an alias or copy the session under the normalized key.
- The dual-lookup window is controlled by a config flag `channels.matrix.threadBindings.legacySuffixLookup: boolean` (default: `true`). Set to `false` once migration is complete to disable raw suffix fallback.
- The `conversationId` separator is `||` (pipe-pipe), chosen to avoid conflicts with `#` (shell expansion, URL fragments) and `:` (already used in Matrix identifiers). Example: `!roomId:server.org||$eventId:server.org`.

## 6. Test Requirements

Follow the Matrix E2E strategy from `MATRIX_THREAD_SESSIONS_ANALYSIS.md`:

1. Unit tests
- Binding manager CRUD and sweep behavior:
  - bind/list/resolve/touch/unbind
  - idle expiry
  - max-age expiry
  - touch-vs-sweep race boundary
- Thread suffix normalization:
  - deterministic output
  - special characters (`:`, `$`, `!`, `/`)
  - long root IDs
- Hook behavior:
  - `subagent_spawning` bind success/failure
  - strict non-thread spawn error
  - `subagent_delivery_target` returns correct room+thread target
  - `subagent_ended` cleanup

2. Integration tests (Matrix plugin level)
- Inbound route override prefers explicit thread binding target session.
- No binding present => suffix fallback path used.
- Outbound completion for bound sessions includes correct Matrix thread relation.
- DM and non-thread room flows remain unchanged.

3. E2EE-specific tests
- Unit: verify `resolveMatrixThreadRootId()` returns `undefined` when event content is still encrypted (undecrypted payload).
- Unit: verify decryption failure triggers room-scoped fallback and logs `matrix.thread.decryption_failed`.
- Integration: in an E2EE room, verify thread binding creation and routing work correctly after SDK decryption.
- Integration: verify that a message with decryption failure does not create a binding or corrupt existing bindings.

4. Real homeserver E2E (Complement-based strategy)
- Complement provides Docker-based Synapse provisioning for reproducible homeserver environments.
- Tests are written in TypeScript (not Go): use Complement's Docker provisioning to stand up homeservers, then drive tests via the matrix-js-sdk from Node.js/TypeScript test runners (Vitest).
- Test harness responsibilities: start Synapse container(s), register test users, create rooms/threads, run assertions, tear down containers.
- Required PR fast lane scenarios:
  - thread key derivation determinism
  - bound routing override
  - completion delivery to correct thread
  - cleanup on end
- Extended/nightly scenarios:
  - idle/max-age expiry
  - multi-account isolation
  - malformed relation and redaction edge cases
  - out-of-order event convergence
  - thread root redaction followed by new replies (binding stability)
  - federated room thread binding (two homeservers, federation lag)
  - E2EE room thread binding lifecycle

5. CI artifact expectations for E2E failures
- capture OpenClaw logs
- capture homeserver logs
- capture room/thread event timeline used by assertions

## 7. Acceptance Criteria

1. Spawned session created from Matrix thread binds to `(accountId, roomId, threadRootId)` and persists binding record.
2. Follow-up messages in that thread route to the bound `targetSessionKey`.
3. Completion messages for bound spawned session are emitted into the same room/thread relation.
4. Ending the spawned session removes binding and future thread traffic follows normal routing.
5. Idle and max-age expiration remove stale bindings without deleting recently touched bindings.
6. Non-thread spawn request with thread binding requirement returns explicit error.
7. DM and non-thread room behavior remains unchanged from pre-feature baseline.
8. Multi-account test proves no binding crossover for same room/thread ids.
9. Unit/integration/E2E tests described above are implemented and green in CI lanes.

## 8. Out of Scope and Future Work

- Automatic room-scoped fallback mode for threadRequested spawn outside threads.
- Full migration tooling for converting historical suffix-only sessions into explicit binding records.
- Protocol-level changes beyond current Matrix thread relation usage.
- New channel implementations beyond Matrix in this spec.
- Additional ACP runtime architecture changes unrelated to Matrix binding integration.
- **Matrix Spaces:** Space hierarchy and room relationships (MSC1772) are out of scope. Thread bindings operate at the individual room level; a room's membership in a Space does not affect binding behavior. Space-aware routing may be considered in future work.
- **Pre-MSC3440 reply chains:** Older clients and bridges that use `m.in_reply_to` without `m.thread` relation type will not be detected as threaded messages. These messages route as room-scoped. This is a known limitation; adding reply-chain fallback detection is deferred to future work as it introduces ambiguity (a reply chain is not necessarily a thread).

## 9. References

Primary analysis:

- `MATRIX_THREAD_SESSIONS_ANALYSIS.md`

Related implementation references mentioned in analysis:

- `src/infra/outbound/session-binding-service.ts`
- `extensions/discord/src/subagent-hooks.ts`
- `src/discord/monitor/thread-bindings.lifecycle.ts`
- `src/discord/monitor/thread-bindings.manager.ts`
- `src/discord/monitor/message-handler.preflight.ts`
- `extensions/matrix/src/matrix/monitor/handler.ts`
- `extensions/matrix/src/matrix/monitor/threads.ts`
- `extensions/matrix/src/matrix/monitor/events.ts`
