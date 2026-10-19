// Phase 4A schema: migration 0002 widens captures and adds the email tables.

import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { USER_1, freshDb } from "../helpers/db";

const CAPTURE_ID = "01CAPTURE0000000000000001";

const INSERT_VOICE =
  `INSERT INTO captures (id, kind, author_user_id, r2_key, mime, duration_s, text, transcript_json,
     transcript_status, transcript_error, transcribe_attempts, transcribe_next_at, inbox_status,
     claimed_by_run_id, claimed_at, processed_by_run_id, processed_at, processing_note, created_at)
   VALUES (?, 'voice', ?, 'captures/2026/10/x.webm', 'audio/webm', 12.5, NULL, '{"raw":true}',
     'done', NULL, 2, NULL, 'processed', NULL, NULL, NULL, NULL, 'a note', '2026-10-01T00:00:00.000Z')`;

describe("migration 0002", () => {
  it("keeps existing capture rows exactly as they were", async () => {
    await reset();
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0001")),
    );
    await env.DB.prepare(INSERT_VOICE).bind(CAPTURE_ID, USER_1).run();
    const before = await env.DB.prepare(`SELECT * FROM captures WHERE id = ?`).bind(CAPTURE_ID).first<Record<string, unknown>>();
    expect(before).not.toBeNull();

    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0002")),
    );

    const after = await env.DB.prepare(`SELECT * FROM captures WHERE id = ?`).bind(CAPTURE_ID).first<Record<string, unknown>>();
    for (const [column, value] of Object.entries(before ?? {})) {
      expect(after?.[column], column).toEqual(value);
    }
    expect(after).toMatchObject({
      email_subject: null,
      email_from: null,
      email_to_json: null,
      email_cc_json: null,
      email_participants_json: null,
      email_message_id: null,
      email_sender_verified: null,
    });
  });

  it("allows an email capture with no author and refuses a text capture without one", async () => {
    const db = await freshDb();
    await db
      .prepare(`INSERT INTO captures (id, kind, author_user_id, transcript_status, inbox_status, created_at) VALUES (?, 'email', NULL, 'pending', 'new', ?)`)
      .bind("01EMAIL00000000000000001", "2026-10-01T00:00:00.000Z")
      .run();
    await expect(
      db
        .prepare(`INSERT INTO captures (id, kind, author_user_id, transcript_status, inbox_status, created_at) VALUES (?, 'text', NULL, 'n/a', 'new', ?)`)
        .bind("01TEXT000000000000000001", "2026-10-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("keeps Message-IDs unique while allowing many nulls", async () => {
    const db = await freshDb();
    const insert = (id: string, messageId: string | null) =>
      db
        .prepare(`INSERT INTO captures (id, kind, author_user_id, transcript_status, inbox_status, created_at, email_message_id) VALUES (?, 'email', NULL, 'pending', 'new', ?, ?)`)
        .bind(id, "2026-10-01T00:00:00.000Z", messageId)
        .run();
    await insert("01EMAIL0000000000000001a", null);
    await insert("01EMAIL0000000000000001b", null);
    await insert("01EMAIL0000000000000001c", "<a@example.com>");
    await expect(insert("01EMAIL0000000000000001d", "<a@example.com>")).rejects.toThrow(/UNIQUE/);
  });

  it("stores user_emails lower-case and one open row per address", async () => {
    const db = await freshDb();
    const insert = (id: string, address: string, archivedAt: string | null) =>
      db
        .prepare(`INSERT INTO user_emails (id, user_id, address, created_at, archived_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, USER_1, address, "2026-10-01T00:00:00.000Z", archivedAt)
        .run();
    await expect(insert("e1", "A@Example.com", null)).rejects.toThrow(/CHECK/);
    await insert("e1", "a@example.com", null);
    await expect(insert("e2", "a@example.com", null)).rejects.toThrow(/UNIQUE/);
    // Archiving frees the address (SPEC 11.2).
    await db.prepare(`UPDATE user_emails SET archived_at = ? WHERE id = 'e1'`).bind("2026-10-02T00:00:00.000Z").run();
    await insert("e3", "a@example.com", null);
    const { results } = await db.prepare(`SELECT id, address FROM user_emails ORDER BY id`).all();
    expect(results).toEqual([
      { id: "e1", address: "a@example.com" },
      { id: "e3", address: "a@example.com" },
    ]);
  });

  it("lists capture attachments with a size and a too_large flag", async () => {
    const db = await freshDb();
    await db
      .prepare(`INSERT INTO captures (id, kind, author_user_id, transcript_status, inbox_status, created_at) VALUES ('c1', 'email', NULL, 'pending', 'new', ?)`)
      .bind("2026-10-01T00:00:00.000Z")
      .run();
    await db
      .prepare(`INSERT INTO capture_attachments (id, capture_id, filename, mime, size_bytes, r2_key, too_large, created_at) VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)`)
      .bind("a1", "report.pdf", "application/pdf", 1234, "attachments/c1/a1", 0, "2026-10-01T00:00:00.000Z")
      .run();
    await db
      .prepare(`INSERT INTO capture_attachments (id, capture_id, filename, mime, size_bytes, r2_key, too_large, created_at) VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)`)
      .bind("a2", "huge.bin", "application/octet-stream", 20_000_000, null, 1, "2026-10-01T00:00:00.000Z")
      .run();
    await expect(
      db
        .prepare(`INSERT INTO capture_attachments (id, capture_id, filename, mime, size_bytes, r2_key, too_large, created_at) VALUES ('a3', 'nope', 'x', 'text/plain', 1, NULL, 0, ?)`)
        .bind("2026-10-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
