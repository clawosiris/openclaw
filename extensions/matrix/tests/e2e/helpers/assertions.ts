import { expect } from "vitest";

export function assertDetectedThreadRoot(params: {
  content: Record<string, unknown>;
  expectedThreadRootId: string;
}) {
  const relates = params.content["m.relates_to"] as Record<string, unknown> | undefined;
  expect(relates).toBeTruthy();
  expect(relates?.rel_type).toBe("m.thread");
  expect(relates?.event_id).toBe(params.expectedThreadRootId);
}

export function assertBindingRecord(
  value: {
    roomId?: string;
    threadRootId?: string;
    targetSessionKey?: string;
  } | null,
  expected: {
    roomId: string;
    threadRootId: string;
    targetSessionKey: string;
  },
) {
  expect(value).toBeTruthy();
  expect(value?.roomId).toBe(expected.roomId);
  expect(value?.threadRootId).toBe(expected.threadRootId);
  expect(value?.targetSessionKey).toBe(expected.targetSessionKey);
}
