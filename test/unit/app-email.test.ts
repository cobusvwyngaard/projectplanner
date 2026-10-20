// The Inbox's email capture card helpers: sizes, people and the collapsed
// body (SPEC 11.3). Example addresses and names only.

import { describe, expect, it } from "vitest";
import {
  COLLAPSED_EMAIL_LINES,
  attachmentKind,
  collapseBody,
  emailSubject,
  formatSize,
  participantChipLabel,
  participantGroups,
  parseParticipants,
} from "../../src/app/lib/email";
import type { EmailParticipant } from "../../src/shared/types";
import { ME, OTHER } from "./app-fixtures";

describe("formatSize", () => {
  it("counts bytes below a kilobyte", () => {
    expect(formatSize(0)).toBe("0.0 B");
    expect(formatSize(1)).toBe("1.0 B");
    expect(formatSize(1023)).toBe("1023.0 B");
  });

  it("counts kilobytes up to a megabyte, with one decimal", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1230)).toBe("1.2 KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
  });

  it("counts megabytes from a megabyte up", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1_258_291)).toBe("1.2 MB");
  });
});

describe("attachmentKind", () => {
  it("names the file type from the extension", () => {
    expect(attachmentKind("report.pdf", "application/pdf")).toBe("PDF");
    expect(attachmentKind("Notes.TXT", "text/plain")).toBe("TXT");
  });

  it("falls back to the content type", () => {
    expect(attachmentKind("README", "text/markdown")).toBe("text/markdown");
    expect(attachmentKind("", "application/octet-stream")).toBe("application/octet-stream");
  });
});

describe("emailSubject", () => {
  it("keeps a subject and says so when there is none", () => {
    expect(emailSubject("A note about the report")).toBe("A note about the report");
    expect(emailSubject("  ")).toBe("(no subject)");
    expect(emailSubject(null)).toBe("(no subject)");
  });
});

const FROM: EmailParticipant = { address: "sender@example.org", name: "Sally", role: "from", user_id: null };
const TO_PERSON: EmailParticipant = { address: "cobus@example.com", name: "C. van Wyngaard", role: "to", user_id: ME.id };
const TO_STRANGER: EmailParticipant = { address: "stranger@example.com", name: "", role: "to", user_id: null };
const CC_PERSON: EmailParticipant = { address: "anna@example.com", name: "Anna", role: "cc", user_id: OTHER.id };

describe("parseParticipants", () => {
  it("reads the list stored on the capture", () => {
    expect(parseParticipants(JSON.stringify([FROM, TO_PERSON]))).toEqual([FROM, TO_PERSON]);
  });

  it("treats anything unreadable as nobody", () => {
    expect(parseParticipants(null)).toEqual([]);
    expect(parseParticipants("not json")).toEqual([]);
    expect(parseParticipants("{}")).toEqual([]);
    expect(parseParticipants('[{"address": 1, "name": "", "role": "to", "user_id": null}]')).toEqual([]);
  });
});

describe("participantGroups", () => {
  it("groups the people From, To and Cc, in that order", () => {
    const groups = participantGroups([TO_STRANGER, CC_PERSON, FROM, TO_PERSON]);
    expect(
      groups.map((group) => ({ role: group.role, label: group.label, people: group.people.map((p) => p.address) })),
    ).toEqual([
      { role: "from", label: "From", people: ["sender@example.org"] },
      { role: "to", label: "To", people: ["stranger@example.com", "cobus@example.com"] },
      { role: "cc", label: "Cc", people: ["anna@example.com"] },
    ]);
  });

  it("leaves out the roles nobody is in", () => {
    expect(participantGroups([])).toEqual([]);
    expect(participantGroups([FROM, CC_PERSON]).map((group) => group.label)).toEqual(["From", "Cc"]);
  });
});

describe("participantChipLabel", () => {
  it("shows the planner person's name when the address maps to one", () => {
    const users = new Map([[ME.id, ME]]);
    expect(participantChipLabel(TO_PERSON, users)).toBe("Cobus");
  });

  it("shows the address for everyone else", () => {
    const users = new Map([[ME.id, ME]]);
    expect(participantChipLabel(TO_STRANGER, users)).toBe("stranger@example.com");
    expect(participantChipLabel({ ...TO_PERSON, user_id: "U9" }, users)).toBe("cobus@example.com");
  });
});

describe("collapseBody", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

  it("keeps a body of the collapsed length whole, with no toggle", () => {
    expect(collapseBody(lines(5), false)).toEqual({ shown: lines(5), collapsible: false });
    expect(collapseBody(lines(COLLAPSED_EMAIL_LINES), false)).toEqual({
      shown: lines(COLLAPSED_EMAIL_LINES),
      collapsible: false,
    });
  });

  it("collapses a longer body to the first lines until it is opened", () => {
    const body = lines(COLLAPSED_EMAIL_LINES + 3);
    expect(collapseBody(body, false)).toEqual({ shown: lines(COLLAPSED_EMAIL_LINES), collapsible: true });
    expect(collapseBody(body, true)).toEqual({ shown: body, collapsible: true });
  });
});
