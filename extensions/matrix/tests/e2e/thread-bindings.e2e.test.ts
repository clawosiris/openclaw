import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { getSessionBindingService } from "openclaw/plugin-sdk/matrix";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __testing as sessionBindingTesting } from "../../../../src/infra/outbound/session-binding-service.js";
import {
  createMatrixThreadBindingManager,
  toMatrixConversationId,
} from "../../src/matrix/monitor/thread-bindings.manager.js";
import { resetMatrixThreadBindingsForTests } from "../../src/matrix/monitor/thread-bindings.state.js";
import { deriveNormalizedMatrixThreadSessionKey } from "../../src/matrix/monitor/thread-session-key.js";
import { resolveMatrixThreadRootId } from "../../src/matrix/monitor/threads.js";
import { setMatrixRuntime } from "../../src/runtime.js";
import { registerMatrixSubagentHooks } from "../../src/subagent-hooks.js";
import { assertBindingRecord, assertDetectedThreadRoot } from "./helpers/assertions.js";
import { createMatrixThreadFixture, provisionMatrixFixtureUsers } from "./helpers/test-fixtures.js";

const MATRIX_E2E_ENABLED = process.env.MATRIX_E2E === "true";

type SpawnHookResult = {
  status: "ok" | "error";
  threadBindingReady?: boolean;
  error?: string;
};

type HookHandler = (event: unknown) => unknown;

function createRuntimeForStateDir(stateDir: string): PluginRuntime {
  return {
    state: {
      resolveStateDir: () => stateDir,
    },
  } as unknown as PluginRuntime;
}

function registerSubagentHookHarness(cfg: Record<string, unknown> = {}) {
  const handlers = new Map<string, HookHandler>();
  registerMatrixSubagentHooks({
    config: cfg,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    on: (hookName: string, handler: HookHandler) => {
      handlers.set(hookName, handler);
    },
  } as never);
  return handlers;
}

function getRequiredHook(handlers: Map<string, HookHandler>, hookName: string): HookHandler {
  const handler = handlers.get(hookName);
  if (!handler) {
    throw new Error(`missing hook handler: ${hookName}`);
  }
  return handler;
}

