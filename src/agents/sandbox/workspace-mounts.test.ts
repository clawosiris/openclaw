import { describe, expect, it } from "vitest";
import { appendWorkspaceMountArgs } from "./workspace-mounts.js";

describe("appendWorkspaceMountArgs", () => {
  it.each([
    { access: "rw" as const, expected: "/tmp/workspace:/workspace" },
    { access: "ro" as const, expected: "/tmp/workspace:/workspace:ro" },
    { access: "none" as const, expected: "/tmp/workspace:/workspace:ro" },
  ])("sets main mount permissions for workspaceAccess=$access", ({ access, expected }) => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: access,
    });

    expect(args).toContain(expected);
  });

  it("omits agent workspace mount when workspaceAccess is none", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "none",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro"]);
  });

  it("omits agent workspace mount when paths are identical", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace"]);
  });

  it("uses --mount with idmap when workspaceIdmap is enabled", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "ro",
      workspaceIdmap: true,
    });

    expect(args).toEqual([
      "--mount",
      "type=bind,source=/tmp/workspace,target=/workspace,readonly,idmap",
      "--mount",
      "type=bind,source=/tmp/agent-workspace,target=/agent,readonly,idmap",
    ]);
  });
});
