// Transcription backends: ElevenLabs (real) and a mock for tests/local dev.

import type { AppEnv } from "../env";

export interface TranscribeInput {
  audio: Blob;
  mime: string;
  filename: string;
  keyterms: string[];
}

export type TranscribeResult =
  | { ok: true; text: string; json: string; durationSecs: number | null }
  | { ok: false; kind: "auth" | "rate_limited" | "retryable" | "rejected"; message: string };

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

const FORBIDDEN_KEYTERM_CHARS = /[<>{}[\]\\;]/;

/** Sanitise keyterms per the ElevenLabs contract. */
export function sanitiseKeyterms(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (term === "") continue;
    if (term.length >= 50) continue;
    if (term.split(/\s+/).length > 5) continue;
    if (FORBIDDEN_KEYTERM_CHARS.test(term)) continue;
    out.push(term);
    if (out.length >= 1000) break;
  }
  return out;
}

const AUTH_MESSAGE = "ElevenLabs refused the API key (401). Check ELEVENLABS_API_KEY.";

export class ElevenLabsTranscriber implements Transcriber {
  constructor(private readonly env: AppEnv) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const key = this.env.ELEVENLABS_API_KEY?.trim() ?? "";
    if (key === "") {
      return { ok: false, kind: "rejected", message: "Transcription is not set up: the ElevenLabs key is missing." };
    }
    const terms = sanitiseKeyterms(input.keyterms);
    const form = new FormData();
    form.append("model_id", "scribe_v2");
    form.append("language_code", "eng");
    form.append("tag_audio_events", "false");
    form.append("file", input.audio, input.filename);
    for (const term of terms) form.append("keyterms", term);

    let res: Response;
    try {
      res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": key },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout")) {
        return { ok: false, kind: "retryable", message: "Transcription timed out." };
      }
      return { ok: false, kind: "retryable", message: "Transcription failed for now; it will be retried." };
    }

    if (res.ok) {
      const json = await res.text();
      let text = "";
      let durationSecs: number | null = null;
      try {
        const parsed = JSON.parse(json) as { text?: unknown; transcript?: unknown; audio_duration_secs?: unknown; duration?: unknown };
        if (typeof parsed.text === "string") text = parsed.text;
        else if (typeof parsed.transcript === "string") text = parsed.transcript;
        const d = parsed.audio_duration_secs ?? parsed.duration;
        if (typeof d === "number" && Number.isFinite(d)) durationSecs = d;
      } catch {
        text = json;
      }
      return { ok: true, text, json, durationSecs };
    }

    const status = res.status;
    if (status === 401 || status === 403) {
      return { ok: false, kind: "auth", message: AUTH_MESSAGE };
    }
    if (status === 429) {
      return { ok: false, kind: "rate_limited", message: "Transcription failed for now; it will be retried." };
    }
    if (status >= 500) {
      return { ok: false, kind: "retryable", message: "Transcription failed for now; it will be retried." };
    }
    return { ok: false, kind: "rejected", message: `ElevenLabs rejected the request (${status}).` };
  }
}

export class MockTranscriber implements Transcriber {
  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const buf = await input.audio.arrayBuffer();
    const head = new TextDecoder().decode(buf.slice(0, 8));
    if (head.startsWith("MOCK:401")) return { ok: false, kind: "auth", message: AUTH_MESSAGE };
    if (head.startsWith("MOCK:429")) return { ok: false, kind: "rate_limited", message: "Transcription failed for now; it will be retried." };
    if (head.startsWith("MOCK:500")) return { ok: false, kind: "retryable", message: "Transcription failed for now; it will be retried." };
    if (head.startsWith("MOCK:422")) return { ok: false, kind: "rejected", message: "ElevenLabs rejected the request (422)." };
    const text = `Mock transcript of a ${input.audio.size}-byte ${input.mime} recording.`;
    return { ok: true, text, json: JSON.stringify({ text, audio_duration_secs: null }), durationSecs: null };
  }
}

export function transcriberFor(env: AppEnv): Transcriber {
  if (env.TRANSCRIBER === "mock") return new MockTranscriber();
  return new ElevenLabsTranscriber(env);
}