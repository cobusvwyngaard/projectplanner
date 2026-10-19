// Phase 4A: registered email addresses, and the mutate rules for email
// captures and attachments (SPEC sections 4.1, 11.2, 11.3).

import { beforeEach, describe, expect, it } from "vitest";
import type { BootstrapResponse, ChangesResponse, MutationResponse } from "../../src/shared/api";
import type { Capture, UserEmail } from "../../src/shared/types";
import { ForbiddenError, ValidationError } from "../../src/worker/lib/errors";
import { claudeActor, humanActor, SYSTEM_ACTOR } from "../../src/worker/mutate/actor";
import { mutate } from "../../src/worker/mutate/index";
import { asUser, fails, ok } from "../helpers/api";
import { USER_1, USER_2, allEvents, eventsFor, freshDb, openRun } from "../helpers/db";

let db: D1Database;
let api: ReturnType<typeof asUser>;

beforeEach(async () => {
  db = await freshDb();
  api = asUser(USER_1);
});

async function newTextCapture(author = USER_1): Promise<Capture> {
  const { row } = await mutate(db, humanActor(author), {
    entity: "capture",
    action: "create",
    values: { kind: "text", author_user_id: author, text: "a note", transcript_status: "n/a", inbox_status: "new" },
  });
  return row as unknown as Capture;
}

describe("email captures through mutate", () => {
  it("lets the system create an email capture and forgets nothing", async () => {
    const result = await mutate(db, SYSTEM_ACTOR, {
      entity: "capture",
      action: "create",
      values: {
        kind: "email",
        author_user_id: null,
        r2_key: "emails/2026/10/c1.eml",
        mime: "message/rfc822",
        text: "the body",
        transcript_status: "pending",
        inbox_status: "new",
        email_subject: "A subject",
        email_from: "sender@example.org",
        email_to_json: '["person@example.com"]',
        email_cc_json: null,
        email_participants_json: '[{"address":"sender@example.org","name":"Sender","role":"from","user_id":null}]',
        email_message_id: "<m1@example.org>",
        email_sender_verified: 1,
      },
    });
    expect(result.row.kind).toBe("email");
    expect(result.row.author_user_id).toBeNull();
    expect(result.event).toMatchObject({ action: "create", actor_kind: "system", actor_user_id: null });
    const events = await eventsFor("capture", String(result.row.id));
    expect(events).toHaveLength(1);
  });

  it("refuses the system creating any other kind", async () => {
    await expect(
      mutate(db, SYSTEM_ACTOR, { entity: "capture", action: "create", values: { kind: "text", author_user_id: null } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await allEvents()).toHaveLength(0);
  });

  it("refuses a person creating an email capture", async () => {
    await expect(
      mutate(db, humanActor(USER_1), {
        entity: "capture",
        action: "create",
        values: { kind: "email", author_user_id: USER_1, transcript_status: "pending", inbox_status: "new" },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets the system write the author and the reading columns, but not the email fields", async () => {
    const capture = await newTextCapture();
    const updated = await mutate(db, SYSTEM_ACTOR, {
      entity: "capture",
      action: "update",
      id: capture.id,
      patch: { author_user_id: USER_2, text: "read", transcript_status: "done", transcript_error: null },
    });
    expect(updated.row.author_user_id).toBe(USER_2);
    await expect(
      mutate(db, SYSTEM_ACTOR, { entity: "capture", action: "update", id: capture.id, patch: { email_subject: "x" } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a person creating an email capture through the API", async () => {
    const fd = new FormData();
    fd.append("kind", "email");
    fd.append("text", "hello");
    const error = await fails(api.send("POST", "/api/captures", fd), 400);
    expect(error.code).toBe("invalid_request");
    expect(await allEvents()).toHaveLength(0);
  });
});

describe("attachments through mutate", () => {
  it("only the system creates one, and it is written once", async () => {
    const capture = await newTextCapture();
    const created = await mutate(db, SYSTEM_ACTOR, {
      entity: "attachment",
      action: "create",
      values: {
        capture_id: capture.id,
        filename: "report.pdf",
        mime: "application/pdf",
        size_bytes: 1234,
        r2_key: "attachments/c1/a1",
        too_large: 0,
      },
    });
    expect(created.event).toMatchObject({ entity_type: "attachment", action: "create", actor_kind: "system" });

    await expect(
      mutate(db, humanActor(USER_1), {
        entity: "attachment",
        action: "create",
        values: { capture_id: capture.id, filename: "x", mime: "text/plain", size_bytes: 1, r2_key: null, too_large: 1 },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      mutate(db, SYSTEM_ACTOR, { entity: "attachment", action: "update", id: String(created.row.id), patch: { filename: "y" } }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      mutate(db, humanActor(USER_1), { entity: "attachment", action: "archive", id: String(created.row.id) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("registered addresses", () => {
  it("creates a lower-case address for a person", async () => {
    const res = await ok<MutationResponse<UserEmail>>(api.post(`/api/users/${USER_1}/emails`, { address: "  Person@Example.COM  " }));
    expect(res.row.address).toBe("person@example.com");
    expect(res.row.user_id).toBe(USER_1);
    expect(res.event?.entity_type).toBe("user_email");
  });

  it("refuses a duplicate with the existing person's name", async () => {
    await ok(api.post(`/api/users/${USER_1}/emails`, { address: "shared@example.com" }));
    const error = await fails(api.post(`/api/users/${USER_2}/emails`, { address: "shared@example.com" }), 409);
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("That address already belongs to Person 1.");
  });

  it("archiving frees the address for another person", async () => {
    const first = await ok<MutationResponse<UserEmail>>(api.post(`/api/users/${USER_1}/emails`, { address: "shared@example.com" }));
    const archived = await ok<MutationResponse<UserEmail>>(api.post(`/api/user-emails/${first.row.id}/archive`));
    expect(archived.row.archived_at).not.toBeNull();
    const second = await ok<MutationResponse<UserEmail>>(api.post(`/api/users/${USER_2}/emails`, { address: "shared@example.com" }));
    expect(second.row.user_id).toBe(USER_2);
  });

  it("stops Claude from writing an address", async () => {
    const runId = await openRun(USER_1);
    await expect(
      mutate(db, claudeActor(USER_1, runId), {
        entity: "user_email",
        action: "create",
        values: { user_id: USER_1, address: "claude@example.com" },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await allEvents()).toHaveLength(0);
  });

  it("appears in bootstrap and the change feed", async () => {
    const before = await ok<BootstrapResponse>(api.get("/api/bootstrap"));
    expect(before.user_emails).toEqual([]);
    const created = await ok<MutationResponse<UserEmail>>(api.post(`/api/users/${USER_1}/emails`, { address: "feed@example.com" }));
    const after = await ok<BootstrapResponse>(api.get("/api/bootstrap"));
    expect(after.user_emails.map((e) => e.address)).toEqual(["feed@example.com"]);

    await ok(api.post(`/api/user-emails/${created.row.id}/archive`));
    const changes = await ok<ChangesResponse>(api.get(`/api/changes?since=${after.cursor}`));
    expect(changes.events.some((e) => e.entity_type === "user_email" && e.action === "archive")).toBe(true);
    expect(changes.user_emails).toHaveLength(1);
  });
});
