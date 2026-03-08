import type { OpenClawPluginApi } from "openclaw/plugin-sdk/matrix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixSubagentHooks } from "../../src/subagent-hooks.js";

const hookMocks = vi.hoisted(() => ({
  autoBindSpawnedMatrixSubagent: vi.fn(() => ({
    record: { bindingId: "matrix:work:!room||$thread" },
  })),
  listMatrixThreadBindingsBySessionKey: vi.fn(() => []),
  resolveMatrixThreadBindingSpawnError: vi.fn(() => undefined),
  unbindMatrixThreadBindingsBySessionKey: vi.fn(() => []),
}));

vi.mock("../../src/matrix/monitor/thread-bindings.lifecycle.js", () => ({
  autoBindSpawnedMatrixSubagent: (params: unknown) =>
    hookMocks.autoBindSpawnedMatrixSubagent(params),
  listMatrixThreadBindingsBySessionKey: (params: unknown) =>
    hookMocks.listMatrixThreadBindingsBySessionKey(params),
  resolveMatrixThreadBindingSpawnError: (params: unknown) =>
    hookMocks.resolveMatrixThreadBindingSpawnError(params),
  unbindMatrixThreadBindingsBySessionKey: (params: unknown) =>
    hookMocks.unbindMatrixThreadBindingsBySessionKey(params),
}));

function registerHandlersForTest() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const api = {
    config: {},
    logger: {
      error: vi.fn(),
    },
    on: (hookName: string, handler: (event: unknown) => unknown) => {
      handlers.set(hookName, handler);
    },
  } as unknown as OpenClawPluginApi;
  registerMatrixSubagentHooks(api);
  return { handlers, api };
}

function getRequiredHandler(
  handlers: Map<string, (event: unknown) => unknown>,
  hookName: string,
): (event: unknown) => unknown {
  const handler = handlers.get(hookName);
  if (!handler) {
    throw new Error(`expected ${hookName} hook handler`);
  }
  return handler;
}

describe("matrix subagent hook handlers", () => {
  beforeEach(() => {
    hookMocks.autoBindSpawnedMatrixSubagent.mockClear();
    hookMocks.listMatrixThreadBindingsBySessionKey.mockClear();
    hookMocks.resolveMatrixThreadBindingSpawnError.mockClear();
    hookMocks.resolveMatrixThreadBindingSpawnError.mockReturnValue(undefined);
    hookMocks.unbindMatrixThreadBindingsBySessionKey.mockClear();
  });

  it("subagent_spawning creates binding on thread context", async () => {
    const { handlers } = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_spawning");

    const result = await handler({
      threadRequested: true,
      requester: {
        channel: "matrix",
        accountId: "work",
        to: "room:!room:example.org",
        threadId: "$thread-root",
      },
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "child",
    });

    expect(hookMocks.autoBindSpawnedMatrixSubagent).toHaveBeenCalledWith({
      accountId: "work",
      roomId: "!room:example.org",
      threadRootId: "$thread-root",
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "child",
      boundBy: "system",
    });
    expect(result).toEqual({ status: "ok", threadBindingReady: true });
  });

  it("subagent_spawning returns error for non-thread room", async () => {
    const { handlers } = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_spawning");

    const result = await handler({
      threadRequested: true,
      requester: {
        channel: "matrix",
        accountId: "work",
        to: "room:!room:example.org",
      },
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "child",
    });

    expect(hookMocks.autoBindSpawnedMatrixSubagent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error" });
    expect((result as { error?: string }).error ?? "").toContain("thread message context");
  });

  it("subagent_delivery_target returns correct room/thread", () => {
    hookMocks.listMatrixThreadBindingsBySessionKey.mockReturnValueOnce([
      {
        accountId: "work",
        roomId: "!room:example.org",
        threadRootId: "$thread-root",
      },
    ]);
    const { handlers } = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_delivery_target");

    const result = handler({
      expectsCompletionMessage: true,
      childSessionKey: "agent:main:subagent:child",
      requesterOrigin: {
        channel: "matrix",
        accountId: "work",
        to: "room:!room:example.org",
        threadId: "$thread-root",
      },
    });

    expect(result).toEqual({
      origin: {
        channel: "matrix",
        accountId: "work",
        to: "room:!room:example.org",
        threadId: "$thread-root",
      },
    });
  });

  it("subagent_ended removes binding", () => {
    const { handlers } = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_ended");

    handler({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
    });

    expect(hookMocks.unbindMatrixThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
      reason: "session_ended",
    });
  });

  it("subagent_spawning returns structured error when hook throws", async () => {
    hookMocks.autoBindSpawnedMatrixSubagent.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { handlers, api } = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_spawning");

    const result = await handler({
      threadRequested: true,
      requester: {
        channel: "matrix",
        accountId: "work",
        to: "room:!room:example.org",
        threadId: "$thread-root",
      },
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "child",
    });

    expect(result).toEqual({
      status: "error",
      error: "Internal error in Matrix thread binding hook",
    });
    expect(api.logger.error).toHaveBeenCalledWith(
      "matrix.thread.hook_handler_error",
      expect.objectContaining({ hookName: "subagent_spawning" }),
    );
  });
});
