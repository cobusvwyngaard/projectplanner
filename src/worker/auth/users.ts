import type { User } from "../../shared/types";

// The two people, seeded by migrations/0001_init.sql. LOGIN_PHRASE_1 signs in
// as USER_1_ID and LOGIN_PHRASE_2 as USER_2_ID. This is the only place the
// mapping is written down in code.
export const USER_1_ID = "00000000000000000000000001";
export const USER_2_ID = "00000000000000000000000002";

/** Which user each configured login phrase signs in as. */
export const PHRASE_USERS = { 1: USER_1_ID, 2: USER_2_ID } as const;

export type PhraseNumber = keyof typeof PHRASE_USERS;

export async function findUser(db: D1Database, id: string): Promise<User | null> {
  return db
    .prepare(`SELECT id, email, display_name, initials, created_at FROM users WHERE id = ?`)
    .bind(id)
    .first<User>();
}
