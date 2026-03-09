import { MatrixTestClient, registerOrLoginMatrixUser } from "./matrix-test-client.js";

type MatrixFixtureUsers = {
  human: MatrixTestClient;
  botA: MatrixTestClient;
  botB: MatrixTestClient;
};

export type MatrixThreadFixture = {
  roomId: string;
  threadRootId: string;
  threadReplyId: string;
  siblingThreadRootId: string;
};

export function resolveMatrixE2EHomeserver(): string {
  return (process.env.MATRIX_E2E_HOMESERVER ?? "http://127.0.0.1:18008").trim();
}

export async function provisionMatrixFixtureUsers(): Promise<MatrixFixtureUsers> {
  const homeserver = resolveMatrixE2EHomeserver();
  const [humanAuth, botAAuth, botBAuth] = await Promise.all([
    registerOrLoginMatrixUser({
      homeserver,
      username: "openclaw_e2e_human",
      password: "openclaw-e2e-password",
    }),
    registerOrLoginMatrixUser({
      homeserver,
      username: "openclaw_e2e_bot_a",
      password: "openclaw-e2e-password",
    }),
    registerOrLoginMatrixUser({
      homeserver,
      username: "openclaw_e2e_bot_b",
      password: "openclaw-e2e-password",
    }),
  ]);
  return {
    human: new MatrixTestClient(humanAuth),
    botA: new MatrixTestClient(botAAuth),
    botB: new MatrixTestClient(botBAuth),
  };
}

export async function createMatrixThreadFixture(
  users: MatrixFixtureUsers,
): Promise<MatrixThreadFixture> {
  const roomId = await users.human.createRoom({
    name: `OpenClaw Matrix E2E ${Date.now()}`,
    invite: [users.botA.userId, users.botB.userId],
  });
  await Promise.all([users.botA.joinRoom(roomId), users.botB.joinRoom(roomId)]);
  const threadRootId = await users.human.sendText(roomId, "thread-root: session test");
  const threadReplyId = await users.human.sendThreadReply({
    roomId,
    threadRootId,
    body: "thread-message: routed follow-up",
  });
  const siblingThreadRootId = await users.human.sendText(roomId, "thread-root: sibling");
  return {
    roomId,
    threadRootId,
    threadReplyId,
    siblingThreadRootId,
  };
}
