// The Worker's email() handler: one message delivered by Cloudflare Email
// Routing becomes a capture in the Inbox (SPEC 11). It reads only the header
// block here and stores the raw message; the body is read later, off the
// request, by readEmail().

import type { AppEnv } from "../env";
import { ulid } from "../lib/ulid";
import { SYSTEM_ACTOR } from "../mutate/actor";
import { mutate } from "../mutate/index";
import {
  allHeaders,
  decodeHeaderValue,
  domainOf,
  firstHeader,
  headerText,
  parseAddressList,
  parseHeaders,
  type EmailAddress,
} from "./headers";
import { readEmail } from "./read";
import { authResultWords, authservId, CLOUDFLARE_AUTHSERV_IDS, senderVerified } from "./verify";

/** Messages over this are rejected by the Worker as well (SPEC 11.1). */
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

const REJECT_TOO_LARGE = "Message too large.";
const REJECT_NOT_ALLOWED = "This address does not accept mail from you.";

/** The bindings the email path needs. */
export type EmailEnv = Pick<AppEnv, "DB" | "AUDIO">;

/**
 * Accept and queue one message, or reject it. Nothing is stored for a message
 * that is rejected or is a duplicate.
 */
export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: EmailEnv,
  ctx: ExecutionContext,
): Promise<void> {
  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject(REJECT_TOO_LARGE);
    return;
  }

  const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const headers = parseHeaders(headerText(bytes));

  const from = parseAddressList(firstHeader(headers, "from") ?? "");
  const sender = from[0];
  if (!sender) {
    message.setReject(REJECT_NOT_ALLOWED);
    return;
  }
  const to = allHeaders(headers, "to").flatMap(parseAddressList);
  const cc = allHeaders(headers, "cc").flatMap(parseAddressList);

  const authResults = firstHeader(headers, "authentication-results");
  logUnrecognisedAuth(authResults);
  const verified = senderVerified(authResults, domainOf(sender.address));

  const registered = await registeredUsers(env.DB, [sender, ...to, ...cc]);
  const fromUserId = registered.get(sender.address) ?? null;
  const foundInToCc = [...to, ...cc].some((a) => registered.has(a.address));
  if (!(foundInToCc || (fromUserId !== null && verified))) {
    message.setReject(REJECT_NOT_ALLOWED);
    return;
  }

  const id = ulid();
  const messageId = (firstHeader(headers, "message-id") ?? "").trim();
  const finalMessageId = messageId || `<${await sha256Hex(bytes)}@no-message-id>`;
  const duplicate = await env.DB.prepare(`SELECT id FROM captures WHERE email_message_id = ?`)
    .bind(finalMessageId)
    .first<{ id: string }>();
  if (duplicate) return;

  const r2Key = `emails/${yearMonth(new Date())}/${id}.eml`;
  try {
    await env.AUDIO.put(r2Key, bytes, { httpMetadata: { contentType: "message/rfc822" } });
  } catch (err) {
    console.error(`email receive ${id} could not store the message: ${errorName(err)}`);
    return;
  }

  const participants = [
    ...from.map((a) => participant(a, "from", registered)),
    ...to.map((a) => participant(a, "to", registered)),
    ...cc.map((a) => participant(a, "cc", registered)),
  ];
  try {
    await mutate(env.DB, SYSTEM_ACTOR, {
      entity: "capture",
      action: "create",
      id,
      values: {
        kind: "email",
        author_user_id: verified ? fromUserId : null,
        r2_key: r2Key,
        mime: "message/rfc822",
        text: null,
        transcript_status: "pending",
        inbox_status: "new",
        email_subject: decodeHeaderValue(firstHeader(headers, "subject") ?? "") || null,
        email_from: sender.address,
        email_to_json: JSON.stringify(to.map((a) => a.address)),
        email_cc_json: JSON.stringify(cc.map((a) => a.address)),
        email_participants_json: JSON.stringify(participants),
        email_message_id: finalMessageId,
        email_sender_verified: verified ? 1 : 0,
      },
    });
  } catch (err) {
    // The message is already in R2 but there is no capture pointing at it. The
    // cron will not find it; that is acceptable (see DECISIONS.md).
    console.error(`email receive ${id} could not create the capture: ${errorName(err)}`);
    return;
  }

  ctx.waitUntil(readEmail(env, id));
}

/** The registered user behind each address, open rows only. */
async function registeredUsers(db: D1Database, addresses: readonly EmailAddress[]): Promise<Map<string, string>> {
  const unique = [...new Set(addresses.map((a) => a.address))];
  const found = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    const { results } = await db
      .prepare(
        `SELECT address, user_id FROM user_emails
         WHERE archived_at IS NULL AND address IN (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(...chunk)
      .all<{ address: string; user_id: string }>();
    for (const r of results) found.set(r.address, r.user_id);
  }
  return found;
}

function participant(address: EmailAddress, role: "from" | "to" | "cc", registered: ReadonlyMap<string, string>) {
  return { address: address.address, name: address.name, role, user_id: registered.get(address.address) ?? null };
}

/**
 * One line when the message carried no authentication results at all, or when
 * they did not come from Cloudflare, naming only the authserv-id and the result
 * words: never an address, subject or body.
 */
function logUnrecognisedAuth(authResults: string | null): void {
  if (!authResults) {
    console.log("email auth: none");
    return;
  }
  const id = authservId(authResults);
  if (CLOUDFLARE_AUTHSERV_IDS.includes(id)) return;
  const words = authResultWords(authResults).join(" ");
  console.log(`email auth: authserv-id=${id}${words ? ` ${words}` : ""}`);
}

function yearMonth(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}/${month}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}
