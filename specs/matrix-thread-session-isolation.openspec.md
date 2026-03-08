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
  - `conversationId = "<roomId>#<threadRootId>"`
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

### 3.2 Non-Functional Requirements

1. Backward compatibility
- Existing Matrix thread behavior (suffix-based isolation) must continue working when explicit bindings are disabled or absent.
- No regressions for Matrix DM routing.
- No regressions for non-thread room routing.

2. Determinism and correctness
- Session key derivation and binding lookup must be deterministic across restarts.
- Routing decisions must be auditable through logs/tests.

3. Safety and resiliency
- Malformed or partial `m.relates_to` payloads must fail safe (no crash, no incorrect cross-thread bind).
- Redacted roots/messages must not break thread identity resolution when root event id is present.

4. Performance
- Binding lookup must be constant/near-constant by conversation key and by session key.
- TTL sweeps must be bounded and not block inbound message handling.

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

At account override level:

- `channels.matrix.accounts.<id>.threadBindings.enabled`
- `channels.matrix.accounts.<id>.threadBindings.idleHours`
- `channels.matrix.accounts.<id>.threadBindings.maxAgeHours`
- `channels.matrix.accounts.<id>.threadBindings.spawnSubagentSessions`
- `channels.matrix.accounts.<id>.threadBindings.spawnAcpSessions`

### 5.2 Behavior Changes

- Spawned session routing in Matrix threads now uses explicit binding precedence over derived suffix-only routing.
- `threadRequested` spawn from non-thread room context fails with clear operator-facing error.
- Completion delivery target for bound sessions is resolved through `subagent_delivery_target` hook with explicit thread id.

### 5.3 Compatibility and Migration

- No config breaking changes.
- Existing thread suffix sessions remain valid fallback path.
- If suffix normalization changes session key format, fallback compatibility must preserve access to existing thread sessions where possible.

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

3. Real homeserver E2E (Complement-first strategy)
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

4. CI artifact expectations for E2E failures
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
