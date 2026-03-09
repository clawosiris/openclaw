import { MatrixClient } from "@vector-im/matrix-bot-sdk";

export type MatrixTestAuth = {
  homeserver: string;
  userId: string;
  accessToken: string;
};

type RegisterOrLoginResult = {
  user_id: string;
  access_token: string;
};

function resolveRetryDelayMs(error: unknown, attempt: number): number {
  const fallback = 500 * Math.max(1, attempt + 1);
  if (!error || typeof error !== "object") {
    return fallback;
  }
  const asRecord = error as Record<string, unknown>;
  if (typeof asRecord.retry_after_ms === "number" && Number.isFinite(asRecord.retry_after_ms)) {
    return Math.max(250, Math.floor(asRecord.retry_after_ms));
  }
  const message =
    typeof asRecord.message === "string"
      ? asRecord.message
      : error instanceof Error
        ? error.message
        : String(error);
  const retryMatch = message.match(/retry_after_ms['"]?\s*[:=]\s*(\d+)/i);
  if (!retryMatch) {
    return fallback;
  }
  const parsed = Number.parseInt(retryMatch[1] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function withRateLimitRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (attempt < 6) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("M_LIMIT_EXCEEDED") || attempt >= 5) {
        throw error;
      }
      const waitMs = resolveRetryDelayMs(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    }
  }
  throw new Error("unreachable");
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return await withRateLimitRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payloadText = await response.text();
    const payload = payloadText ? (JSON.parse(payloadText) as Record<string, unknown>) : {};
    if (!response.ok) {
      const errCode = typeof payload.errcode === "string" ? payload.errcode : "unknown";
      const errMessage = typeof payload.error === "string" ? payload.error : payloadText;
      const error = new Error(`${response.status} ${errCode}: ${errMessage}`) as Error & {
        retry_after_ms?: number;
      };
      if (typeof payload.retry_after_ms === "number") {
        error.retry_after_ms = payload.retry_after_ms;
      }
      throw error;
    }
    return payload as T;
  });
}

export async function registerOrLoginMatrixUser(params: {
  homeserver: string;
  username: string;
  password: string;
}): Promise<MatrixTestAuth> {
  const homeserver = params.homeserver.replace(/\/+$/, "");
  const username = params.username.trim();
  const password = params.password;
  try {
    const registered = await postJson<RegisterOrLoginResult>(
      `${homeserver}/_matrix/client/v3/register`,
      {
        username,
        password,
        auth: { type: "m.login.dummy" },
      },
    );
    return {
      homeserver,
      userId: registered.user_id,
      accessToken: registered.access_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("M_USER_IN_USE")) {
      throw error;
    }
    const loggedIn = await postJson<RegisterOrLoginResult>(
      `${homeserver}/_matrix/client/v3/login`,
      {
        type: "m.login.password",
        user: username,
        password,
      },
    );
    return {
      homeserver,
      userId: loggedIn.user_id,
      accessToken: loggedIn.access_token,
    };
  }
}

export class MatrixTestClient {
  readonly auth: MatrixTestAuth;
  readonly client: MatrixClient;

  constructor(auth: MatrixTestAuth) {
    this.auth = auth;
    this.client = new MatrixClient(auth.homeserver, auth.accessToken);
  }

  get userId(): string {
    return this.auth.userId;
  }

  async createRoom(params: { name: string; invite?: string[] }): Promise<string> {
    return await withRateLimitRetry(
      async () =>
        await this.client.createRoom({
          name: params.name,
          preset: "private_chat",
          invite: params.invite ?? [],
        }),
    );
  }

  async inviteUser(roomId: string, userId: string): Promise<void> {
    await withRateLimitRetry(async () => await this.client.inviteUser(userId, roomId));
  }

  async joinRoom(roomId: string): Promise<void> {
    await withRateLimitRetry(async () => await this.client.joinRoom(roomId));
  }

  async sendText(roomId: string, body: string): Promise<string> {
    return await withRateLimitRetry(
      async () =>
        await this.client.sendMessage(roomId, {
          msgtype: "m.text",
          body,
        }),
    );
  }

  async sendThreadReply(params: {
    roomId: string;
    threadRootId: string;
    body: string;
    replyToId?: string;
  }): Promise<string> {
    return await withRateLimitRetry(
      async () =>
        await this.client.sendMessage(params.roomId, {
          msgtype: "m.text",
          body: params.body,
          "m.relates_to": {
            rel_type: "m.thread",
            event_id: params.threadRootId,
            is_falling_back: true,
            "m.in_reply_to": {
              event_id: params.replyToId?.trim() || params.threadRootId,
            },
          },
        }),
    );
  }

  async getEvent(roomId: string, eventId: string): Promise<Record<string, unknown>> {
    return await withRateLimitRetry(
      async () =>
        (await this.client.doRequest(
          "GET",
          `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
        )) as Record<string, unknown>,
    );
  }

  async waitForEvent(params: {
    roomId: string;
    eventId: string;
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<Record<string, unknown>> {
    const timeoutMs = params.timeoutMs ?? 15_000;
    const pollMs = params.pollMs ?? 250;
    const started = Date.now();
    // Poll event endpoint to avoid syncing full timelines in tests.
    while (Date.now() - started < timeoutMs) {
      try {
        return await this.getEvent(params.roomId, params.eventId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("M_NOT_FOUND")) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`timed out waiting for event ${params.eventId}`);
  }
}
