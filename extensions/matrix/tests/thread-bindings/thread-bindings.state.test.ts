import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixThreadBindingManager } from "../../src/matrix/monitor/thread-bindings.manager.js";
import {
  ensureMatrixThreadBindingsLoaded,
  flushMatrixBindingsPersist,
  resetMatrixThreadBindingsForTests,
  resolveMatrixThreadBindingsPath,
} from "../../src/matrix/monitor/thread-bindings.state.js";
import { setMatrixRuntime } from "../../src/runtime.js";

function createRuntimeForStateDir(stateDir: string): PluginRuntime {
  return {
    state: {
      resolveStateDir: () => stateDir,
    },
  } as unknown as PluginRuntime;
}

describe("matrix thread bindings state", () => {
  let stateDir = "";

  beforeEach(() => {
    resetMatrixThreadBindingsForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-thread-bindings-test-"));
    setMatrixRuntime(createRuntimeForStateDir(stateDir));
  });

  afterEach(() => {
    resetMatrixThreadBindingsForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes atomically using tmp + rename", () => {
    const renameSpy = vi.spyOn(fs, "renameSync");
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

    flushMatrixBindingsPersist();

    const pathname = resolveMatrixThreadBindingsPath();
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [tmpPath, finalPath] = renameSpy.mock.calls[0] ?? [];
    expect(String(tmpPath)).toContain(`${pathname}.tmp.`);
    expect(finalPath).toBe(pathname);
    expect(fs.existsSync(pathname)).toBe(true);
  });

  it("recovers from corrupted file by renaming and logging", () => {
    const logger = { error: vi.fn() };
    const pathname = resolveMatrixThreadBindingsPath();
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, "{ this is invalid json", "utf8");

    ensureMatrixThreadBindingsLoaded(logger);

    expect(fs.existsSync(pathname)).toBe(false);
    const entries = fs.readdirSync(path.dirname(pathname));
    expect(entries.some((entry) => entry.startsWith("thread-bindings.json.corrupt."))).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "matrix.thread.persistence_corrupt",
      expect.objectContaining({ path: pathname }),
    );
  });

  it("reloads persisted state on startup", () => {
    const pathname = resolveMatrixThreadBindingsPath();
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(
      pathname,
      `${JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              bindingId: "matrix:work:!room:example.org||$thread-1",
              accountId: "work",
              roomId: "!room:example.org",
              threadRootId: "$thread-1",
              targetKind: "subagent",
              targetSessionKey: "agent:main:subagent:child",
              boundAt: 1_700_000_000_000,
              lastActivityAt: 1_700_000_000_000,
              idleTimeoutMs: 60_000,
              maxAgeMs: 120_000,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    ensureMatrixThreadBindingsLoaded();
    const manager = createMatrixThreadBindingManager({
      accountId: "work",
      idleTimeoutMs: 60_000,
      maxAgeMs: 120_000,
      enableSweeper: false,
    });

    const resolved = manager.resolveByConversation({
      roomId: "!room:example.org",
      threadRootId: "$thread-1",
    });

    expect(resolved).toMatchObject({
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
    });
  });
});
