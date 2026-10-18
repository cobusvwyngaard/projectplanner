// One transcription attempt for a capture. Safe to call from waitUntil and cron.

import { mutate } from "../mutate/index";
import { ConflictError } from "../lib/errors";
import { SYSTEM_ACTOR } from "../mutate/actor";

import { transcriberFor } from "./transcriber";
import { acquire, backoff } from "./lease";
import { readSettings } from "../settings";
import type { AppEnv } from "../env";

const AUTH_ERROR = "ElevenLabs refused the API key (401). Check ELEVENLABS_API_KEY.";
const RETRY_ERROR = "Transcription failed for now; it will be retried.";
const MISSING_ERROR = "The recording could not be found.";

export async function transcribeCapture(env: Pick<AppEnv, "DB" | "AUDIO" | "ELEVENLABS_API_KEY" | "TRANSCRIBER">, id: string, now: Date = new Date()): Promise<void> {
  const db = env.DB;
  try {
    const row = await db
      .prepare(
        `SELECT id, kind, author_user_id, r2_key, mime, duration_s, text, transcript_status, transcribe_attempts FROM captures WHERE id = ?`,
      )
      .bind(id)
      .first<{
        id: string;
        kind: string;
        author_user_id: string;
        r2_key: string | null;
        mime: string | null;
        duration_s: number | null;
        text: string | null;
        transcript_status: string;
        transcribe_attempts: number;
      }>();
    if (!row) return;
    if (row.transcript_status === "done") return;

    const acquired = await acquire(db, id, now);
    if (!acquired) return;

    const fresh = await db
      .prepare(`SELECT r2_key, mime, duration_s, transcribe_attempts FROM captures WHERE id = ?`)
      .bind(id)
      .first<{ r2_key: string | null; mime: string | null; duration_s: number | null; transcribe_attempts: number }>();
    const r2Key = fresh?.r2_key ?? row.r2_key;
    const mime = fresh?.mime ?? row.mime;
    const durationS = fresh?.duration_s ?? row.duration_s;
    const attempts = fresh?.transcribe_attempts ?? row.transcribe_attempts + 1;

    if (!r2Key) {
      await mutate(db, SYSTEM_ACTOR, {
        entity: "capture",
        action: "update",
        id,
        patch: { transcript_status: "failed", transcript_error: MISSING_ERROR },
        expect: { text: row.text, transcript_status: row.transcript_status },
      });
      return;
    }

    const obj = await env.AUDIO.get(r2Key);
    if (!obj) {
      await mutate(db, SYSTEM_ACTOR, {
        entity: "capture",
        action: "update",
        id,
        patch: { transcript_status: "failed", transcript_error: MISSING_ERROR },
        expect: { text: row.text, transcript_status: row.transcript_status },
      });
      return;
    }

    const settings = await readSettings(db);
    const keyterms = settings.stt_keyterms_enabled ? settings.stt_keyterms : [];
    const buffer = await obj.arrayBuffer();
    const blob = new Blob([buffer], { type: mime ?? obj.httpMetadata?.contentType ?? "application/octet-stream" });
    const filename = r2Key.split("/").pop() ?? `${id}.bin`;

    const result = await transcriberFor(env).transcribe({
      audio: blob,
      mime: mime ?? obj.httpMetadata?.contentType ?? "application/octet-stream",
      filename,
      keyterms,
    });

    if (result.ok) {
      const patch: Record<string, string | number | null> = {
        transcript_json: result.json,
        transcript_status: "done",
        transcript_error: null,
      };
      if (row.text === null) patch.text = result.text;
      if (durationS === null && result.durationSecs !== null) {
        patch.duration_s = result.durationSecs;
      }
      await mutate(db, SYSTEM_ACTOR, { entity: "capture", action: "update", id, patch, expect: { text: row.text, transcript_status: row.transcript_status } });
      return;
    }

    if (result.kind === "auth") {
      await mutate(db, SYSTEM_ACTOR, {
        entity: "capture",
        action: "update",
        id,
        patch: { transcript_status: "failed", transcript_error: AUTH_ERROR },
        expect: { text: row.text, transcript_status: row.transcript_status },
      });
      return;
    }

    if (result.kind === "rejected") {
      await mutate(db, SYSTEM_ACTOR, {
        entity: "capture",
        action: "update",
        id,
        patch: { transcript_status: "failed", transcript_error: result.message },
        expect: { text: row.text, transcript_status: row.transcript_status },
      });
      return;
    }

    // rate_limited or retryable
    const status = attempts >= 5 ? "failed" : "pending";
    await mutate(db, SYSTEM_ACTOR, {
      entity: "capture",
      action: "update",
      id,
      patch: { transcript_status: status, transcript_error: RETRY_ERROR },
      expect: { text: row.text, transcript_status: row.transcript_status },
    });
    const backoffMs = 10 * 60_000 * Math.pow(2, attempts - 1);
    await backoff(db, id, new Date(now.getTime() + backoffMs));
  } catch (err) {
    if (err instanceof ConflictError) return;
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`transcribeCapture ${id} failed: ${e.name}: ${e.message}`);
  }
}
