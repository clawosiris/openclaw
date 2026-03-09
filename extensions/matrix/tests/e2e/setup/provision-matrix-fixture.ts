import {
  createMatrixThreadFixture,
  provisionMatrixFixtureUsers,
} from "../helpers/test-fixtures.js";

async function main() {
  const users = await provisionMatrixFixtureUsers();
  const fixture = await createMatrixThreadFixture(users);
  const summary = {
    homeserver: process.env.MATRIX_E2E_HOMESERVER ?? "http://127.0.0.1:18008",
    users: {
      human: users.human.userId,
      botA: users.botA.userId,
      botB: users.botB.userId,
    },
    fixture,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
