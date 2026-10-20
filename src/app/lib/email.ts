// Helpers for an email capture's card in the Inbox (SPEC 11.3): the size of an
// attachment, the people of the message and the collapsed body. Email content
// is untrusted data; the card shows all of it as plain React text.

import type { EmailParticipant, Id, User } from "../../shared/types";

/** "notes.txt · TXT · 14 B" or "report.pdf · PDF · 1.2 MB": whole bytes, and one decimal from a kilobyte up. */
export function formatSize(bytes: number): string {
  const kilobyte = 1024;
  const megabyte = kilobyte * 1024;
  if (bytes >= megabyte) return `${(bytes / megabyte).toFixed(1)} MB`;
  if (bytes >= kilobyte) return `${(bytes / kilobyte).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** "PDF" from the file name, or the content type when the name has no extension. */
export function attachmentKind(filename: string, mime: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot > 0 && dot < filename.length - 1) return filename.slice(dot + 1).toUpperCase();
  return mime;
}

/** The subject of a card title; an email without one says so. */
export function emailSubject(subject: string | null): string {
  const trimmed = subject?.trim() ?? "";
  return trimmed === "" ? "(no subject)" : trimmed;
}

function isParticipant(value: unknown): value is EmailParticipant {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.address === "string" &&
    typeof row.name === "string" &&
    (row.role === "from" || row.role === "to" || row.role === "cc") &&
    (typeof row.user_id === "string" || row.user_id === null)
  );
}

/** The people stored on the capture; anything unreadable counts as nobody. */
export function parseParticipants(json: string | null): EmailParticipant[] {
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isParticipant);
}

export interface ParticipantGroup {
  role: EmailParticipant["role"];
  /** The word in front of the chips: From, To or Cc */
  label: string;
  people: EmailParticipant[];
}

const ROLE_LABELS: readonly { role: EmailParticipant["role"]; label: string }[] = [
  { role: "from", label: "From" },
  { role: "to", label: "To" },
  { role: "cc", label: "Cc" },
];

/** The participants grouped From, To and Cc; groups nobody is in are left out. */
export function participantGroups(participants: readonly EmailParticipant[]): ParticipantGroup[] {
  return ROLE_LABELS.map(({ role, label }) => ({
    role,
    label,
    people: participants.filter((person) => person.role === role),
  })).filter((group) => group.people.length > 0);
}

/** What a chip shows: the planner person's name, or the address itself. */
export function participantChipLabel(person: EmailParticipant, users: ReadonlyMap<Id, User>): string {
  const user = person.user_id === null ? undefined : users.get(person.user_id);
  return user ? user.display_name : person.address;
}

/** Lines of the body kept on the card while it is collapsed. */
export const COLLAPSED_EMAIL_LINES = 12;

/**
 * The body to show, collapsed to its first lines unless the reader opened it,
 * and whether the body is long enough to collapse at all.
 */
export function collapseBody(text: string, open: boolean): { shown: string; collapsible: boolean } {
  const lines = text.split("\n");
  const collapsible = lines.length > COLLAPSED_EMAIL_LINES;
  if (open || !collapsible) return { shown: text, collapsible };
  return { shown: lines.slice(0, COLLAPSED_EMAIL_LINES).join("\n"), collapsible };
}
