// Display names for whoever made a change: a person, Claude on a person's
// behalf ("Claude (via Cobus)") or the system.

import type { ActorRef, Id, PlannerEvent, User } from "./types";

/** The people, as a list or keyed by id. */
export type UserLookup = readonly Pick<User, "id" | "display_name">[] | ReadonlyMap<Id, Pick<User, "id" | "display_name">>;

const UNKNOWN_PERSON = "Someone";

/** A person's display name, or "Someone" if the id is unknown or missing. */
export function userName(userId: Id | null, users: UserLookup): string {
  if (userId === null) return UNKNOWN_PERSON;
  const user = "get" in users ? users.get(userId) : users.find((u) => u.id === userId);
  return user?.display_name.trim() || UNKNOWN_PERSON;
}

/** "Cobus", "Claude (via Cobus)" or "System". */
export function actorLabel(actor: ActorRef, users: UserLookup): string {
  switch (actor.kind) {
    case "human":
      return userName(actor.user_id, users);
    case "claude":
      return `Claude (via ${userName(actor.user_id, users)})`;
    case "system":
      return "System";
  }
}

/** The actor of an event. */
export function eventActor(event: Pick<PlannerEvent, "actor_kind" | "actor_user_id">): ActorRef {
  return { kind: event.actor_kind, user_id: event.actor_user_id };
}

export function sameActor(a: ActorRef, b: ActorRef): boolean {
  return a.kind === b.kind && a.user_id === b.user_id;
}
