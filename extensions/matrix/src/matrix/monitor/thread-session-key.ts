import crypto from "node:crypto";

function normalizeThreadRootId(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  return value;
}

export function normalizeMatrixThreadSessionSuffix(threadRootId: string): string | undefined {
  const normalized = normalizeThreadRootId(threadRootId);
  if (!normalized) {
    return undefined;
  }
  const digest = crypto.createHash("sha256").update(normalized).digest("base64url");
  return `th_${digest.slice(0, 32)}`;
}

export function deriveNormalizedMatrixThreadSessionKey(params: {
  baseSessionKey: string;
  threadRootId: string;
}): string {
  const suffix = normalizeMatrixThreadSessionSuffix(params.threadRootId);
  if (!suffix) {
    return params.baseSessionKey;
  }
  return `${params.baseSessionKey}:thread:${suffix}`;
}

export function deriveLegacyMatrixThreadSessionKey(params: {
  baseSessionKey: string;
  threadRootId: string;
}): string {
  return `${params.baseSessionKey}:thread:${params.threadRootId}`;
}

export function resolveMatrixThreadSessionKeyWithDualLookup(params: {
  baseSessionKey: string;
  threadRootId: string;
  legacySuffixLookup: boolean;
  hasSessionKey: (sessionKey: string) => boolean;
}): { sessionKey: string; usedLegacySuffix: boolean } {
  const normalizedKey = deriveNormalizedMatrixThreadSessionKey({
    baseSessionKey: params.baseSessionKey,
    threadRootId: params.threadRootId,
  });
  if (!params.legacySuffixLookup) {
    return { sessionKey: normalizedKey, usedLegacySuffix: false };
  }
  if (params.hasSessionKey(normalizedKey)) {
    return { sessionKey: normalizedKey, usedLegacySuffix: false };
  }
  const legacyKey = deriveLegacyMatrixThreadSessionKey({
    baseSessionKey: params.baseSessionKey,
    threadRootId: params.threadRootId,
  });
  if (params.hasSessionKey(legacyKey)) {
    return { sessionKey: legacyKey, usedLegacySuffix: true };
  }
  return { sessionKey: normalizedKey, usedLegacySuffix: false };
}
