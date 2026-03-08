import type {
  BindingTargetKind,
  ConversationRef,
  SessionBindingRecord,
} from "openclaw/plugin-sdk/matrix";

export const MATRIX_THREAD_BINDINGS_VERSION = 1;
export const MATRIX_THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
export const MATRIX_THREAD_BINDINGS_PERSIST_DEBOUNCE_MS = 1_000;
export const MATRIX_THREAD_BINDINGS_DEFAULT_MAX_ACTIVE = 100;

export type MatrixThreadBindingTargetKind = "subagent" | "acp";

export type MatrixThreadBindingRecord = {
  bindingId: string;
  accountId: string;
  roomId: string;
  threadRootId: string;
  targetKind: MatrixThreadBindingTargetKind;
  targetSessionKey: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs: number;
  maxAgeMs: number;
  agentId?: string;
  label?: string;
  boundBy?: string;
};

export type PersistedMatrixThreadBindings = {
  version: number;
  bindings: MatrixThreadBindingRecord[];
};

export type MatrixThreadBindingManager = {
  accountId: string;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getMaxActiveBindings: () => number;
  getLegacySuffixLookupEnabled: () => boolean;
  resolveByConversation: (params: {
    roomId: string;
    threadRootId: string;
  }) => MatrixThreadBindingRecord | null;
  listBySessionKey: (targetSessionKey: string) => MatrixThreadBindingRecord[];
  listBindings: () => MatrixThreadBindingRecord[];
  touchByConversation: (params: {
    roomId: string;
    threadRootId: string;
    at?: number;
  }) => MatrixThreadBindingRecord | null;
  touchByBindingId: (bindingId: string, at?: number) => MatrixThreadBindingRecord | null;
  bindTarget: (params: {
    roomId: string;
    threadRootId: string;
    targetKind?: MatrixThreadBindingTargetKind;
    targetSessionKey: string;
    agentId?: string;
    label?: string;
    boundBy?: string;
  }) => { record: MatrixThreadBindingRecord | null; error?: string };
  unbindByConversation: (params: {
    roomId: string;
    threadRootId: string;
    reason: "session_ended" | "expired" | "manual";
  }) => MatrixThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    targetKind?: MatrixThreadBindingTargetKind;
    reason: "session_ended" | "expired" | "manual";
  }) => MatrixThreadBindingRecord[];
  sweepExpiredBindings: () => number;
  stop: () => void;
};

export function toSessionBindingTargetKind(
  raw: MatrixThreadBindingTargetKind,
): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

export function toMatrixTargetKind(raw: BindingTargetKind): MatrixThreadBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

export function toConversationId(roomId: string, threadRootId: string): string {
  return `${roomId}||${threadRootId}`;
}

export function toBindingId(params: {
  accountId: string;
  roomId: string;
  threadRootId: string;
}): string {
  return `matrix:${params.accountId}:${toConversationId(params.roomId, params.threadRootId)}`;
}

export function toLookupKey(params: {
  accountId: string;
  roomId: string;
  threadRootId: string;
}): string {
  return `${params.accountId}:${toConversationId(params.roomId, params.threadRootId)}`;
}

export function toSessionBindingRecord(record: MatrixThreadBindingRecord): SessionBindingRecord {
  return {
    bindingId: record.bindingId,
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "matrix",
      accountId: record.accountId,
      conversationId: toConversationId(record.roomId, record.threadRootId),
      parentConversationId: record.roomId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveBindingExpiresAt(record),
    metadata: {
      roomId: record.roomId,
      threadRootId: record.threadRootId,
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: record.idleTimeoutMs,
      maxAgeMs: record.maxAgeMs,
    },
  };
}

export function resolveConversationRefToMatrixKey(
  ref: ConversationRef,
): { roomId: string; threadRootId: string } | null {
  if (ref.channel !== "matrix") {
    return null;
  }
  const accountId = ref.accountId.trim();
  const roomId = ref.parentConversationId?.trim() || "";
  const conversationId = ref.conversationId.trim();
  if (!accountId || !roomId || !conversationId) {
    return null;
  }
  const [conversationRoomId, threadRootId] = conversationId.split("||");
  if (!conversationRoomId || !threadRootId || conversationRoomId !== roomId) {
    return null;
  }
  return { roomId, threadRootId };
}

export function resolveBindingExpiresAt(record: MatrixThreadBindingRecord): number | undefined {
  const idleExpiresAt =
    record.idleTimeoutMs > 0 ? record.lastActivityAt + record.idleTimeoutMs : undefined;
  const maxAgeExpiresAt = record.maxAgeMs > 0 ? record.boundAt + record.maxAgeMs : undefined;
  if (idleExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(idleExpiresAt, maxAgeExpiresAt);
  }
  return idleExpiresAt ?? maxAgeExpiresAt;
}
