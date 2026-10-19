// Sender verification from Cloudflare's own Authentication-Results header
// (SPEC 11.2). Only the FIRST such header counts: a sender can put forged ones
// further down the message, so anything after the first is ignored.

/**
 * The authserv-id Cloudflare Email Routing stamps on the results it adds.
 * (unverified: confirm on the first real email)
 */
export const CLOUDFLARE_AUTHSERV_IDS: readonly string[] = ["mx.cloudflare.net"];

const RESULT_WORD = /^(?:spf|dkim|dmarc|arc|bimi|iprev)=[a-z]+$/;

/** The authserv-id of an Authentication-Results header, lower-case, or "". */
export function authservId(value: string): string {
  const first = value.split(";", 1)[0] ?? "";
  return first.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * The "method=result" words of an Authentication-Results header, in order, eg.
 * ["dmarc=pass", "spf=pass"]. Safe to log: they never carry an address.
 */
export function authResultWords(value: string): string[] {
  const words: string[] = [];
  for (const clause of value.split(";").slice(1)) {
    for (const token of clause.trim().split(/\s+/)) {
      const word = token.toLowerCase();
      if (RESULT_WORD.test(word)) words.push(word);
    }
  }
  return words;
}

/**
 * True only when the first Authentication-Results header comes from Cloudflare
 * and says DMARC passed for the From address's domain. Everything else is not
 * verified.
 */
export function senderVerified(firstAuthResults: string | null, fromDomain: string): boolean {
  if (!firstAuthResults || !fromDomain) return false;
  if (!CLOUDFLARE_AUTHSERV_IDS.includes(authservId(firstAuthResults))) return false;
  const results = firstAuthResults.toLowerCase();
  if (!/(?:^|[\s;])dmarc=pass(?:[\s;]|$)/.test(results)) return false;
  const match = /(?:^|[\s;])header\.from=([^\s;]+)/.exec(results);
  return match?.[1] === fromDomain;
}
