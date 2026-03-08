import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeLogger } from "openclaw/plugin-sdk/matrix";
import { normalizeAccountId } from "openclaw/plugin-sdk/matrix";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixThreadBindingManager, MatrixThreadBindingRecord } from "./thread-bindings.types.js";
import {
  MATRIX_THREAD_BINDINGS_PERSIST_DEBOUNCE_MS,
  MATRIX_THREAD_BINDINGS_VERSION,
  toLookupKey,
  type PersistedMatrixThreadBindings,
} from "./thread-bindings.types.js";

type MatrixThreadBindingsGlobalState = {
  loaded: boolean;
  bindingsByKey: Map<string, MatrixThreadBindingRecord>;
  bindingsBySessionKey: Map<string, Set<string>>;
  managersByAccountId: Map<string, MatrixThreadBindingManager>;
  pendingPersistTimer: NodeJS.Timeout | null;
  lastPersistAtMs: number;
};

const MATRIX_THREAD_BINDINGS_STATE_KEY = "__openclawMatrixThreadBindingsState";

function createState(): MatrixThreadBindingsGlobalState {
  return {
    loaded: false,
    bindingsByKey: new Map<string, MatrixThreadBindingRecord>(),
    bindingsBySessionKey: new Map<string, Set<string>>(),
    managersByAccountId: new Map<string, MatrixThreadBindingManager>(),
    pendingPersistTimer: null,
    lastPersistAtMs: 0,
  };
}

function resolveState(): MatrixThreadBindingsGlobalState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [MATRIX_THREAD_BINDINGS_STATE_KEY]?: MatrixThreadBindingsGlobalState;
  };
  if (!runtimeGlobal[MATRIX_THREAD_BINDINGS_STATE_KEY]) {
    runtimeGlobal[MATRIX_THREAD_BINDINGS_STATE_KEY] = createState();
  }
  return runtimeGlobal[MATRIX_THREAD_BINDINGS_STATE_KEY];
}

const STATE = resolveState();

export const MATRIX_BINDINGS_BY_KEY = STATE.bindingsByKey;
export const MATRIX_BINDINGS_BY_SESSION_KEY = STATE.bindingsBySessionKey;
export const MATRIX_MANAGERS_BY_ACCOUNT_ID = STATE.managersByAccountId;

export function resolveMatrixThreadBindingsPath(): string {
  const stateDir = getMatrixRuntime().state.resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "matrix", "thread-bindings.json");
}

function linkSessionBinding(targetSessionKeyRaw: string, lookupKey: string): void {
  const targetSessionKey = targetSessionKeyRaw.trim();
  if (!targetSessionKey) {
    return;
  }
  const existing = MATRIX_BINDINGS_BY_SESSION_KEY.get(targetSessionKey) ?? new Set<string>();
  existing.add(lookupKey);
  MATRIX_BINDINGS_BY_SESSION_KEY.set(targetSessionKey, existing);
}

function unlinkSessionBinding(targetSessionKeyRaw: string, lookupKey: string): void {
  const targetSessionKey = targetSessionKeyRaw.trim();
  if (!targetSessionKey) {
    return;
  }
  const existing = MATRIX_BINDINGS_BY_SESSION_KEY.get(targetSessionKey);
  if (!existing) {
    return;
  }
  existing.delete(lookupKey);
  if (existing.size === 0) {
    MATRIX_BINDINGS_BY_SESSION_KEY.delete(targetSessionKey);
  }
}

function normalizeRecord(raw: unknown): MatrixThreadBindingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<MatrixThreadBindingRecord>;
  const accountId = normalizeAccountId(value.accountId);
  const roomId = typeof value.roomId === "string" ? value.roomId.trim() : "";
  const threadRootId = typeof value.threadRootId === "string" ? value.threadRootId.trim() : "";
  const targetSessionKey =
    typeof value.targetSessionKey === "string" ? value.targetSessionKey.trim() : "";
  if (!accountId || !roomId || !threadRootId || !targetSessionKey) {
    return null;
  }
  const now = Date.now();
  const targetKind = value.targetKind === "subagent" ? "subagent" : "acp";
  const boundAt =
    typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
      ? Math.max(0, Math.floor(value.boundAt))
      : now;
  const lastActivityAt =
    typeof value.lastActivityAt === "number" && Number.isFinite(value.lastActivityAt)
      ? Math.max(0, Math.floor(value.lastActivityAt))
      : boundAt;
  const idleTimeoutMs =
    typeof value.idleTimeoutMs === "number" && Number.isFinite(value.idleTimeoutMs)
      ? Math.max(0, Math.floor(value.idleTimeoutMs))
      : 0;
  const maxAgeMs =
    typeof value.maxAgeMs === "number" && Number.isFinite(value.maxAgeMs)
      ? Math.max(0, Math.floor(value.maxAgeMs))
      : 0;
  return {
    bindingId:
      typeof value.bindingId === "string" && value.bindingId.trim()
        ? value.bindingId.trim()
        : `matrix:${toLookupKey({ accountId, roomId, threadRootId })}`,
    accountId,
    roomId,
    threadRootId,
    targetKind,
    targetSessionKey,
    boundAt,
    lastActivityAt,
    idleTimeoutMs,
    maxAgeMs,
    agentId: typeof value.agentId === "string" ? value.agentId.trim() || undefined : undefined,
    label: typeof value.label === "string" ? value.label.trim() || undefined : undefined,
    boundBy: typeof value.boundBy === "string" ? value.boundBy.trim() || undefined : undefined,
  };
}

