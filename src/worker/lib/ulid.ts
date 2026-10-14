// Monotonic ULIDs (https://github.com/ulid/spec): 48-bit millisecond time and
// 80 bits of randomness, Crockford base32. Within one millisecond the random
// part is incremented so IDs created by this isolate always sort in order.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

function incrementDigits(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const d = next[i] ?? 0;
    if (d < 31) {
      next[i] = d + 1;
      return next;
    }
    next[i] = 0;
  }
  // 80 bits exhausted within one millisecond: practically impossible.
  throw new Error("ULID random part overflowed");
}

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementDigits(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  return encodeTime(now) + lastRandom.map((d) => ALPHABET.charAt(d)).join("");
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}
