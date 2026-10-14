// SPEC 4.1: no code path may write board data without producing an event.
// This scans the Worker source for SQL that writes the protected tables and
// fails if any such statement appears outside the files allowed to write them.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE = join(ROOT, "src");

/** Tables that only mutate (and the event helper) may write. */
const PROTECTED = ["notes", "tasks", "links", "labels", "users", "settings", "events", "captures"];

/** Files allowed to write a protected table, and which tables. */
const ALLOWED: Record<string, string[]> = {
  "src/worker/mutate/index.ts": ["notes", "tasks", "links", "labels", "users", "settings", "captures"],
  "src/worker/mutate/events.ts": ["events"],
};

/**
 * Narrow exceptions for captures bookkeeping that is not board data: the
 * transcription lease and attempt counter. Each must only SET these columns.
 */
const CAPTURE_BOOKKEEPING_FILES = ["src/worker/captures/lease.ts"];
const CAPTURE_BOOKKEEPING_COLUMNS = ["transcribe_attempts", "transcribe_next_at"];

const WRITE_RE = new RegExp(
  String.raw`\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+[\`"']?(${PROTECTED.join("|")})\b`,
  "gi",
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|sql)$/.test(name) ? [path] : [];
  });
}

describe("write paths", () => {
  it("only mutate writes notes, tasks, links, labels, users, settings, captures and events", () => {
    const offences: string[] = [];
    for (const file of sourceFiles(SOURCE)) {
      const rel = relative(ROOT, file).split("\\").join("/");
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(WRITE_RE)) {
        const table = (match[2] ?? "").toLowerCase();
        if (ALLOWED[rel]?.includes(table)) continue;
        if (table === "captures" && CAPTURE_BOOKKEEPING_FILES.includes(rel)) {
          const statement = text.slice(match.index ?? 0, (match.index ?? 0) + 400);
          const setClause = /SET\s+([\s\S]*?)\s+WHERE/i.exec(statement)?.[1] ?? "";
          const columns = setClause.split(",").map((part) => part.split("=")[0]?.trim() ?? "");
          if (/^UPDATE/i.test(match[1] ?? "") && columns.every((c) => CAPTURE_BOOKKEEPING_COLUMNS.includes(c))) continue;
        }
        const line = text.slice(0, match.index).split("\n").length;
        offences.push(`${rel}:${line}: ${match[0]}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("the scanner recognises writes it must reject", () => {
    const samples = [
      "INSERT INTO notes (id) VALUES (?)",
      "update tasks set title = ?",
      "DELETE FROM links WHERE id = ?",
      "INSERT OR REPLACE INTO labels VALUES (?)",
      "REPLACE INTO settings VALUES (?)",
      "UPDATE OR IGNORE events SET x = 1",
    ];
    for (const sample of samples) {
      expect(sample.match(WRITE_RE), sample).not.toBeNull();
    }
    expect("SELECT * FROM notes".match(WRITE_RE)).toBeNull();
  });
});
