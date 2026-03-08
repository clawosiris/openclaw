import { describe, expect, it } from "vitest";
import {
  deriveLegacyMatrixThreadSessionKey,
  deriveNormalizedMatrixThreadSessionKey,
  normalizeMatrixThreadSessionSuffix,
  resolveMatrixThreadSessionKeyWithDualLookup,
} from "../../src/matrix/monitor/thread-session-key.js";

describe("matrix thread session key normalization", () => {
  it("normalizeMatrixThreadSessionSuffix produces deterministic output", () => {
    const first = normalizeMatrixThreadSessionSuffix("$thread-root:example.org");
    const second = normalizeMatrixThreadSessionSuffix("$thread-root:example.org");

    expect(first).toBe(second);
    expect(first).toMatch(/^th_[A-Za-z0-9_-]{32}$/);
  });

  it("handles special characters (:, $, !)", () => {
    const suffix = normalizeMatrixThreadSessionSuffix("!room:example.org/$event$root");

    expect(suffix).toBeDefined();
    expect(suffix).toMatch(/^th_[A-Za-z0-9_-]{32}$/);
    expect(suffix).not.toContain(":");
    expect(suffix).not.toContain("$");
    expect(suffix).not.toContain("!");
  });

  it("dual lookup prefers normalized, falls back to legacy", () => {
    const baseSessionKey = "agent:main:matrix:channel:!room:example.org";
    const threadRootId = "$thread-root:example.org";
    const normalized = deriveNormalizedMatrixThreadSessionKey({
      baseSessionKey,
      threadRootId,
    });
    const legacy = deriveLegacyMatrixThreadSessionKey({
      baseSessionKey,
      threadRootId,
    });

    const preferNormalized = resolveMatrixThreadSessionKeyWithDualLookup({
      baseSessionKey,
      threadRootId,
      legacySuffixLookup: true,
      hasSessionKey: (sessionKey) => sessionKey === normalized || sessionKey === legacy,
    });
    expect(preferNormalized).toEqual({
      sessionKey: normalized,
      usedLegacySuffix: false,
    });

    const fallbackLegacy = resolveMatrixThreadSessionKeyWithDualLookup({
      baseSessionKey,
      threadRootId,
      legacySuffixLookup: true,
      hasSessionKey: (sessionKey) => sessionKey === legacy,
    });
    expect(fallbackLegacy).toEqual({
      sessionKey: legacy,
      usedLegacySuffix: true,
    });
  });
});
