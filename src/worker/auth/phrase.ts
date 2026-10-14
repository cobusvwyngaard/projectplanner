// Passphrase check (SPEC 3.1). The phrase typed on the login page is compared
// with LOGIN_PHRASE_1 and LOGIN_PHRASE_2 by SHA-256 digest in constant time,
// always against both. Nothing here logs, returns or stores a phrase.

import type { AppEnv } from "../env";
import type { PhraseNumber } from "./users";

export type PhraseEnv = Pick<AppEnv, "LOGIN_PHRASE_1" | "LOGIN_PHRASE_2">;

/**
 * The form both sides are compared in: Unicode NFC, trimmed, every run of
 * whitespace collapsed to one space, lower-case.
 */
export function normalise(s: string): string {
  return s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Digest of a configured phrase; a missing or blank one gets a random digest that nothing can match. */
async function configuredDigest(value: string | undefined): Promise<ArrayBuffer> {
  const phrase = normalise(value ?? "");
  if (phrase === "") return crypto.getRandomValues(new Uint8Array(32)).buffer;
  return sha256(phrase);
}

/**
 * Which configured phrase the input matches: 1, 2 or null. Both phrases are
 * always compared. Blank input never matches, and if both configured phrases
 * are the same after normalisation every attempt is refused, because the
 * phrase could not tell the two people apart.
 */
export async function matchPhrase(env: PhraseEnv, input: string): Promise<PhraseNumber | null> {
  const given = normalise(input);
  const [givenDigest, digest1, digest2] = await Promise.all([
    sha256(given),
    configuredDigest(env.LOGIN_PHRASE_1),
    configuredDigest(env.LOGIN_PHRASE_2),
  ]);
  const matches1 = crypto.subtle.timingSafeEqual(givenDigest, digest1);
  const matches2 = crypto.subtle.timingSafeEqual(givenDigest, digest2);
  if (crypto.subtle.timingSafeEqual(digest1, digest2)) {
    console.error(
      "Sign-in refused: LOGIN_PHRASE_1 and LOGIN_PHRASE_2 are the same after normalisation. Set two different phrases.",
    );
    return null;
  }
  if (given === "") return null;
  if (matches1) return 1;
  if (matches2) return 2;
  return null;
}
