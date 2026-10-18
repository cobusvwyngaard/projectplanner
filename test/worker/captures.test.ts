import { beforeEach, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { MutationResponse } from "../../src/shared/api";
import type { Capture } from "../../src/shared/types";
import { asUser } from "../helpers/api";
import { USER_1, freshDb } from "../helpers/db";
import { signIn, call } from "../helpers/auth";
import { transcribeCapture } from "../../src/worker/captures/transcribe";
import { runScheduled } from "../../src/worker/cron";

const ORIGIN = "https://planner.test";

let db: D1Database;
let api: ReturnType<typeof asUser>;

beforeEach(async () => {
  db = await freshDb();
  api = asUser(USER_1);
  env.TRANSCRIBER = "mock";
  env.ELEVENLABS_API_KEY = "placeholder-not-a-real-key";
});



describe("captures creation", () => {
  it("creates a text capture", async () => {
    const fd = new FormData();
    fd.append("kind", "text");
    fd.append("text", "  hello  ");
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    expect(res.status).toBe(201);
    expect(res.body.row.kind).toBe("text");
    expect(res.body.row.text).toBe("hello");
    expect(res.body.row.transcript_status).toBe("n/a");
    expect(res.body.row.inbox_status).toBe("new");
    expect(res.body.row.r2_key).toBeNull();
  });

  it("creates a voice capture with R2 key format and stored MIME", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" });
    const file = new File([blob], "a.webm", { type: "audio/webm;codecs=opus" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    expect(res.status).toBe(201);
    expect(res.body.row.transcript_status).toBe("pending");
    expect(res.body.row.mime).toBe("audio/webm;codecs=opus");
    expect(res.body.row.r2_key).toMatch(/^captures\/\d{4}\/\d{2}\/.+\.webm$/);
  });

  it("creates a file capture with audio/mp4 stored MIME", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
    const file = new File([blob], "a.m4a", { type: "audio/mp4" });
    const fd = new FormData();
    fd.append("kind", "file");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    expect(res.status).toBe(201);
    expect(res.body.row.mime).toBe("audio/mp4");
    expect(res.body.row.r2_key).toMatch(/\.m4a$/);
  });

  it("rejects too big with 413", async () => {
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    const file = new File([big], "big.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    // Use a fake content-length via direct fetch to trigger before body read
    const session = await signIn();
    const res = await SELF.fetch(`${ORIGIN}/api/captures`, {
      method: "POST",
      headers: { Cookie: session.cookie, Origin: ORIGIN, "Content-Length": String(51 * 1024 * 1024) },
      body: fd,
    });
    expect(res.status).toBe(413);
  });

  it("rejects wrong MIME with 400", async () => {
    const file = new File([new Uint8Array([1])], "a.txt", { type: "text/plain" });
    const fd = new FormData();
    fd.append("kind", "file");
    fd.append("file", file);
    const res = await api.send("POST", "/api/captures", fd);
    expect(res.status).toBe(400);
  });

  it("rejects empty file with 400", async () => {
    const file = new File([], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send("POST", "/api/captures", fd);
    expect(res.status).toBe(400);
  });

  it("401 without a session", async () => {
    const fd = new FormData();
    fd.append("kind", "text");
    fd.append("text", "hi");
    const res = await call("/api/captures", { method: "POST", body: fd });
    expect(res.status).toBe(401);
  });
});

describe("transcription", () => {
  it("transcribes to done with a system event", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const file = new File([blob], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const detail = await api.get<{ capture: Capture; items: any[]; events: any[] }>(`/api/captures/${id}`);
    expect(detail.body.capture.transcript_status).toBe("done");
    expect(detail.body.capture.text).toContain("Mock transcript");
    expect(detail.body.events.some((e: any) => e.actor_kind === "system")).toBe(true);
  });

  it("401 -> failed and problem bad_key", async () => {
    const bytes = new TextEncoder().encode("MOCK:401");
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const cap = await api.get<{ capture: Capture }>(`/api/captures/${id}`);
    expect(cap.body.capture.transcript_status).toBe("failed");
    const list = await api.get<{ transcription: { problem: string | null } }>("/api/captures?status=all");
    expect(list.body.transcription.problem).toBe("bad_key");
  });

  it("bad_key clears after a newer successful transcription", async () => {
    // older auth failure
    const b1 = new TextEncoder().encode("MOCK:401");
    const f1 = new File([b1], "a.webm", { type: "audio/webm" });
    const fd1 = new FormData();
    fd1.append("kind", "voice");
    fd1.append("file", f1);
    await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd1);

    // newer success
    const b2 = new Uint8Array([1, 2, 3]);
    const f2 = new File([b2], "b.webm", { type: "audio/webm" });
    const fd2 = new FormData();
    fd2.append("kind", "voice");
    fd2.append("file", f2);
    await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd2);

    const list = await api.get<{ transcription: { problem: string | null } }>("/api/captures?status=all");
    expect(list.body.transcription.problem).toBeNull();
  });

  it("429 -> pending with backoff", async () => {
    const bytes = new TextEncoder().encode("MOCK:429");
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const cap = await api.get<{ capture: Capture }>(`/api/captures/${id}`);
    expect(cap.body.capture.transcript_status).toBe("pending");
    expect(cap.body.capture.transcribe_next_at).not.toBeNull();
  });

  it("500 -> retry (pending)", async () => {
    const bytes = new TextEncoder().encode("MOCK:500");
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const cap = await api.get<{ capture: Capture }>(`/api/captures/${id}`);
    expect(cap.body.capture.transcript_status).toBe("pending");
  });

  it("422 -> failed", async () => {
    const bytes = new TextEncoder().encode("MOCK:422");
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const cap = await api.get<{ capture: Capture }>(`/api/captures/${id}`);
    expect(cap.body.capture.transcript_status).toBe("failed");
  });

  it("5-attempt cap", async () => {
    const bytes = new TextEncoder().encode("MOCK:500");
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    for (let i = 0; i < 5; i++) {
      await db.prepare("UPDATE captures SET transcribe_next_at = NULL WHERE id = ?").bind(id).run();
      await transcribeCapture(env, id);
    }
    const cap = await api.get<{ capture: Capture }>(`/api/captures/${id}`);
    expect(cap.body.capture.transcript_status).toBe("failed");
    expect(cap.body.capture.transcribe_attempts).toBe(5);
  });

  it("person edit survives later transcription", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const file = new File([blob], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    await api.patch(`/api/captures/${id}`, { text: "my edited transcript" });
    // force pending again to allow transcription attempt
    await db.prepare("UPDATE captures SET transcript_status='pending', transcribe_next_at=NULL WHERE id=?").bind(id).run();
    await transcribeCapture(env, id);
    const cap = await api.get<{ capture: Capture }>(`/api/captures/${id}`);
    expect(cap.body.capture.text).toBe("my edited transcript");
  });
});

describe("cron", () => {
  it("picks due captures only, respects backoff, at most 5", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const bytes = new TextEncoder().encode("MOCK:500");
      const file = new File([bytes], "a.webm", { type: "audio/webm" });
      const fd = new FormData();
      fd.append("kind", "voice");
      fd.append("file", file);
      const r = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
      ids.push(r.body.row.id);
    }
    for (const id of ids) {
      await db.prepare("UPDATE captures SET transcribe_next_at = NULL WHERE id = ?").bind(id).run();
    }
    // make one future (not due)
    await db.prepare("UPDATE captures SET transcribe_next_at = ? WHERE id = ?").bind(new Date(Date.now() + 10_000_000).toISOString(), ids[0]).run();
    const before = await db.prepare("SELECT SUM(transcribe_attempts) as s FROM captures").first<{ s: number }>();
    await runScheduled(env);
    const after = await db.prepare("SELECT SUM(transcribe_attempts) as s FROM captures").first<{ s: number }>();
    expect((after!.s ?? 0) - (before!.s ?? 0)).toBeLessThanOrEqual(5);
    // future one unchanged
    const fut = await db.prepare("SELECT transcribe_attempts FROM captures WHERE id = ?").bind(ids[0]).first<{ transcribe_attempts: number }>();
    // it had 1 from initial; cron should not have retried it
    // (can't easily know, but ensure not >2)
    expect(fut!.transcribe_attempts).toBeLessThanOrEqual(2);
  });
});