function writeBindingsToDisk(logger?: RuntimeLogger): void {
  const pathname = resolveMatrixThreadBindingsPath();
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const payload: PersistedMatrixThreadBindings = {
    version: MATRIX_THREAD_BINDINGS_VERSION,
    bindings: [...MATRIX_BINDINGS_BY_KEY.values()],
  };
  const now = Date.now();
  const tmpPath = `${pathname}.tmp.${process.pid}.${now}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, pathname);
    STATE.lastPersistAtMs = now;
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup failures.
    }
    logger?.error?.("matrix.thread.persistence_write_failed", {
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function scheduleMatrixBindingsPersist(logger?: RuntimeLogger): void {
  if (STATE.pendingPersistTimer) {
    return;
  }
  const now = Date.now();
  const delay = Math.max(
    0,
    MATRIX_THREAD_BINDINGS_PERSIST_DEBOUNCE_MS - (now - STATE.lastPersistAtMs),
  );
  STATE.pendingPersistTimer = setTimeout(() => {
    STATE.pendingPersistTimer = null;
    writeBindingsToDisk(logger);
  }, delay);
  STATE.pendingPersistTimer.unref?.();
}

export function flushMatrixBindingsPersist(logger?: RuntimeLogger): void {
  if (STATE.pendingPersistTimer) {
    clearTimeout(STATE.pendingPersistTimer);
    STATE.pendingPersistTimer = null;
  }
  writeBindingsToDisk(logger);
}

export function setMatrixThreadBindingRecord(record: MatrixThreadBindingRecord): void {
  const lookupKey = toLookupKey(record);
  const existing = MATRIX_BINDINGS_BY_KEY.get(lookupKey);
  if (existing) {
    unlinkSessionBinding(existing.targetSessionKey, lookupKey);
  }
  MATRIX_BINDINGS_BY_KEY.set(lookupKey, record);
  linkSessionBinding(record.targetSessionKey, lookupKey);
}

export function removeMatrixThreadBindingRecord(
  lookupKeyRaw: string,
): MatrixThreadBindingRecord | null {
  const lookupKey = lookupKeyRaw.trim();
  if (!lookupKey) {
    return null;
  }
  const existing = MATRIX_BINDINGS_BY_KEY.get(lookupKey);
  if (!existing) {
    return null;
  }
  MATRIX_BINDINGS_BY_KEY.delete(lookupKey);
  unlinkSessionBinding(existing.targetSessionKey, lookupKey);
  return existing;
}

export function resolveMatrixBindingLookupKeysForSession(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: "subagent" | "acp";
}): string[] {
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const entries = MATRIX_BINDINGS_BY_SESSION_KEY.get(targetSessionKey);
  if (!entries) {
    return [];
  }
  const normalizedAccountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  const out: string[] = [];
  for (const lookupKey of entries.values()) {
    const binding = MATRIX_BINDINGS_BY_KEY.get(lookupKey);
    if (!binding) {
      continue;
    }
    if (normalizedAccountId && binding.accountId !== normalizedAccountId) {
      continue;
    }
    if (params.targetKind && binding.targetKind !== params.targetKind) {
      continue;
    }
    out.push(lookupKey);
  }
  return out;
}

export function ensureMatrixThreadBindingsLoaded(logger?: RuntimeLogger): void {
  if (STATE.loaded) {
    return;
  }
  STATE.loaded = true;
  MATRIX_BINDINGS_BY_KEY.clear();
  MATRIX_BINDINGS_BY_SESSION_KEY.clear();

  const pathname = resolveMatrixThreadBindingsPath();
  if (!fs.existsSync(pathname)) {
    return;
  }
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedMatrixThreadBindings>;
    if (
      parsed.version !== MATRIX_THREAD_BINDINGS_VERSION ||
      !Array.isArray(parsed.bindings)
    ) {
      return;
    }
    for (const entry of parsed.bindings) {
      const record = normalizeRecord(entry);
      if (!record) {
        continue;
      }
      setMatrixThreadBindingRecord(record);
    }
  } catch (error) {
    logger?.error?.("matrix.thread.persistence_corrupt", {
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    const corruptPath = `${pathname}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(pathname, corruptPath);
    } catch {
      // Ignore rename failures.
    }
  }
}

export function resetMatrixThreadBindingsForTests(): void {
  for (const manager of MATRIX_MANAGERS_BY_ACCOUNT_ID.values()) {
    manager.stop();
  }
  MATRIX_MANAGERS_BY_ACCOUNT_ID.clear();
  MATRIX_BINDINGS_BY_KEY.clear();
  MATRIX_BINDINGS_BY_SESSION_KEY.clear();
  if (STATE.pendingPersistTimer) {
    clearTimeout(STATE.pendingPersistTimer);
    STATE.pendingPersistTimer = null;
  }
  STATE.loaded = false;
  STATE.lastPersistAtMs = 0;
}
