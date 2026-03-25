import { describe, expect, it } from "vitest";
import { parseSandboxBindOptions, splitSandboxBindSpec } from "./bind-spec.js";

describe("splitSandboxBindSpec", () => {
  it("splits POSIX bind specs with and without mode", () => {
    expect(splitSandboxBindSpec("/tmp/a:/workspace-a:ro")).toEqual({
      host: "/tmp/a",
      container: "/workspace-a",
      options: "ro",
    });
    expect(splitSandboxBindSpec("/tmp/b:/workspace-b")).toEqual({
      host: "/tmp/b",
      container: "/workspace-b",
      options: "",
    });
  });

  it("preserves Windows drive-letter host paths", () => {
    expect(splitSandboxBindSpec("C:\\Users\\kai\\workspace:/workspace:ro")).toEqual({
      host: "C:\\Users\\kai\\workspace",
      container: "/workspace",
      options: "ro",
    });
  });

  it("returns null when no host/container separator exists", () => {
    expect(splitSandboxBindSpec("/tmp/no-separator")).toBeNull();
  });

  it("parses idmap bind options", () => {
    expect(parseSandboxBindOptions("rw,idmap")).toEqual({ mode: "rw", idmap: true });
    expect(parseSandboxBindOptions("ro,idmap")).toEqual({ mode: "ro", idmap: true });
    expect(parseSandboxBindOptions("idmap")).toEqual({ mode: "rw", idmap: true });
    expect(parseSandboxBindOptions("")).toEqual({ mode: "rw", idmap: false });
  });

  it("rejects unsupported idmap combinations", () => {
    expect(parseSandboxBindOptions("ro,idmap,z")).toBeNull();
  });
});