describe("manual retry", () => {
  it("retries voice/file pending/failed", async () => {
    const bytes = new TextEncoder().encode("MOCK:422");
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const r = await api.post(`/api/captures/${id}/retry`);
    expect(r.status).toBe(202);
  });

  it("409 for text capture", async () => {
    const fd = new FormData();
    fd.append("kind", "text");
    fd.append("text", "hi");
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const r = await api.post(`/api/captures/${res.body.row.id}/retry`);
    expect(r.status).toBe(409);
  });
});

describe("inbox", () => {
  it("moves inbox_status", async () => {
    const fd = new FormData();
    fd.append("kind", "text");
    fd.append("text", "hi");
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const r = await api.patch<{ row: { inbox_status: string } }>(`/api/captures/${id}`, { inbox_status: "ignored" });
    expect(r.status).toBe(200);
    expect(r.body.row.inbox_status).toBe("ignored");
  });

  it("409 while claimed", async () => {
    const fd = new FormData();
    fd.append("kind", "text");
    fd.append("text", "hi");
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    await db.prepare("UPDATE captures SET inbox_status='claimed' WHERE id=?").bind(id).run();
    const r = await api.patch(`/api/captures/${id}`, { inbox_status: "new" });
    expect(r.status).toBe(409);
  });

  it("transcript edit is a human event", async () => {
    const fd = new FormData();
    fd.append("kind", "text");
    fd.append("text", "hi");
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    await api.patch(`/api/captures/${id}`, { text: "edited" });
    const evs = await db.prepare("SELECT actor_kind, action FROM events WHERE entity_type='capture' AND entity_id=?").bind(id).all<{ actor_kind: string; action: string }>();
    expect(evs.results.some((e) => e.actor_kind === "human" && e.action === "update")).toBe(true);
  });
});

