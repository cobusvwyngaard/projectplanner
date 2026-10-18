// Transcription lease and attempt bookkeeping. This is the only code allowed to
// set transcribe_attempts and transcribe_next_at on captures.

import { addMs } from "../lib/time";

function toIso(value: Date | string | number): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return String(value);
}

export async function acquire(db: D1Database, id: string, now: Date | string | number): Promise<boolean> {
  const nowIso = toIso(now);
  const nextIso = addMs(new Date(nowIso), 15 * 60_000).toISOString();
  const res = await db
    .prepare(
      `UPDATE captures SET transcribe_attempts = transcribe_attempts + 1, transcribe_next_at = ?
       WHERE id = ? AND transcript_status IN ('pending','failed')
         AND (transcribe_next_at IS NULL OR transcribe_next_at <= ?)
         AND transcribe_attempts < 5`,
    )
    .bind(nextIso, id, nowIso)
    .run();
  return res.meta.changes === 1;
}

export async function backoff(db: D1Database, id: string, when: Date | string | number): Promise<void> {
  await db.prepare(`UPDATE captures SET transcribe_next_at = ? WHERE id = ?`).bind(toIso(when), id).run();
}

export async function reset(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE captures SET transcribe_attempts = 0, transcribe_next_at = NULL WHERE id = ?`).bind(id).run();
}