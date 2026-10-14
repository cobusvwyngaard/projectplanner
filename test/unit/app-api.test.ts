import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, captureAudioUrl, loginUrl, queryString, revertConflicts } from "../../src/app/api";

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn<(url: string) => void>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { pathname: "/list", search: "?tab=mine", assign } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queryString", () => {
  it("leaves out empty values", () => {
    expect(queryString({ a: "1", b: undefined, c: null, d: "", e: 0 })).toBe("?a=1&e=0");
    expect(queryString({})).toBe("");
  });
});

describe("loginUrl", () => {
  it("returns to the current address after signing in", () => {
    expect(loginUrl({ pathname: "/board", search: "?item=note:1" })).toBe("/login?next=%2Fboard%3Fitem%3Dnote%3A1");
  });
});

describe("requests", () => {
  it("sends JSON same-origin with the session cookie", async () => {
    fetchMock.mockResolvedValue(json(200, { row: { id: "N1" }, event: null }));
    await api.updateNote("N1", { title: "Shopping" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/notes/N1");
    expect(init?.method).toBe("PATCH");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(JSON.stringify({ title: "Shopping" }));
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("builds the activity filters into the query", async () => {
    fetchMock.mockResolvedValue(json(200, { events: [], runs: [], titles: {}, next: null }));
    await api.events({ actor: "human", user_id: "U1", from: "2026-10-01", before: 99, limit: 50 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/events?actor=human&user_id=U1&from=2026-10-01&before=99&limit=50");
  });

  it("asks for changes since the cursor, or from the start", async () => {
    fetchMock.mockImplementation(async () => json(200, {}));
    await api.changes("E5");
    await api.changes(null);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/changes?since=E5", "/api/changes"]);
  });

  it("sends confirm only when reverting anyway", async () => {
    fetchMock.mockImplementation(async () => json(200, { reverted: 1, events: [] }));
    await api.revertEvent("E1");
    await api.revertRun("R1", true);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe("{}");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/runs/R1/revert");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ confirm: true }));
  });

  it("escapes ids in paths", () => {
    expect(captureAudioUrl("a/b")).toBe("/api/captures/a%2Fb/audio");
  });
});

describe("errors", () => {
  it("turns an error body into an ApiError", async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: { code: "invalid_request", message: "Give the task a title.", details: { issues: [] } } }),
    );
    const err = await api.createTask({ title: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "invalid_request", message: "Give the task a title." });
  });

  it("copes with an error that is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = await api.bootstrap().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "http_error" });
  });

  it("reports a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await api.bootstrap().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "network_error" });
  });

  it("sends the browser to the phrase page on 401", async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: "unauthorised", message: "Sign in." } }));
    const err = await api.bootstrap().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith("/login?next=%2Flist%3Ftab%3Dmine");
  });

  it("reads revert conflicts from a 409", () => {
    const conflict = { event_id: "E1", field: "title", later_event: { id: "E2" } };
    const err = new ApiError(409, "revert_conflict", "Later changes touched the same fields.", { conflicts: [conflict] });
    expect(revertConflicts(err)).toEqual([conflict]);
    expect(revertConflicts(new ApiError(409, "conflict", "Busy"))).toBeNull();
    expect(revertConflicts(new Error("x"))).toBeNull();
  });
});