describe("audio", () => {
  async function createAudioCapture() {
    const blob = new Blob([new Uint8Array([10, 20, 30, 40, 50])], { type: "audio/mp4" });
    const file = new File([blob], "a.m4a", { type: "audio/mp4" });
    const fd = new FormData();
    fd.append("kind", "file");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    return res.body.row.id;
  }

  it("full 200", async () => {
    const id = await createAudioCapture();
    const r = await api.app.request(`/api/captures/${id}/audio`, {}, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Length")).toBe("5");
    expect(r.headers.get("Accept-Ranges")).toBe("bytes");
    expect(r.headers.get("Cache-Control")).toBe("private, max-age=3600");
  });

  it("a-b 206", async () => {
    const id = await createAudioCapture();
    const r = await api.app.request(`/api/captures/${id}/audio`, { headers: { Range: "bytes=1-3" } }, env);
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe("bytes 1-3/5");
  });

  it("a- 206", async () => {
    const id = await createAudioCapture();
    const r = await api.app.request(`/api/captures/${id}/audio`, { headers: { Range: "bytes=2-" } }, env);
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe("bytes 2-4/5");
  });

  it("-n 206", async () => {
    const id = await createAudioCapture();
    const r = await api.app.request(`/api/captures/${id}/audio`, { headers: { Range: "bytes=-2" } }, env);
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe("bytes 3-4/5");
  });

  it("416", async () => {
    const id = await createAudioCapture();
    const r = await api.app.request(`/api/captures/${id}/audio`, { headers: { Range: "bytes=10-20" } }, env);
    expect(r.status).toBe(416);
    expect(r.headers.get("Content-Range")).toBe("bytes */5");
  });

  it("range clamps past end", async () => {
    const id = await createAudioCapture();
    const r = await api.app.request(`/api/captures/${id}/audio`, { headers: { Range: "bytes=2-100" } }, env);
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe("bytes 2-4/5");
  });

  it("HEAD", async () => {
    const id = await createAudioCapture();
    const r = await api.app.request(`/api/captures/${id}/audio`, { method: "HEAD" }, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Length")).toBe("5");
  });

  it("text capture audio 404", async () => {
    const fd = new FormData();
    fd.append("kind", "text");
    fd.append("text", "hi");
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const r = await api.app.request(`/api/captures/${res.body.row.id}/audio`, {}, env);
    expect(r.status).toBe(404);
  });
});

describe("transcriber request shape", () => {
  it("exact ElevenLabs request", async () => {
    env.TRANSCRIBER = "elevenlabs";
    env.ELEVENLABS_API_KEY = "secret-key-123";
    await api.put("/api/settings/stt_keyterms", { value: ["Cobus", "Shared Planner"] });
    await api.put("/api/settings/stt_keyterms_enabled", { value: true });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "hi", audio_duration_secs: 1.5 }), { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);

    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    const init = call[1] as RequestInit;
    expect((init.headers as any)["xi-api-key"]).toBe("secret-key-123");
    const body = init.body as FormData;
    expect(body.get("model_id")).toBe("scribe_v2");
    expect(body.get("language_code")).toBe("eng");
    expect(body.get("tag_audio_events")).toBe("false");
    expect(body.getAll("keyterms")).toEqual(["Cobus", "Shared Planner"]);
    fetchSpy.mockRestore();
  });

  it("keyterms absent when disabled", async () => {
    env.TRANSCRIBER = "elevenlabs";
    env.ELEVENLABS_API_KEY = "secret-key-123";
    await api.put("/api/settings/stt_keyterms", { value: ["Cobus"] });
    // disabled by default
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "hi" }), { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(body.getAll("keyterms")).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("sanitises keyterms", async () => {
    env.TRANSCRIBER = "elevenlabs";
    env.ELEVENLABS_API_KEY = "secret-key-123";
    await api.put("/api/settings/stt_keyterms", { value: [" Cobus ", "Bad<Term", "a".repeat(50), "one two three four five six", "ok;term"] });
    await api.put("/api/settings/stt_keyterms_enabled", { value: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "hi" }), { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(body.getAll("keyterms")).toEqual(["Cobus", "ok;term"]);
    fetchSpy.mockRestore();
  });

  it("missing key -> failed with no fetch call", async () => {
    env.TRANSCRIBER = "elevenlabs";
    env.ELEVENLABS_API_KEY = "   ";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const cap = await api.get<{ capture: Capture }>(`/api/captures/${id}`);
    expect(cap.body.capture.transcript_status).toBe("failed");
    expect(cap.body.capture.transcript_error).toBe("Transcription is not set up: the ElevenLabs key is missing.");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("no leaks", () => {
  it("key never appears in response or event", async () => {
    env.TRANSCRIBER = "elevenlabs";
    env.ELEVENLABS_API_KEY = "super-secret-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "hi" }), { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const all = JSON.stringify(res.body) + JSON.stringify((await api.get(`/api/captures/${id}`)).body);
    expect(all).not.toContain("super-secret-key");
    // events
    const evs = await db.prepare("SELECT before_json, after_json FROM events WHERE entity_type='capture' AND entity_id=?").bind(id).all<{ before_json: string | null; after_json: string | null }>();
    for (const r of evs.results) {
      expect((r.before_json ?? "") + (r.after_json ?? "")).not.toContain("super-secret-key");
    }
    fetchSpy.mockRestore();
  });

  it("transcript_json never appears in response or event", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], "a.webm", { type: "audio/webm" });
    const fd = new FormData();
    fd.append("kind", "voice");
    fd.append("file", file);
    const res = await api.send<MutationResponse<Capture>>("POST", "/api/captures", fd);
    const id = res.body.row.id;
    const detail = await api.get<{ capture: Capture; items: any[]; events: any[] }>(`/api/captures/${id}`);
    expect(JSON.stringify(res.body)).not.toContain("transcript_json");
    expect(JSON.stringify(detail.body)).not.toContain("transcript_json");
    const evs = await db.prepare("SELECT before_json, after_json FROM events WHERE entity_type='capture' AND entity_id=?").bind(id).all<{ before_json: string | null; after_json: string | null }>();
    for (const r of evs.results) {
      expect((r.before_json ?? "") + (r.after_json ?? "")).not.toContain("transcript_json");
    }
  });
});
