import { describe, expect, it } from "vitest";
import { actorLabel, eventActor, sameActor, userName } from "../../src/shared/actors";
import type { User } from "../../src/shared/types";

const users: User[] = [
  { id: "U1", email: null, display_name: "Cobus", initials: "CW", created_at: "2026-01-01T00:00:00.000Z" },
  { id: "U2", email: null, display_name: "Anna", initials: "AN", created_at: "2026-01-01T00:00:00.000Z" },
];
const byId = new Map(users.map((u) => [u.id, u]));

describe("actorLabel", () => {
  it("names people by their display name", () => {
    expect(actorLabel({ kind: "human", user_id: "U1" }, users)).toBe("Cobus");
    expect(actorLabel({ kind: "human", user_id: "U2" }, byId)).toBe("Anna");
  });

  it("names Claude with the person it acted for", () => {
    expect(actorLabel({ kind: "claude", user_id: "U1" }, users)).toBe("Claude (via Cobus)");
    expect(actorLabel({ kind: "claude", user_id: "U2" }, byId)).toBe("Claude (via Anna)");
  });

  it("names the system", () => {
    expect(actorLabel({ kind: "system", user_id: null }, users)).toBe("System");
  });

  it("copes with unknown or missing people", () => {
    expect(actorLabel({ kind: "human", user_id: "nobody" }, users)).toBe("Someone");
    expect(actorLabel({ kind: "claude", user_id: null }, users)).toBe("Claude (via Someone)");
    expect(userName("U1", [])).toBe("Someone");
  });
});

describe("eventActor and sameActor", () => {
  it("reads the actor of an event and compares actors", () => {
    const actor = eventActor({ actor_kind: "claude", actor_user_id: "U1" });
    expect(actor).toEqual({ kind: "claude", user_id: "U1" });
    expect(sameActor(actor, { kind: "claude", user_id: "U1" })).toBe(true);
    expect(sameActor(actor, { kind: "human", user_id: "U1" })).toBe(false);
    expect(sameActor(actor, { kind: "claude", user_id: "U2" })).toBe(false);
  });
});