describe.skipIf(!MATRIX_E2E_ENABLED)("matrix thread bindings e2e", () => {
  let stateDir = "";
  let users: Awaited<ReturnType<typeof provisionMatrixFixtureUsers>>;

  beforeAll(async () => {
    users = await provisionMatrixFixtureUsers();
  });

  afterAll(() => {
    resetMatrixThreadBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    resetMatrixThreadBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-thread-bindings-e2e-"));
    setMatrixRuntime(createRuntimeForStateDir(stateDir));
  });

  afterEach(() => {
    resetMatrixThreadBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
  });

  it("detects thread roots and generates thread-scoped session keys", async () => {
    const fixture = await createMatrixThreadFixture(users);
    const threadEvent = await users.human.waitForEvent({
      roomId: fixture.roomId,
      eventId: fixture.threadReplyId,
    });
    const content = (threadEvent.content ?? {}) as Record<string, unknown>;
    const detectedRoot = resolveMatrixThreadRootId({
      event: threadEvent as never,
      content: content as never,
    });
    expect(detectedRoot).toBe(fixture.threadRootId);
    assertDetectedThreadRoot({
      content,
      expectedThreadRootId: fixture.threadRootId,
    });

    const baseSessionKey = "agent:main:matrix:room";
    const keyForThread = deriveNormalizedMatrixThreadSessionKey({
      baseSessionKey,
      threadRootId: fixture.threadRootId,
    });
    const keyForSiblingThread = deriveNormalizedMatrixThreadSessionKey({
      baseSessionKey,
      threadRootId: fixture.siblingThreadRootId,
    });
    expect(keyForThread).toContain(":thread:th_");
    expect(keyForThread).not.toBe(keyForSiblingThread);
  });

  it("creates a spawn binding record for the active thread context", async () => {
    const fixture = await createMatrixThreadFixture(users);
    const manager = createMatrixThreadBindingManager({
      accountId: "bot-a",
      idleTimeoutMs: 5 * 60_000,
      maxAgeMs: 20 * 60_000,
      enableSweeper: false,
    });
    const hooks = registerSubagentHookHarness();
    const spawn = getRequiredHook(hooks, "subagent_spawning");

    const result = (await spawn({
      threadRequested: true,
      requester: {
        channel: "matrix",
        accountId: "bot-a",
        to: `room:${fixture.roomId}`,
        threadId: fixture.threadRootId,
      },
      childSessionKey: "agent:main:subagent:child-a",
      agentId: "main",
      label: "child-a",
    })) as SpawnHookResult;

    expect(result.status).toBe("ok");
    expect(result.threadBindingReady).toBe(true);
    const record = manager.resolveByConversation({
      roomId: fixture.roomId,
      threadRootId: fixture.threadRootId,
    });
    assertBindingRecord(record, {
      roomId: fixture.roomId,
      threadRootId: fixture.threadRootId,
      targetSessionKey: "agent:main:subagent:child-a",
    });
  });

  it("routes follow-up thread messages to bound sessions instead of derived new session keys", async () => {
    const fixture = await createMatrixThreadFixture(users);
    createMatrixThreadBindingManager({
      accountId: "bot-a",
      idleTimeoutMs: 5 * 60_000,
      maxAgeMs: 20 * 60_000,
      enableSweeper: false,
    }).bindTarget({
      roomId: fixture.roomId,
      threadRootId: fixture.threadRootId,
      targetSessionKey: "agent:main:subagent:thread-bound",
      targetKind: "subagent",
      agentId: "main",
    });

    const followupId = await users.human.sendThreadReply({
      roomId: fixture.roomId,
      threadRootId: fixture.threadRootId,
      body: "follow-up: should route to existing bound child",
    });
    const followupEvent = await users.human.waitForEvent({
      roomId: fixture.roomId,
      eventId: followupId,
    });
    const followupContent = (followupEvent.content ?? {}) as Record<string, unknown>;
    const threadRootId = resolveMatrixThreadRootId({
      event: followupEvent as never,
      content: followupContent as never,
    });
    expect(threadRootId).toBe(fixture.threadRootId);

    const bound = getSessionBindingService().resolveByConversation({
      channel: "matrix",
      accountId: "bot-a",
      conversationId: toMatrixConversationId({
        roomId: fixture.roomId,
        threadRootId: fixture.threadRootId,
      }),
      parentConversationId: fixture.roomId,
    });
    const baseSessionKey = "agent:main:matrix:room";
    const derivedFallback = deriveNormalizedMatrixThreadSessionKey({
      baseSessionKey,
      threadRootId: fixture.threadRootId,
    });

    expect(bound?.targetSessionKey).toBe("agent:main:subagent:thread-bound");
    expect(bound?.targetSessionKey).not.toBe(derivedFallback);
  });

  it("delivers completion back to the same bound thread", async () => {
    const fixture = await createMatrixThreadFixture(users);
    createMatrixThreadBindingManager({
      accountId: "bot-a",
      idleTimeoutMs: 5 * 60_000,
      maxAgeMs: 20 * 60_000,
      enableSweeper: false,
    });
    const hooks = registerSubagentHookHarness();
    const spawn = getRequiredHook(hooks, "subagent_spawning");
    const deliveryTarget = getRequiredHook(hooks, "subagent_delivery_target");

    await spawn({
      threadRequested: true,
      requester: {
        channel: "matrix",
        accountId: "bot-a",
        to: `room:${fixture.roomId}`,
        threadId: fixture.threadRootId,
      },
      childSessionKey: "agent:main:subagent:child-completion",
      agentId: "main",
      label: "child-completion",
    });

    const target = deliveryTarget({
      expectsCompletionMessage: true,
      childSessionKey: "agent:main:subagent:child-completion",
      requesterOrigin: {
        channel: "matrix",
        accountId: "bot-a",
        to: `room:${fixture.roomId}`,
        threadId: fixture.threadRootId,
      },
    }) as {
      origin?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string;
      };
    };

    expect(target.origin?.channel).toBe("matrix");
    expect(target.origin?.to).toBe(`room:${fixture.roomId}`);
    expect(target.origin?.threadId).toBe(fixture.threadRootId);

    const completionEventId = await users.botA.sendThreadReply({
      roomId: fixture.roomId,
      threadRootId: String(target.origin?.threadId ?? ""),
      body: "completion: child session ended",
    });
    const completionEvent = await users.botA.waitForEvent({
      roomId: fixture.roomId,
      eventId: completionEventId,
    });
    const completionContent = (completionEvent.content ?? {}) as Record<string, unknown>;
    assertDetectedThreadRoot({
      content: completionContent,
      expectedThreadRootId: fixture.threadRootId,
    });
  });

  it("cleans up bindings when a subagent session ends", async () => {
    const fixture = await createMatrixThreadFixture(users);
    const manager = createMatrixThreadBindingManager({
      accountId: "bot-a",
      idleTimeoutMs: 5 * 60_000,
      maxAgeMs: 20 * 60_000,
      enableSweeper: false,
    });
    const hooks = registerSubagentHookHarness();
    const spawn = getRequiredHook(hooks, "subagent_spawning");
    const ended = getRequiredHook(hooks, "subagent_ended");

    await spawn({
      threadRequested: true,
      requester: {
        channel: "matrix",
        accountId: "bot-a",
        to: `room:${fixture.roomId}`,
        threadId: fixture.threadRootId,
      },
      childSessionKey: "agent:main:subagent:child-cleanup",
      agentId: "main",
      label: "child-cleanup",
    });
    expect(
      manager.resolveByConversation({
        roomId: fixture.roomId,
        threadRootId: fixture.threadRootId,
      }),
    ).toBeTruthy();

    ended({
      targetSessionKey: "agent:main:subagent:child-cleanup",
      accountId: "bot-a",
      targetKind: "subagent",
    });

    expect(
      manager.resolveByConversation({
        roomId: fixture.roomId,
        threadRootId: fixture.threadRootId,
      }),
    ).toBeNull();
  });

  it("isolates bindings across bot accounts in the same room/thread", async () => {
    const fixture = await createMatrixThreadFixture(users);
    createMatrixThreadBindingManager({
      accountId: "bot-a",
      idleTimeoutMs: 5 * 60_000,
      maxAgeMs: 20 * 60_000,
      enableSweeper: false,
    }).bindTarget({
      roomId: fixture.roomId,
      threadRootId: fixture.threadRootId,
      targetSessionKey: "agent:main:subagent:account-a",
      targetKind: "subagent",
    });
    createMatrixThreadBindingManager({
      accountId: "bot-b",
      idleTimeoutMs: 5 * 60_000,
      maxAgeMs: 20 * 60_000,
      enableSweeper: false,
    }).bindTarget({
      roomId: fixture.roomId,
      threadRootId: fixture.threadRootId,
      targetSessionKey: "agent:main:subagent:account-b",
      targetKind: "subagent",
    });

    const forAccountA = getSessionBindingService().resolveByConversation({
      channel: "matrix",
      accountId: "bot-a",
      conversationId: toMatrixConversationId({
        roomId: fixture.roomId,
        threadRootId: fixture.threadRootId,
      }),
      parentConversationId: fixture.roomId,
    });
    const forAccountB = getSessionBindingService().resolveByConversation({
      channel: "matrix",
      accountId: "bot-b",
      conversationId: toMatrixConversationId({
        roomId: fixture.roomId,
        threadRootId: fixture.threadRootId,
      }),
      parentConversationId: fixture.roomId,
    });

    expect(forAccountA?.targetSessionKey).toBe("agent:main:subagent:account-a");
    expect(forAccountB?.targetSessionKey).toBe("agent:main:subagent:account-b");
    expect(forAccountA?.targetSessionKey).not.toBe(forAccountB?.targetSessionKey);
  });
});
