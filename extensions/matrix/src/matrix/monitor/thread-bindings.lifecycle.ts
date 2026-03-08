import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "openclaw/plugin-sdk/matrix";
import type { CoreConfig } from "../../types.js";
import { getMatrixThreadBindingManager } from "./thread-bindings.manager.js";
import {
  MATRIX_THREAD_BINDINGS_DEFAULT_MAX_ACTIVE,
  type MatrixThreadBindingRecord,
} from "./thread-bindings.types.js";

type MatrixThreadBindingsConfigShape = {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSubagentSessions?: boolean;
  spawnAcpSessions?: boolean;
  maxActiveBindings?: number;
  legacySuffixLookup?: boolean;
};

function resolveMatrixThreadBindingsConfig(params: {
  cfg: CoreConfig;
  accountId: string;
}): MatrixThreadBindingsConfigShape {
  const root = params.cfg.channels?.matrix?.threadBindings as MatrixThreadBindingsConfigShape | undefined;
  const account = params.cfg.channels?.matrix?.accounts?.[params.accountId]?.threadBindings as
    | MatrixThreadBindingsConfigShape
    | undefined;
  return {
    ...root,
    ...account,
  };
}

function normalizeMaxActiveBindings(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return MATRIX_THREAD_BINDINGS_DEFAULT_MAX_ACTIVE;
  }
  return Math.max(1, Math.floor(raw));
}

function normalizeBoolean(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

export function resolveMatrixThreadBindingRuntimeConfig(params: {
  cfg: CoreConfig;
  accountId: string;
}) {
  const mergedConfig = resolveMatrixThreadBindingsConfig(params);
  const spawnSubagentPolicy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel: "matrix",
    accountId: params.accountId,
    kind: "subagent",
  });
  const spawnAcpPolicy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel: "matrix",
    accountId: params.accountId,
    kind: "acp",
  });
  return {
    enabled: spawnSubagentPolicy.enabled,
    spawnSubagentSessions: spawnSubagentPolicy.spawnEnabled,
    spawnAcpSessions: spawnAcpPolicy.spawnEnabled,
    idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
      cfg: params.cfg,
      channel: "matrix",
      accountId: params.accountId,
    }),
    maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
      cfg: params.cfg,
      channel: "matrix",
      accountId: params.accountId,
    }),
    maxActiveBindings: normalizeMaxActiveBindings(mergedConfig.maxActiveBindings),
    legacySuffixLookup: normalizeBoolean(mergedConfig.legacySuffixLookup) ?? true,
  };
}

export function resolveMatrixThreadBindingSpawnError(params: {
  cfg: CoreConfig;
  accountId: string;
  kind: "subagent" | "acp";
}): string | undefined {
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel: "matrix",
    accountId: params.accountId,
    kind: params.kind,
  });
  if (!policy.enabled) {
    return formatThreadBindingDisabledError({
      channel: "matrix",
      accountId: params.accountId,
      kind: params.kind,
    });
  }
  if (!policy.spawnEnabled) {
    return formatThreadBindingSpawnDisabledError({
      channel: "matrix",
      accountId: params.accountId,
      kind: params.kind,
    });
  }
  return undefined;
}

export function listMatrixThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: "subagent" | "acp";
}): MatrixThreadBindingRecord[] {
  const manager = getMatrixThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  return manager.listBySessionKey(params.targetSessionKey).filter((entry) => {
    if (params.targetKind && entry.targetKind !== params.targetKind) {
      return false;
    }
    return true;
  });
}

export function unbindMatrixThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: "subagent" | "acp";
  reason?: string;
}): MatrixThreadBindingRecord[] {
  const manager = getMatrixThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  return manager.unbindBySessionKey({
    targetSessionKey: params.targetSessionKey,
    targetKind: params.targetKind,
    reason: params.reason === "expired" ? "expired" : params.reason === "manual" ? "manual" : "session_ended",
  });
}

export function autoBindSpawnedMatrixSubagent(params: {
  accountId: string;
  roomId: string;
  threadRootId: string;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): { record: MatrixThreadBindingRecord | null; error?: string } {
  const manager = getMatrixThreadBindingManager(params.accountId);
  if (!manager) {
    return { record: null, error: "matrix thread binding manager unavailable" };
  }
  return manager.bindTarget({
    roomId: params.roomId,
    threadRootId: params.threadRootId,
    targetKind: "subagent",
    targetSessionKey: params.childSessionKey,
    agentId: params.agentId,
    label: params.label,
    boundBy: params.boundBy,
  });
}
