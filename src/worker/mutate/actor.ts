import type { ActorKind } from "../../shared/types";

/**
 * Who is making a change. Claude always acts on behalf of a user and inside a
 * run; the system (cron, transcription) acts on nobody's behalf.
 */
export interface Actor {
  kind: ActorKind;
  userId: string | null;
  runId: string | null;
}

export function humanActor(userId: string): Actor {
  return { kind: "human", userId, runId: null };
}

export function claudeActor(userId: string, runId: string): Actor {
  return { kind: "claude", userId, runId };
}

export const SYSTEM_ACTOR: Actor = { kind: "system", userId: null, runId: null };
