import {
  normalizeAccountId,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type RuntimeLogger,
} from "openclaw/plugin-sdk/matrix";
import {
  ensureMatrixThreadBindingsLoaded,
  flushMatrixBindingsPersist,
  MATRIX_BINDINGS_BY_KEY,
  MATRIX_MANAGERS_BY_ACCOUNT_ID,
  removeMatrixThreadBindingRecord,
  resolveMatrixBindingLookupKeysForSession,
  scheduleMatrixBindingsPersist,
  setMatrixThreadBindingRecord,
} from "./thread-bindings.state.js";
import {
  MATRIX_THREAD_BINDINGS_DEFAULT_MAX_ACTIVE,
  MATRIX_THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  resolveConversationRefToMatrixKey,
  toBindingId,
  toConversationId,
  toLookupKey,
  toMatrixTargetKind,
  toSessionBindingRecord,
  type MatrixThreadBindingManager,
  type MatrixThreadBindingRecord,
} from "./thread-bindings.types.js";

function parseConversationId(raw: string): { roomId: string; threadRootId: string } | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const [roomId, threadRootId] = value.split("||");
  if (!roomId || !threadRootId) {
    return null;
  }
  return { roomId, threadRootId };
}

function resolveAgentIdFromSessionKey(sessionKeyRaw: string): string | undefined {
  const parts = sessionKeyRaw.trim().split(":").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return parts[1];
}

function resolveBindingAgeMs(record: MatrixThreadBindingRecord, now: number): number {
  const timestamp = Math.max(record.lastActivityAt, record.boundAt);
  return Math.max(0, now - timestamp);
}

