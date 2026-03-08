import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixThreadBindingManager } from "../../src/matrix/monitor/thread-bindings.manager.js";
import { resetMatrixThreadBindingsForTests } from "../../src/matrix/monitor/thread-bindings.state.js";
import { setMatrixRuntime } from "../../src/runtime.js";

function createRuntimeForStateDir(stateDir: string): PluginRuntime {
  return {
    state: {
      resolveStateDir: () => stateDir,
    },
  } as unknown as PluginRuntime;
}

describe("matrix thread binding manager", () => {
  let stateDir = "";

  beforeEach(() => {
    resetMatrixThreadBindingsForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-thread-bindings-manager-test-"));
    setMatrixRuntime(createRuntimeForStateDir(stateDir));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
  });

  afterEach(() => {
    resetMatrixThreadBindingsForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("bindTarget creates binding correctly", () => {
    const manager = createMatrixThreadBindingManager({
      accountId: "work",
      idleTimeoutMs: 60_000,
      maxAgeMs: 120_000,
      enableSweeper: false,
    });

    const result = manager.bindTarget({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      agentId: "main",
      label: "child",
      boundBy: "system",
    });

    expect(result.error).toBeUndefined();
    expect(result.record).toMatchObject({
      accountId: "work",
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      agentId: "main",
      label: "child",
      boundBy: "system",
    });
    expect(result.record?.bindingId).toBe("matrix:work:!room:example.org||$thread-1");
  });

  it("resolveByConversation returns correct binding", () => {
    const manager = createMatrixThreadBindingManager({
      accountId: "work",
      idleTimeoutMs: 60_000,
      maxAgeMs: 120_000,
      enableSweeper: false,
    });
    manager.bindTarget({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
      targetSessionKey: "agent:main:subagent:child",
    });

    const resolved = manager.resolveByConversation({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
    });

    expect(resolved?.targetSessionKey).toBe("agent:main:subagent:child");
  });

  it("touchByConversation updates lastActivityAt", () => {
    const manager = createMatrixThreadBindingManager({
      accountId: "work",
      idleTimeoutMs: 60_000,
      maxAgeMs: 120_000,
      enableSweeper: false,
    });
    const bound = manager.bindTarget({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
      targetSessionKey: "agent:main:subagent:child",
    });
    const initial = bound.record;
    if (!initial) {
      throw new Error("missing record");
    }

    vi.advanceTimersByTime(5_000);
    const touched = manager.touchByConversation({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
    });

    expect(touched?.lastActivityAt).toBeGreaterThan(initial.lastActivityAt);
  });

  it("unbindByConversation removes binding", () => {
    const manager = createMatrixThreadBindingManager({
      accountId: "work",
      idleTimeoutMs: 60_000,
      maxAgeMs: 120_000,
      enableSweeper: false,
    });
    manager.bindTarget({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
      targetSessionKey: "agent:main:subagent:child",
    });

    const removed = manager.unbindByConversation({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
      reason: "manual",
    });
    const resolved = manager.resolveByConversation({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
    });

    expect(removed?.targetSessionKey).toBe("agent:main:subagent:child");
    expect(resolved).toBeNull();
  });

  it("unbindBySessionKey removes all bindings for session", () => {
    const manager = createMatrixThreadBindingManager({
      accountId: "work",
      idleTimeoutMs: 60_000,
      maxAgeMs: 120_000,
      enableSweeper: false,
    });
    manager.bindTarget({
      roomId: "!room:a",
      threadRootId: "$thread-1",
      targetSessionKey: "agent:main:subagent:child",
    });
    manager.bindTarget({
      roomId: "!room:b",
      threadRootId: "$thread-2",
      targetSessionKey: "agent:main:subagent:child",
    });

    const removed = manager.unbindBySessionKey({
      targetSessionKey: "agent:main:subagent:child",
      reason: "session_ended",
    });

    expect(removed).toHaveLength(2);
    expect(manager.listBySessionKey("agent:main:subagent:child")).toHaveLength(0);
  });

  it("sweepExpiredBindings removes idle/max-age expired bindings", () => {
    const idleManager = createMatrixThreadBindingManager({
      accountId: "work-idle",
      idleTimeoutMs: 1_000,
      maxAgeMs: 0,
      enableSweeper: false,
    });
    idleManager.bindTarget({
      roomId: "!room:idle",
      threadRootId: "$idle",
      targetSessionKey: "agent:main:subagent:idle",
    });

    const ageManager = createMatrixThreadBindingManager({
      accountId: "work-age",
      idleTimeoutMs: 0,
      maxAgeMs: 1_000,
      enableSweeper: false,
    });
    ageManager.bindTarget({
      roomId: "!room:age",
      threadRootId: "$age",
      targetSessionKey: "agent:main:subagent:age",
    });

    vi.advanceTimersByTime(1_500);

    expect(idleManager.sweepExpiredBindings()).toBe(1);
    expect(ageManager.sweepExpiredBindings()).toBe(1);
    expect(idleManager.listBindings()).toHaveLength(0);
    expect(ageManager.listBindings()).toHaveLength(0);
  });

  it("maxActiveBindings limit is enforced", () => {
    const manager = createMatrixThreadBindingManager({
      accountId: "work",
      idleTimeoutMs: 60_000,
      maxAgeMs: 120_000,
      maxActiveBindings: 1,
      enableSweeper: false,
    });
    const first = manager.bindTarget({
      roomId: "!room:a",
      threadRootId: "$thread-1",
      targetSessionKey: "agent:main:subagent:a",
    });
    const second = manager.bindTarget({
      roomId: "!room:b",
      threadRootId: "$thread-2",
      targetSessionKey: "agent:main:subagent:b",
    });

    expect(first.record).not.toBeNull();
    expect(second.record).toBeNull();
    expect(second.error).toContain("thread binding limit reached");
  });
});
