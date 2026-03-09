import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";

type ComposeRunner = {
  command: string;
  baseArgs: string[];
};

const MATRIX_E2E_ENABLED = process.env.MATRIX_E2E === "true";
const setupDir = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(setupDir, "..", "docker-compose.matrix.yml");
const homeserver = (process.env.MATRIX_E2E_HOMESERVER ?? "http://127.0.0.1:18008").replace(
  /\/+$/,
  "",
);

function resolveComposeRunner(): ComposeRunner {
  const dockerComposeV2 = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!dockerComposeV2.error && dockerComposeV2.status === 0) {
    return { command: "docker", baseArgs: ["compose"] };
  }
  const dockerComposeV1 = spawnSync("docker-compose", ["version"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!dockerComposeV1.error && dockerComposeV1.status === 0) {
    return { command: "docker-compose", baseArgs: [] };
  }
  throw new Error("Matrix E2E requires docker compose (docker compose or docker-compose).");
}

function runCompose(runner: ComposeRunner, args: string[]) {
  const result = spawnSync(runner.command, [...runner.baseArgs, "-f", composeFile, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `docker compose failed: ${[runner.command, ...runner.baseArgs, ...args].join(" ")}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function waitForHomeserverReady(timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${homeserver}/_matrix/client/versions`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Timed out waiting for Matrix homeserver at ${homeserver}`);
}

let composeRunner: ComposeRunner | null = null;

beforeAll(async () => {
  if (!MATRIX_E2E_ENABLED) {
    return;
  }
  composeRunner = resolveComposeRunner();
  runCompose(composeRunner, ["up", "-d", "--remove-orphans"]);
  const timeoutMs = Number.parseInt(process.env.MATRIX_E2E_STARTUP_TIMEOUT_MS ?? "", 10);
  await waitForHomeserverReady(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000);
});

afterAll(() => {
  if (!MATRIX_E2E_ENABLED || !composeRunner) {
    return;
  }
  try {
    runCompose(composeRunner, ["down", "-v", "--remove-orphans"]);
  } catch {
    // Best-effort cleanup for local E2E runs.
  }
});
