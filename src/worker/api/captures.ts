// /api/captures: upload, list, detail, edit, retry and audio streaming.

import { Hono } from "hono";
import { z } from "zod";
import { ENTITIES } from "../mutate/entities";
import type { AppBindings } from "../env";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { jsonBody } from "../lib/http";
import { queryParams } from "./request";
import { mutate } from "../mutate/index";
import { actorOf, mutationResponse } from "./request";
import { captureKey } from "../captures/storage";
import { transcribeCapture } from "../captures/transcribe";
import { reset as resetLease } from "../captures/lease";
import { rowsByIds, selectEvents } from "../board/queries";
import { titlesFor } from "../board/titles";
import { ulid } from "../lib/ulid";
import type { Capture } from "../../shared/types";
import type { CaptureDetailResponse, CapturesResponse } from "../../shared/api";
import type { PlannerEvent } from "../../shared/types";
import { EVENT_COLUMNS } from "../mutate/events";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT = 20000;

const updateCapture = z.strictObject({
  text: z.string().optional(),
  inbox_status: z.enum(["new", "ignored", "processed"]).optional(),
  processing_note: z.string().max(500).nullable().optional(),
});

const listQuery = z.object({
  status: z.enum(["new", "claimed", "processed", "ignored", "all"]).default("all"),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

function captureColumns(): string {
  return ENTITIES.capture.columns.filter((c) => !ENTITIES.capture.hidden.includes(c)).join(", ");
}

const CAPTURE_COLS = captureColumns();

async function loadCapture(db: D1Database, id: string): Promise<Capture | null> {
  return db.prepare(`SELECT ${CAPTURE_COLS} FROM captures WHERE id = ?`).bind(id).first<Capture>();
}

function isAllowedMime(mime: string): boolean {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("audio/")) return true;
  return base === "video/webm" || base === "video/mp4";
}

function parseDuration(value: string | File | null): number | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError("duration_s must be a number.");
  if (n < 0 || n > 86400) throw new ValidationError("duration_s must be between 0 and 86400.");
  return n;
}

