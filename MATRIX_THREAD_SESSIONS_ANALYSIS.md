# Matrix Per-Thread Session Isolation Analysis

## 1) Codebase Structure (brief)

OpenClaw is a monorepo with these relevant layers:

- `src/`: core runtime, routing, session persistence, shared channel infra, plugin runtime, and built-in channel implementations.
- `extensions/*`: channel plugins and optional integrations loaded through the plugin system.
  - `extensions/discord`: Discord plugin wrapper + channel registration + subagent thread-binding hooks.
  - `extensions/matrix`: Matrix plugin implementation (monitoring, routing, send, actions, onboarding).
- `src/plugin-sdk/*`: curated exports used by extensions (many extension imports are thin facades into `src/*`).
- `src/infra/outbound/session-binding-service.ts`: generic conversation↔session binding abstraction used by Discord thread bindings.
- `src/routing/*`: session key and agent route resolution.

Practical implication: `extensions/discord` appears small, but it delegates most thread/session behavior to core modules via `openclaw/plugin-sdk/discord` exports.

---

## 2) Deep Dive: How Discord Implements Per-Thread Session Isolation

## 2.1 Where logic lives

- Extension entry:
  - `extensions/discord/index.ts`
  - Registers channel plugin and `registerDiscordSubagentHooks(api)`.
- Extension hooks:
  - `extensions/discord/src/subagent-hooks.ts`
- Core thread binding system (used via plugin-sdk):
  - `src/discord/monitor/thread-bindings.lifecycle.ts`
  - `src/discord/monitor/thread-bindings.manager.ts`
  - `src/discord/monitor/thread-bindings.state.ts`
  - `src/discord/monitor/message-handler.preflight.ts`
  - `src/discord/monitor/route-resolution.ts`
  - `src/discord/monitor/reply-delivery.ts`
- SDK bridge export:
  - `src/plugin-sdk/discord.ts`

## 2.2 How threads are detected and tracked

Inbound thread detection:

- In preflight, Discord resolves whether inbound is from a thread channel:
  - `resolveDiscordThreadChannel(...)` in `src/discord/monitor/threading.ts`
  - Called by `preflightDiscordMessage(...)` in `src/discord/monitor/message-handler.preflight.ts`
- Parent channel metadata is resolved with:
  - `resolveDiscordThreadParentInfo(...)`

Thread binding state tracking:

- In-memory + persisted registries keyed by account/thread/session:
  - `BINDINGS_BY_THREAD_ID`, `BINDINGS_BY_SESSION_KEY` in `src/discord/monitor/thread-bindings.state.ts`
- Persisted file path:
  - `resolveThreadBindingsPath()` => state dir under `discord/thread-bindings.json`
- Activity timestamps updated via `touchThread(...)` for idle/max-age expiration sweeps.

## 2.3 How sessions are bound to threads

There are two concurrent mechanisms:

1. Natural route isolation by thread channel id
- Route peer id is message channel id; for thread messages that is the thread channel id.
- `resolveDiscordConversationRoute(...)` in `src/discord/monitor/route-resolution.ts` calls `resolveAgentRoute(...)`.
- This yields a thread-specific session key automatically.

2. Explicit thread binding for spawned subagent/ACP sessions
- `extensions/discord/src/subagent-hooks.ts` handles:
  - `subagent_spawning`: optionally auto-create/bind a thread via `autoBindSpawnedDiscordSubagent(...)`.
  - `subagent_ended`: unbind by target session key.
  - `subagent_delivery_target`: resolve completion delivery target from binding records.
- Core binding creation:
  - `autoBindSpawnedDiscordSubagent(...)` in `src/discord/monitor/thread-bindings.lifecycle.ts`
  - Delegates to manager `bindTarget(...)` in `thread-bindings.manager.ts`.
- Binding record includes: `accountId`, `channelId`, `threadId`, `targetSessionKey`, `targetKind`, webhook metadata, TTL metadata.

## 2.4 Session routing mechanism

Inbound routing:

- Preflight computes base route from conversation context:
  - `resolveDiscordConversationRoute(...)`
- If a binding exists for current thread/channel context:
  - `getSessionBindingService().resolveByConversation(...)` in `message-handler.preflight.ts`
  - Then `resolveDiscordEffectiveRoute(...)` swaps route session to bound session key.

Outbound delivery back to thread:

- `deliverDiscordReply(...)` in `src/discord/monitor/reply-delivery.ts`.
- Looks up binding by session key + target thread channel id (`resolveBoundThreadBinding(...)`).
- If binding has webhook creds, sends as bound persona via webhook; otherwise bot send fallback.
- Touches binding activity on successful delivery.

Hook-driven spawned-session completion routing:

- `subagent_delivery_target` hook returns `{ origin: { channel, accountId, to, threadId } }` from binding lookup.

## 2.5 Relevant config options

Global defaults:

- `session.threadBindings.enabled`
- `session.threadBindings.idleHours`
- `session.threadBindings.maxAgeHours`

Discord channel/account overrides:

- `channels.discord.threadBindings.enabled`
- `channels.discord.threadBindings.idleHours`
- `channels.discord.threadBindings.maxAgeHours`
- `channels.discord.threadBindings.spawnSubagentSessions`
- `channels.discord.threadBindings.spawnAcpSessions`
- Account-level equivalents under `channels.discord.accounts.<id>.threadBindings.*`

Defined in:

- `src/config/zod-schema.session.ts`
- `src/config/zod-schema.providers-core.ts`
- `src/config/types.discord.ts`
- Resolution helpers in `src/channels/thread-bindings-policy.ts` and `src/discord/monitor/thread-bindings.config.ts`

---

## 3) Matrix Current Architecture and Message Flow

## 3.1 Plugin shape

- Entry: `extensions/matrix/index.ts`
- Registers only the channel plugin (`matrixPlugin`) and runtime.
- Unlike Discord, it does **not** register subagent hook handlers (`subagent_spawning`, `subagent_delivery_target`, `subagent_ended`).

## 3.2 Runtime flow

Monitor startup:

- `monitorMatrixProvider(...)` in `extensions/matrix/src/matrix/monitor/index.ts`
- Resolves account config, allowlists/room mappings, creates shared Matrix client, registers event handlers.

Inbound event path:

- `registerMatrixMonitorEvents(...)` in `extensions/matrix/src/matrix/monitor/events.ts`
- For `room.message`, delegates to handler from `createMatrixRoomMessageHandler(...)`.

Inbound handler core:

- `extensions/matrix/src/matrix/monitor/handler.ts`
- Performs:
  - message-type filtering
  - DM/group policy and allowlist gates
  - mention gate / command gate
  - Matrix thread extraction
  - route/session resolution
  - session recording
  - reply dispatch

## 3.3 Current thread/session behavior in Matrix

Thread detection:

- `resolveMatrixThreadRootId(...)` in `extensions/matrix/src/matrix/monitor/threads.ts`
- Reads `content["m.relates_to"]` with `rel_type: "m.thread"`, taking root event id.

Thread reply target behavior:

- `resolveMatrixThreadTarget(...)` with config `threadReplies: off|inbound|always`.
- Controls whether outbound replies include Matrix thread relation.

Session isolation today:

- Handler builds base route via `core.channel.routing.resolveAgentRoute(...)` using peer:
  - DM => sender id
  - Room => room id
- If `threadRootId` exists, it appends suffix:
  - `sessionKey = ${baseRoute.sessionKey}:thread:${threadRootId}`
- So Matrix already has **suffix-based per-thread session keys**.
- There is no explicit binding manager equivalent to Discord thread bindings.

Outbound threading:

- `deliverMatrixReplies(...)` and `sendMessageMatrix(...)`
- Pass `threadId` to build `m.thread` relation in outbound content.

---

## 4) Implementation Plan: Add Discord-Style Per-Thread Session Isolation to Matrix

## 4.1 Concept mapping: Discord threads vs Matrix

Discord concept -> Matrix concept:

- Thread channel id (`threadId`) -> Matrix thread root event id (`threadRootId`)
- Parent channel id -> Matrix room id
- Conversation address `channel:<threadId>` -> conversation tuple `(roomId, threadRootId)`
- Thread creation API -> not needed (Matrix threads are relation-based, not separate channels)

Key distinction:

- Discord threads are separate channel objects.
- Matrix threads are semantic relations within the same room.
- Binding identity for Matrix should therefore include both `roomId` and `threadRootId`.

## 4.2 Desired behavior parity

Target parity with Discord should include:

1. Stable thread-scoped session routing for inbound messages.
2. Explicit binding records for spawned subagent/ACP sessions tied to Matrix thread context.
3. Hook-based delivery-target override for spawned sessions.
4. Lifecycle cleanup (unbind on subagent/acp end; idle/max-age expiry).
5. Configurable enablement and spawn gating, with account overrides.

## 4.3 Proposed architecture

### A) Introduce Matrix thread-binding manager (new)

Create a Matrix equivalent to Discord manager/lifecycle, e.g.:

- `extensions/matrix/src/matrix/monitor/thread-bindings.types.ts`
- `extensions/matrix/src/matrix/monitor/thread-bindings.state.ts`
- `extensions/matrix/src/matrix/monitor/thread-bindings.manager.ts`
- `extensions/matrix/src/matrix/monitor/thread-bindings.lifecycle.ts`

Binding record should include at least:

- `accountId`
- `roomId`
- `threadRootId`
- `targetKind` (`subagent` | `acp`)
- `targetSessionKey`
- `agentId`, `label`, `boundBy`
- `boundAt`, `lastActivityAt`, `idleTimeoutMs`, `maxAgeMs`

Binding id format suggestion:

- `matrix:<accountId>:<roomId>:<threadRootId>` (or hashed variant for path/size safety)

### B) Register adapter with generic session binding service

Like Discord’s `registerSessionBindingAdapter(...)`, provide Matrix adapter so core can resolve by conversation.

Conversation identity strategy:

- `conversationId` => `${roomId}#${threadRootId}` for threaded scope
- `parentConversationId` => `roomId`

This keeps `resolveByConversation(...)` usable without changing the core service contract.

### C) Add Matrix plugin subagent hooks

Add new file (parallel to Discord):

- `extensions/matrix/src/subagent-hooks.ts`

Register in `extensions/matrix/index.ts`:

- `subagent_spawning`
- `subagent_delivery_target`
- `subagent_ended`

Behavior:

- On `threadRequested` and channel `matrix`, bind child session to current `(roomId, threadRootId)`.
- If request came from room-only context with no thread root, either:
  - return clear error for thread session request, or
  - create a room-scoped binding mode (explicitly decide; default should be strict/error for parity clarity).
- On completion, route back to bound thread context.
- On end, unbind.

### D) Update Matrix inbound route resolution to consult bindings

In `extensions/matrix/src/matrix/monitor/handler.ts`:

- Build conversation ref from inbound context:
  - room messages in thread: `(roomId, threadRootId)`
  - room non-thread: room only
  - DM: existing DM logic unchanged
- Query session binding service / Matrix manager first.
- If bound session exists, override route session key (like `resolveDiscordEffectiveRoute`).

### E) Keep deterministic suffix fallback

Retain current suffix behavior as fallback when no explicit binding exists:

- `baseSessionKey:thread:<normalizedThreadId>`

But normalize/encode thread id first to avoid problematic raw event id chars and excessive key length.

Suggested helper:

- `normalizeMatrixThreadSessionSuffix(threadRootId): string`
- Could be URL-safe base64 hash or escaped representation.

### F) Outbound delivery target integration

For completion/announce deliveries from spawned sessions:

- Use `subagent_delivery_target` hook result to set origin target with `threadId`.
- Ensure outbound reply path includes both:
  - `roomId` target
  - `threadId` relation for `m.thread`

### G) Config additions

Add Matrix channel thread-binding config mirroring Discord:

- `channels.matrix.threadBindings.enabled`
- `channels.matrix.threadBindings.idleHours`
- `channels.matrix.threadBindings.maxAgeHours`
- `channels.matrix.threadBindings.spawnSubagentSessions`
- `channels.matrix.threadBindings.spawnAcpSessions`

And account-level override:

- `channels.matrix.accounts.<id>.threadBindings.*`

Wire to:

- `extensions/matrix/src/types.ts`
- `extensions/matrix/src/config-schema.ts`
- core provider schema/help labels (likely `src/config/zod-schema.providers-core.ts`, `src/config/schema.help.ts`, `src/config/schema.labels.ts`)

Reuse global fallback behavior from `session.threadBindings.*` where applicable.

### H) Observability and tests

Tests to add/update:

- Matrix subagent hook tests (spawn, delivery target, cleanup).
- Thread binding manager tests (bind/list/resolve/unbind/sweep/TTL).
- Matrix handler tests ensuring bound session key wins over default suffix.
- Session key normalization tests for thread root ids containing `:` and long IDs.
- Integration test: spawned subagent in Matrix thread routes replies to same thread and session.

---

## 4.4 Potential challenges and edge cases

1. Matrix thread identity format
- Event IDs may contain characters that are awkward in session keys.
- Must normalize/encode before appending or persisting as identifiers.

2. Root-event availability
- Root event might be redacted, remote, or inaccessible during lookup.
- Binding should not depend on fetching root body; only on root event id.

3. Non-thread room messages
- Need explicit product decision: should `thread=true` spawn fail outside a thread, or fallback to room-scoped session.

4. Multi-account isolation
- Binding keys must always include normalized account id to avoid collisions.

5. Cleanup correctness
- Ensure idle/max-age sweep does not race with recent activity updates.
- Mirror Discord’s “touch before sweep removal” safety pattern.

6. Backward compatibility
- Existing Matrix suffix-based thread sessions already exist in stores.
- Migration strategy should avoid orphaning old sessions; fallback read compatibility may be needed.

---

## 4.5 Recommended rollout sequence

1. Add Matrix `threadBindings` config types/schema/help labels.
2. Implement Matrix thread binding state + manager + lifecycle.
3. Register Matrix session binding adapter at monitor startup.
4. Add `extensions/matrix/src/subagent-hooks.ts` and register in plugin entry.
5. Update Matrix inbound route resolution to prefer explicit binding, fallback to suffix.
6. Add thread session suffix normalization helper and tests.
7. Add end-to-end tests for subagent session routing in Matrix threads.
8. Validate no regressions for DM, non-thread room, and existing `threadReplies` behavior.

