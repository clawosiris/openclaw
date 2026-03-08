import { normalizeAccountId, type OpenClawPluginApi } from "openclaw/plugin-sdk/matrix";
import {
  autoBindSpawnedMatrixSubagent,
  listMatrixThreadBindingsBySessionKey,
  resolveMatrixThreadBindingSpawnError,
  unbindMatrixThreadBindingsBySessionKey,
} from "./matrix/monitor/thread-bindings.lifecycle.js";
import type { CoreConfig } from "./types.js";

function resolveMatrixRoomId(rawTarget: string | undefined): string | undefined {
  const trimmed = rawTarget?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^matrix:/i, "").trim();
  if (!withoutPrefix) {
    return undefined;
  }
  const lowered = withoutPrefix.toLowerCase();
  if (lowered.startsWith("room:")) {
    return withoutPrefix.slice("room:".length).trim() || undefined;
  }
  if (lowered.startsWith("channel:")) {
    return withoutPrefix.slice("channel:".length).trim() || undefined;
  }
  if (withoutPrefix.startsWith("!")) {
    return withoutPrefix;
  }
  return undefined;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "error";
}

export function registerMatrixSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "matrix") {
      return;
    }
    const accountId = normalizeAccountId(event.requester?.accountId);
    try {
      const spawnError = resolveMatrixThreadBindingSpawnError({
        cfg: api.config as CoreConfig,
        accountId,
        kind: "subagent",
      });
      if (spawnError) {
        return {
          status: "error" as const,
          error: spawnError,
        };
      }

      const roomId = resolveMatrixRoomId(event.requester?.to);
      const threadRootId =
        event.requester?.threadId != null ? String(event.requester.threadId).trim() : "";
      if (!threadRootId) {
        return {
          status: "error" as const,
          error:
            "Matrix thread-bound subagent spawn requires a thread message context. Start the spawn from a Matrix thread reply.",
        };
      }
      if (!roomId) {
        return {
          status: "error" as const,
          error: "Unable to resolve Matrix room for thread binding.",
        };
      }
      const bound = autoBindSpawnedMatrixSubagent({
        accountId,
        roomId,
        threadRootId,
        childSessionKey: event.childSessionKey,
        agentId: event.agentId,
        label: event.label,
        boundBy: "system",
      });
      if (!bound.record) {
        return {
          status: "error" as const,
          error: bound.error ?? "Unable to bind Matrix thread for spawned session.",
        };
      }
      return { status: "ok" as const, threadBindingReady: true };
    } catch (error) {
      api.logger.error?.("matrix.thread.hook_handler_error", {
        hookName: "subagent_spawning",
        error: summarizeError(error),
        accountId,
      });
      return;
    }
  });

  api.on("subagent_ended", (event) => {
    try {
      unbindMatrixThreadBindingsBySessionKey({
        targetSessionKey: event.targetSessionKey,
        accountId: event.accountId,
        targetKind: event.targetKind === "subagent" ? "subagent" : "acp",
        reason: "session_ended",
      });
    } catch (error) {
      api.logger.error?.("matrix.thread.hook_handler_error", {
        hookName: "subagent_ended",
        error: summarizeError(error),
        accountId: event.accountId,
      });
    }
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "matrix") {
      return;
    }
    const requesterAccountId = event.requesterOrigin?.accountId?.trim();
    const requesterRoomId = resolveMatrixRoomId(event.requesterOrigin?.to);
    const requesterThreadId =
      event.requesterOrigin?.threadId != null ? String(event.requesterOrigin.threadId).trim() : "";
    try {
      const bindings = listMatrixThreadBindingsBySessionKey({
        targetSessionKey: event.childSessionKey,
        ...(requesterAccountId ? { accountId: requesterAccountId } : {}),
        targetKind: "subagent",
      });
      if (bindings.length === 0) {
        return;
      }
      let binding: (typeof bindings)[number] | undefined;
      if (requesterRoomId && requesterThreadId) {
        binding = bindings.find(
          (entry) => entry.roomId === requesterRoomId && entry.threadRootId === requesterThreadId,
        );
      }
      if (!binding && bindings.length === 1) {
        binding = bindings[0];
      }
      if (!binding) {
        return;
      }
      return {
        origin: {
          channel: "matrix",
          accountId: binding.accountId,
          to: `room:${binding.roomId}`,
          threadId: binding.threadRootId,
        },
      };
    } catch (error) {
      api.logger.error?.("matrix.thread.hook_handler_error", {
        hookName: "subagent_delivery_target",
        error: summarizeError(error),
        accountId: requesterAccountId,
        roomId: requesterRoomId,
      });
      return;
    }
  });
}