export function createMatrixThreadBindingManager(params: {
  accountId?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  maxActiveBindings?: number;
  legacySuffixLookup?: boolean;
  logger?: RuntimeLogger;
  enableSweeper?: boolean;
}): MatrixThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  ensureMatrixThreadBindingsLoaded(params.logger);
  const existing = MATRIX_MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const idleTimeoutMs = Math.max(0, Math.floor(params.idleTimeoutMs));
  const maxAgeMs = Math.max(0, Math.floor(params.maxAgeMs));
  const maxActiveBindings = Math.max(
    1,
    Math.floor(params.maxActiveBindings ?? MATRIX_THREAD_BINDINGS_DEFAULT_MAX_ACTIVE),
  );
  const legacySuffixLookup = params.legacySuffixLookup !== false;
  let sweepTimer: NodeJS.Timeout | null = null;
  let sweepRunning = false;

  const manager: MatrixThreadBindingManager = {
    accountId,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getMaxActiveBindings: () => maxActiveBindings,
    getLegacySuffixLookupEnabled: () => legacySuffixLookup,
    resolveByConversation: ({ roomId, threadRootId }) => {
      const lookupKey = toLookupKey({
        accountId,
        roomId: roomId.trim(),
        threadRootId: threadRootId.trim(),
      });
      const record = MATRIX_BINDINGS_BY_KEY.get(lookupKey) ?? null;
      if (record) {
        params.logger?.debug?.("matrix.thread.binding_resolved", {
          accountId,
          roomId: record.roomId,
          threadRootId: record.threadRootId,
          targetSessionKey: record.targetSessionKey,
        });
      }
      return record;
    },
    listBySessionKey: (targetSessionKey) => {
      const ids = resolveMatrixBindingLookupKeysForSession({
        targetSessionKey,
        accountId,
      });
      return ids
        .map((lookupKey) => MATRIX_BINDINGS_BY_KEY.get(lookupKey))
        .filter((entry): entry is MatrixThreadBindingRecord => Boolean(entry));
    },
    listBindings: () =>
      [...MATRIX_BINDINGS_BY_KEY.values()].filter((entry) => entry.accountId === accountId),
    touchByConversation: ({ roomId, threadRootId, at }) => {
      const lookupKey = toLookupKey({ accountId, roomId, threadRootId });
      const existing = MATRIX_BINDINGS_BY_KEY.get(lookupKey);
      if (!existing) {
        return null;
      }
      const timestamp =
        typeof at === "number" && Number.isFinite(at) ? Math.max(0, Math.floor(at)) : Date.now();
      const nextRecord: MatrixThreadBindingRecord = {
        ...existing,
        lastActivityAt: Math.max(existing.lastActivityAt, timestamp),
      };
      setMatrixThreadBindingRecord(nextRecord);
      scheduleMatrixBindingsPersist(params.logger);
      return nextRecord;
    },
    touchByBindingId: (bindingId, at) => {
      const normalizedBindingId = bindingId.trim();
      if (!normalizedBindingId.startsWith("matrix:")) {
        return null;
      }
      const lookupKey = normalizedBindingId.slice("matrix:".length);
      const existing = MATRIX_BINDINGS_BY_KEY.get(lookupKey);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      return manager.touchByConversation({
        roomId: existing.roomId,
        threadRootId: existing.threadRootId,
        at,
      });
    },
    bindTarget: ({
      roomId,
      threadRootId,
      targetKind,
      targetSessionKey,
      agentId,
      label,
      boundBy,
    }) => {
      const normalizedRoomId = roomId.trim();
      const normalizedThreadRootId = threadRootId.trim();
      const normalizedTargetSessionKey = targetSessionKey.trim();
      if (!normalizedRoomId || !normalizedThreadRootId || !normalizedTargetSessionKey) {
        return { record: null };
      }
      const activeCount = manager.listBindings().length;
      if (activeCount >= maxActiveBindings) {
        return { record: null, error: `thread binding limit reached for account ${accountId}` };
      }
      if (activeCount >= Math.floor(maxActiveBindings * 0.8)) {
        params.logger?.warn?.("matrix.thread.bindings_near_limit", {
          accountId,
          activeCount,
          maxActiveBindings,
        });
      }

      const now = Date.now();
      const record: MatrixThreadBindingRecord = {
        bindingId: toBindingId({
          accountId,
          roomId: normalizedRoomId,
          threadRootId: normalizedThreadRootId,
        }),
        accountId,
        roomId: normalizedRoomId,
        threadRootId: normalizedThreadRootId,
        targetKind: targetKind ?? "subagent",
        targetSessionKey: normalizedTargetSessionKey,
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs,
        maxAgeMs,
        agentId: agentId?.trim() || resolveAgentIdFromSessionKey(normalizedTargetSessionKey),
        label: label?.trim() || undefined,
        boundBy: boundBy?.trim() || "system",
      };
      setMatrixThreadBindingRecord(record);
      scheduleMatrixBindingsPersist(params.logger);
      params.logger?.debug?.("matrix.thread.binding_created", {
        accountId,
        roomId: record.roomId,
        threadRootId: record.threadRootId,
        targetKind: record.targetKind,
        targetSessionKey: record.targetSessionKey,
        activeCount: activeCount + 1,
      });
      return { record };
    },
    unbindByConversation: ({ roomId, threadRootId, reason }) => {
      const lookupKey = toLookupKey({ accountId, roomId, threadRootId });
      const removed = removeMatrixThreadBindingRecord(lookupKey);
      if (!removed) {
        return null;
      }
      scheduleMatrixBindingsPersist(params.logger);
      params.logger?.info?.("matrix.thread.binding_removed", {
        accountId,
        roomId: removed.roomId,
        threadRootId: removed.threadRootId,
        targetSessionKey: removed.targetSessionKey,
        reason,
      });
      return removed;
    },
    unbindBySessionKey: ({ targetSessionKey, targetKind, reason }) => {
      const ids = resolveMatrixBindingLookupKeysForSession({
        targetSessionKey,
        accountId,
        targetKind,
      });
      const removed: MatrixThreadBindingRecord[] = [];
      for (const lookupKey of ids) {
        const entry = MATRIX_BINDINGS_BY_KEY.get(lookupKey);
        if (!entry) {
          continue;
        }
        const unbound = manager.unbindByConversation({
          roomId: entry.roomId,
          threadRootId: entry.threadRootId,
          reason,
        });
        if (unbound) {
          removed.push(unbound);
        }
      }
      return removed;
    },
    sweepExpiredBindings: () => {
      const now = Date.now();
      let removedCount = 0;
      const bindings = manager.listBindings();
      for (const snapshot of bindings) {
        const live = manager.resolveByConversation({
          roomId: snapshot.roomId,
          threadRootId: snapshot.threadRootId,
        });
        if (!live) {
          continue;
        }
        const idleExpired =
          live.idleTimeoutMs > 0 && now >= live.lastActivityAt + live.idleTimeoutMs;
        const maxAgeExpired = live.maxAgeMs > 0 && now >= live.boundAt + live.maxAgeMs;
        if (!idleExpired && !maxAgeExpired) {
          continue;
        }
        const reason = maxAgeExpired ? "max_age" : "idle";
        params.logger?.info?.("matrix.thread.binding_expired", {
          accountId,
          roomId: live.roomId,
          threadRootId: live.threadRootId,
          reason,
          age_ms: resolveBindingAgeMs(live, now),
        });
        const removed = manager.unbindByConversation({
          roomId: live.roomId,
          threadRootId: live.threadRootId,
          reason: "expired",
        });
        if (removed) {
          removedCount += 1;
        }
      }
      return removedCount;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      MATRIX_MANAGERS_BY_ACCOUNT_ID.delete(accountId);
      unregisterSessionBindingAdapter({ channel: "matrix", accountId });
      flushMatrixBindingsPersist(params.logger);
    },
  };

  registerSessionBindingAdapter({
    channel: "matrix",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "matrix") {
        return null;
      }
      const conversation = resolveConversationRefToMatrixKey(input.conversation);
      if (!conversation) {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const metadata = input.metadata ?? {};
      const bound = manager.bindTarget({
        roomId: conversation.roomId,
        threadRootId: conversation.threadRootId,
        targetKind: toMatrixTargetKind(input.targetKind),
        targetSessionKey,
        agentId: typeof metadata.agentId === "string" ? metadata.agentId : undefined,
        label: typeof metadata.label === "string" ? metadata.label : undefined,
        boundBy: typeof metadata.boundBy === "string" ? metadata.boundBy : undefined,
      });
      return bound.record ? toSessionBindingRecord(bound.record) : null;
    },
    listBySession: (targetSessionKey) =>
      manager.listBySessionKey(targetSessionKey).map((entry) => toSessionBindingRecord(entry)),
    resolveByConversation: (ref) => {
      const parsed = resolveConversationRefToMatrixKey(ref);
      if (!parsed) {
        return null;
      }
      const resolved = manager.resolveByConversation(parsed);
      return resolved ? toSessionBindingRecord(resolved) : null;
    },
    touch: (bindingId, at) => {
      manager.touchByBindingId(bindingId, at);
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        return manager
          .unbindBySessionKey({
            targetSessionKey: input.targetSessionKey,
            reason: "manual",
          })
          .map((entry) => toSessionBindingRecord(entry));
      }
      const bindingId = input.bindingId?.trim() ?? "";
      if (!bindingId.startsWith("matrix:")) {
        return [];
      }
      const lookupKey = bindingId.slice("matrix:".length);
      const record = MATRIX_BINDINGS_BY_KEY.get(lookupKey);
      if (!record || record.accountId !== accountId) {
        return [];
      }
      const removed = manager.unbindByConversation({
        roomId: record.roomId,
        threadRootId: record.threadRootId,
        reason: "manual",
      });
      return removed ? [toSessionBindingRecord(removed)] : [];
    },
  });

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      if (sweepRunning) {
        return;
      }
      sweepRunning = true;
      try {
        manager.sweepExpiredBindings();
      } finally {
        sweepRunning = false;
      }
    }, MATRIX_THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  MATRIX_MANAGERS_BY_ACCOUNT_ID.set(accountId, manager);
  return manager;
}

export function getMatrixThreadBindingManager(
  accountId?: string | null,
): MatrixThreadBindingManager | null {
  const normalized = normalizeAccountId(accountId);
  return MATRIX_MANAGERS_BY_ACCOUNT_ID.get(normalized) ?? null;
}

export function resolveMatrixBindingFromConversationRef(params: {
  accountId?: string;
  conversationId: string;
}): MatrixThreadBindingRecord | null {
  const accountId = normalizeAccountId(params.accountId);
  const parsed = parseConversationId(params.conversationId);
  if (!parsed) {
    return null;
  }
  const lookupKey = toLookupKey({
    accountId,
    roomId: parsed.roomId,
    threadRootId: parsed.threadRootId,
  });
  return MATRIX_BINDINGS_BY_KEY.get(lookupKey) ?? null;
}

export function toMatrixConversationId(params: { roomId: string; threadRootId: string }): string {
  return toConversationId(params.roomId, params.threadRootId);
}