export const capturesRouter = new Hono<AppBindings>()
  .post("/", async (c) => {
    const db = c.env.DB;
    const user = c.get("user");
    const cl = c.req.header("content-length");
    if (cl) {
      const n = Number(cl);
      if (Number.isFinite(n) && n > MAX_FILE_BYTES) {
        throw new AppError(413, "payload_too_large", "The file is too large (max 50 MB).");
      }
    }
    const form = await c.req.formData();
    const kind = form.get("kind");
    if (kind !== "text" && kind !== "voice" && kind !== "file") {
      throw new ValidationError('kind must be "text", "voice" or "file".');
    }

    const id = ulid();

    if (kind === "text") {
      const raw = form.get("text");
      if (typeof raw !== "string") throw new ValidationError("text is required.");
      const text = raw.trim();
      if (text.length < 1 || text.length > MAX_TEXT) {
        throw new ValidationError("text must be 1 to 20 000 characters.");
      }
      const result = await mutate(db, actorOf(c), {
        entity: "capture",
        action: "create",
        id,
        values: {
          kind: "text",
          author_user_id: user.id,
          text,
          transcript_status: "n/a",
          inbox_status: "new",
        },
      });
      const mr = mutationResponse("capture", result);
      delete (mr.row as { transcript_json?: unknown }).transcript_json;
      return c.json(mr, 201);
    }

    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError("file is required.");
    if (file.size === 0) throw new ValidationError("file must not be empty.");
    const mime = file.type;
    if (!mime || !isAllowedMime(mime)) {
      throw new ValidationError("Unsupported file type.");
    }
    const durationS = parseDuration(form.get("duration_s"));

    const key = captureKey(id, mime);
    await c.env.AUDIO.put(key, file, { httpMetadata: { contentType: mime } });

    try {
      const result = await mutate(db, actorOf(c), {
        entity: "capture",
        action: "create",
        id,
        values: {
          kind,
          author_user_id: user.id,
          r2_key: key,
          mime,
          duration_s: durationS,
          transcript_status: "pending",
          inbox_status: "new",
        },
      });
      if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
        c.executionCtx.waitUntil(transcribeCapture(c.env, id));
      } else {
        void transcribeCapture(c.env, id);
      }
      const mr = mutationResponse("capture", result);
      delete (mr.row as { transcript_json?: unknown }).transcript_json;
      return c.json(mr, 201);
    } catch (err) {
      await c.env.AUDIO.delete(key);
      throw err;
    }
  })
  .get("/", async (c) => {
    const db = c.env.DB;
    const q = queryParams(c, listQuery);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.status !== "all") {
      where.push("inbox_status = ?");
      params.push(q.status);
    }
    if (q.before) {
      where.push("created_at < ?");
      params.push(q.before);
    }
    const sql = `SELECT ${CAPTURE_COLS} FROM captures ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    params.push(q.limit + 1);
    const { results } = await db.prepare(sql).bind(...params).all<Capture>();
    const more = results.length > q.limit;
    const captures = more ? results.slice(0, q.limit) : results;

    const runIds = new Set<string>();
    for (const cap of captures) {
      if (cap.claimed_by_run_id) runIds.add(cap.claimed_by_run_id);
      if (cap.processed_by_run_id) runIds.add(cap.processed_by_run_id);
    }
    const runs = await rowsByIds(db, "run", runIds);

    // transcription problem
    let problem: "missing_key" | "bad_key" | null = null;
    const isMock = c.env.TRANSCRIBER === "mock";
    const key = c.env.ELEVENLABS_API_KEY?.trim() ?? "";
    if (!isMock && key === "") problem = "missing_key";
    if (problem === null) {
      const authMsg = "ElevenLabs refused the API key (401). Check ELEVENLABS_API_KEY.";
      const bad = await db
        .prepare(`SELECT 1 FROM captures WHERE transcript_status = 'failed' AND transcript_error = ? AND transcribe_attempts > 0 ORDER BY created_at DESC LIMIT 1`)
        .bind(authMsg)
        .first();
      if (bad) problem = "bad_key";
    }

    const next = more ? (captures[captures.length - 1]?.created_at ?? null) : null;
    const body: CapturesResponse = {
      captures,
      runs,
      next,
      transcription: { problem },
    };
    return c.json(body);
  })
  .get("/:id", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const capture = await loadCapture(db, id);
    if (!capture) throw new NotFoundError(`No capture with id ${id}.`);
    const runIds = new Set<string>();
    if (capture.claimed_by_run_id) runIds.add(capture.claimed_by_run_id);
    if (capture.processed_by_run_id) runIds.add(capture.processed_by_run_id);
    const runs = await rowsByIds(db, "run", runIds);

    // items changed by those runs
    const itemsMap = new Map<string, { type: "note" | "task" | "link"; id: string; actions: PlannerEvent["action"][] }>();
    if (runIds.size > 0) {
      const marks = [...runIds].map(() => "?").join(", ");
      const stmt = db
        .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE run_id IN (${marks}) AND entity_type IN ('note','task','link') ORDER BY seq`)
        .bind(...runIds);
      const events = await selectEvents(stmt);
      for (const ev of events) {
        const key = `${ev.entity_type}:${ev.id}`;
        if (!itemsMap.has(key)) {
          itemsMap.set(key, { type: ev.entity_type as "note" | "task" | "link", id: ev.id, actions: [] });
        }
        itemsMap.get(key)!.actions.push(ev.action);
      }
    }
    const refs = [...itemsMap.values()].map((it) => ({ type: it.type, id: it.id }));
    const titles = await titlesFor(db, refs);
    const items = [...itemsMap.values()].map((it) => ({
      type: it.type,
      id: it.id,
      title: titles[`${it.type}:${it.id}`] ?? it.id,
      actions: it.actions,
    }));

    const ownEvents = await selectEvents(
      db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE entity_type = 'capture' AND entity_id = ? ORDER BY seq`).bind(id),
    );

    const body: CaptureDetailResponse = {
      capture,
      runs,
      items,
      events: ownEvents,
    };
    return c.json(body);
  })
  .patch("/:id", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const capture = await loadCapture(db, id);
    if (!capture) throw new NotFoundError(`No capture with id ${id}.`);
    const body = await jsonBody(c, updateCapture);
    if (body.inbox_status !== undefined && capture.inbox_status === "claimed") {
      throw new ConflictError("A claimed capture cannot be moved in the inbox.");
    }
    const patch: Record<string, string | null> = {};
    if (body.text !== undefined) patch.text = body.text;
    if (body.inbox_status !== undefined) patch.inbox_status = body.inbox_status;
    if (body.processing_note !== undefined) patch.processing_note = body.processing_note;
    const result = await mutate(db, actorOf(c), {
      entity: "capture",
      action: "update",
      id,
      patch,
    });
    const mr = mutationResponse("capture", result);
    delete (mr.row as { transcript_json?: unknown }).transcript_json;
    return c.json(mr);
  })
  .post("/:id/retry", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const capture = await loadCapture(db, id);
    if (!capture) throw new NotFoundError(`No capture with id ${id}.`);
    if (capture.kind !== "voice" && capture.kind !== "file") {
      throw new ConflictError("Only voice or file captures can be retried.");
    }
    if (capture.transcript_status !== "pending" && capture.transcript_status !== "failed") {
      throw new ConflictError("This capture cannot be retried right now.");
    }
    await resetLease(db, id);
    if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
      c.executionCtx.waitUntil(transcribeCapture(c.env, id));
    } else {
      void transcribeCapture(c.env, id);
    }
    const fresh = await loadCapture(db, id);
    return c.json({ capture: fresh ?? capture }, 202);
  })
  .get("/:id/audio", async (c) => {
    return streamAudio(c, false);
  })
  .on("HEAD", "/:id/audio", async (c) => {
    return streamAudio(c, true);
  });

async function streamAudio(c: any, headOnly: boolean): Promise<Response> {
  const db = c.env.DB;
  const id = c.req.param("id");
  const capture = await loadCapture(db, id);
  if (!capture || !capture.r2_key || (capture.kind !== "voice" && capture.kind !== "file")) {
    throw new NotFoundError("No audio for this capture.");
  }
  const key = capture.r2_key;
  const headObj = await c.env.AUDIO.head(key);
  if (!headObj) throw new NotFoundError("No audio for this capture.");
  const size = headObj.size;
  const mime = capture.mime ?? headObj.httpMetadata?.contentType ?? "application/octet-stream";
  const etag = headObj.httpEtag ?? `"${headObj.etag}"`;

  const headers = new Headers();
  headers.set("Content-Type", mime);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", etag);
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "private, max-age=3600");

  if (headOnly) {
    headers.set("Content-Length", String(size));
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = c.req.header("range");
  if (!rangeHeader) {
    const obj = await c.env.AUDIO.get(key);
    if (!obj) throw new NotFoundError("No audio for this capture.");
    headers.set("Content-Length", String(size));
    return new Response(obj.body, { status: 200, headers });
  }

  // parse single range
  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bytes=")) {
    const obj = await c.env.AUDIO.get(key);
    if (!obj) throw new NotFoundError("No audio for this capture.");
    headers.set("Content-Length", String(size));
    return new Response(obj.body, { status: 200, headers });
  }
  const spec = trimmed.slice(6).trim();
  if (spec.includes(",")) {
    const obj = await c.env.AUDIO.get(key);
    if (!obj) throw new NotFoundError("No audio for this capture.");
    headers.set("Content-Length", String(size));
    return new Response(obj.body, { status: 200, headers });
  }
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) {
    const obj = await c.env.AUDIO.get(key);
    if (!obj) throw new NotFoundError("No audio for this capture.");
    headers.set("Content-Length", String(size));
    return new Response(obj.body, { status: 200, headers });
  }
  const aStr = m[1] ?? "";
  const bStr = m[2] ?? "";
  let start: number;
  let end: number;
  if (aStr === "" && bStr === "") {
    // invalid
    const obj = await c.env.AUDIO.get(key);
    if (!obj) throw new NotFoundError("No audio for this capture.");
    headers.set("Content-Length", String(size));
    return new Response(obj.body, { status: 200, headers });
  }
  if (aStr === "") {
    // suffix
    const n = Number(bStr);
    if (!Number.isFinite(n) || n <= 0) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(aStr);
    if (bStr === "") {
      end = size - 1;
    } else {
      end = Number(bStr);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      const obj = await c.env.AUDIO.get(key);
      if (!obj) throw new NotFoundError("No audio for this capture.");
      headers.set("Content-Length", String(size));
      return new Response(obj.body, { status: 200, headers });
    }
    if (start > end || start >= size || end >= size || start < 0 || end < 0) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
  }
  // suffix n larger than size handled by max; validate start
  if (start < 0 || start >= size) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (end >= size) end = size - 1;
  if (start > end) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const length = end - start + 1;
  const obj = await c.env.AUDIO.get(key, { range: { offset: start, length } });
  if (!obj) throw new NotFoundError("No audio for this capture.");
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(length));
  return new Response(obj.body, { status: 206, headers });
}
