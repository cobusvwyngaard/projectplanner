// The scheduled handler (wrangler.jsonc: every 10 minutes).

import { purgeExpired } from "./oauth/kv";
import { transcribeCapture } from "./captures/transcribe";
import type { AppEnv } from "./env";

/** Housekeeping run by the cron trigger: drop expired OAuth records. */
export async function runScheduled(env: Pick<AppEnv, "DB" | "AUDIO" | "ELEVENLABS_API_KEY" | "TRANSCRIBER">): Promise<void> {
  await purgeExpired(env.DB);
  await retryTranscriptions(env, new Date());
}

async function retryTranscriptions(env: Pick<AppEnv, "DB" | "AUDIO" | "ELEVENLABS_API_KEY" | "TRANSCRIBER">, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const { results } = await env.DB
    .prepare(
      `SELECT id FROM captures
       WHERE transcript_status IN ('pending','failed')
         AND transcribe_attempts < 5
         AND (transcribe_next_at IS NULL OR transcribe_next_at <= ?)
       ORDER BY created_at ASC, id ASC
       LIMIT 5`,
    )
    .bind(nowIso)
    .all<{ id: string }>();
  for (const r of results) {
    try {
      await transcribeCapture(env, r.id, now);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error(`retryTranscriptions ${r.id} failed: ${e.name}: ${e.message}`);
    }
  }
}