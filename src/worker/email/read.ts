// Reading an email capture's body and attachments from R2 (SPEC 11.3). Safe to
// call from waitUntil and from cron, like transcribeCapture.

import PostalMime from "postal-mime";
import type { Attachment } from "postal-mime";
import { acquire } from "../captures/lease";
import type { AppEnv } from "../env";
import { ConflictError } from "../lib/errors";
import { ulid } from "../lib/ulid";
import { SYSTEM_ACTOR } from "../mutate/actor";
import { mutate, mutateMany, type Mutation } from "../mutate/index";
import { htmlToText } from "./body";

/** At most this many attachments are listed per email (SPEC 11.3). */
export const MAX_ATTACHMENTS = 20;
/** An attachment larger than this is listed but its content is not stored. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const MISSING_ERROR = "The email could not be found.";
const UNREADABLE_ERROR = "The email could not be read.";

interface CaptureRow {
  r2_key: string | null;
  text: string | null;
  transcript_status: string;
}

/**
 * Read one email capture's body and attachments. Idempotent: a capture that is
 * already read is left alone, and the transcription lease keeps two callers
 * apart.
 */
export async function readEmail(env: Pick<AppEnv, "DB" | "AUDIO">, id: string, now: Date = new Date()): Promise<void> {
  const db = env.DB;
  try {
    const row = await db
      .prepare(`SELECT r2_key, text, transcript_status FROM captures WHERE id = ? AND kind = 'email'`)
      .bind(id)
      .first<CaptureRow>();
    if (!row || row.transcript_status === "done") return;

    const acquired = await acquire(db, id, now);
    if (!acquired) return;
    if (!row.r2_key) return markFailed(db, id, row, MISSING_ERROR);

    const object = await env.AUDIO.get(row.r2_key);
    if (!object) return markFailed(db, id, row, MISSING_ERROR);

    let parsed;
    try {
      parsed = await PostalMime.parse(await object.arrayBuffer());
    } catch (err) {
      console.error(`readEmail ${id} could not parse: ${errorName(err)}`);
      return markFailed(db, id, row, UNREADABLE_ERROR);
    }

    const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "");
    const attachments = await storeAttachments(env, id, parsed.attachments);
    await mutateMany(db, SYSTEM_ACTOR, [
      ...attachments,
      {
        entity: "capture",
        action: "update",
        id,
        patch: { text, transcript_status: "done", transcript_error: null },
        expect: { text: row.text, transcript_status: row.transcript_status },
      },
    ]);
  } catch (err) {
    if (err instanceof ConflictError) return;
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`readEmail ${id} failed: ${e.name}: ${e.message}`);
  }
}

async function markFailed(db: D1Database, id: string, row: CaptureRow, error: string): Promise<void> {
  await mutate(db, SYSTEM_ACTOR, {
    entity: "capture",
    action: "update",
    id,
    patch: { transcript_status: "failed", transcript_error: error },
    expect: { text: row.text, transcript_status: row.transcript_status },
  });
}

/** Store the attachments that fit in R2 and describe all of them (at most 20). */
async function storeAttachments(
  env: Pick<AppEnv, "DB" | "AUDIO">,
  captureId: string,
  attachments: readonly Attachment[],
): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
    const bytes = attachmentBytes(attachment);
    const id = ulid();
    let r2Key: string | null = null;
    if (bytes.length <= MAX_ATTACHMENT_BYTES) {
      r2Key = `attachments/${captureId}/${id}`;
      try {
        await env.AUDIO.put(r2Key, bytes, { httpMetadata: { contentType: mimeOf(attachment) } });
      } catch (err) {
        console.error(`readEmail ${captureId} could not store an attachment: ${errorName(err)}`);
        r2Key = null;
      }
    }
    mutations.push({
      entity: "attachment",
      action: "create",
      id,
      values: {
        capture_id: captureId,
        filename: attachment.filename ?? "",
        mime: mimeOf(attachment),
        size_bytes: bytes.length,
        r2_key: r2Key,
        too_large: r2Key === null ? 1 : 0,
      },
    });
  }
  return mutations;
}

function mimeOf(attachment: Attachment): string {
  return attachment.mimeType || "application/octet-stream";
}

function attachmentBytes(attachment: Attachment): Uint8Array {
  if (typeof attachment.content === "string") {
    if (attachment.encoding === "base64") return base64Bytes(attachment.content);
    return new TextEncoder().encode(attachment.content);
  }
  if (attachment.content instanceof Uint8Array) return new Uint8Array(attachment.content);
  return new Uint8Array(attachment.content);
}

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}
