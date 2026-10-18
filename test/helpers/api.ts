// A test harness for the board API: a Hono app that signs in a chosen user,
// mounts apiRouter at /api and turns errors into JSON with jsonError, exactly
// as src/worker/app.ts does behind its session check.

import { env } from "cloudflare:workers";
import { Hono } from "hono";
import type { ApiErrorBody } from "../../src/shared/api";
import type { User } from "../../src/shared/types";
import { apiRouter } from "../../src/worker/api/index";
import type { AppBindings } from "../../src/worker/env";
import { jsonError } from "../../src/worker/lib/http";

export interface ApiResult<T> {
  status: number;
  body: T;
}

type Method = "GET" | "POST" | "PATCH" | "PUT";

export class TestApi {
  readonly app = new Hono<AppBindings>();

  constructor(readonly userId: string) {
    this.app.use(async (c, next) => {
      const user = await env.DB.prepare(`SELECT id, email, display_name, initials, created_at FROM users WHERE id = ?`)
        .bind(userId)
        .first<User>();
      if (!user) throw new Error(`Test user ${userId} does not exist`);
      c.set("user", user);
      c.set("sessionId", "test-session");
      await next();
    });
    this.app.route("/api", apiRouter);
    this.app.onError(jsonError);
  }

  /** Send a request; `body` is sent as JSON, or as-is when it is already a string. */
  async send<T = unknown>(method: Method, path: string, body?: unknown): Promise<ApiResult<T>> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      if (body instanceof FormData) {
        init.body = body;
      } else if (typeof body === "string") {
        init.body = body;
        init.headers = { "content-type": "application/json" };
      } else {
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
    }
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(Promise.resolve(p));
      },
      passThroughOnException: () => {},
    } as ExecutionContext;
    const res = await this.app.request(path, init, env, executionCtx);
    const text = await res.text();
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    return { status: res.status, body: (text === "" ? null : JSON.parse(text)) as T };
  }

  get<T = unknown>(path: string) {
    return this.send<T>("GET", path);
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.send<T>("POST", path, body);
  }

  patch<T = unknown>(path: string, body?: unknown) {
    return this.send<T>("PATCH", path, body);
  }

  put<T = unknown>(path: string, body?: unknown) {
    return this.send<T>("PUT", path, body);
  }
}

export function asUser(userId: string): TestApi {
  return new TestApi(userId);
}

/** The body of a successful response; fails with the error body otherwise. */
export async function ok<T>(request: Promise<ApiResult<T>>): Promise<T> {
  const { status, body } = await request;
  if (status < 200 || status > 299) {
    throw new Error(`Expected success, got ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/** The error of a failed response, checked against the expected status. */
export async function fails(request: Promise<ApiResult<unknown>>, status: number): Promise<ApiErrorBody["error"]> {
  const result = await request;
  if (result.status !== status) {
    throw new Error(`Expected ${status}, got ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return (result.body as ApiErrorBody).error;
}
