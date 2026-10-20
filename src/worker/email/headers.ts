// Reading the header block of a raw message (SPEC 11.1-11.3). The body is never
// touched here: the email handler must stay cheap.

import { addressParser, decodeWords, type Mailbox } from "postal-mime";

/** One header, still encoded: name and unfolded value; repeats are kept in order. */
export interface RawHeader {
  key: string;
  value: string;
}

/** A parsed email address and its display name (both decoded). */
export interface EmailAddress {
  address: string;
  name: string;
}

/**
 * The header block of a raw message as text: the bytes up to the first empty
 * line, decoded as UTF-8. An 8-bit body therefore never costs anything.
 */
export function headerText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes.subarray(0, headerEnd(bytes)));
}

/** Index just after the last header line, i.e. before the first empty line. */
function headerEnd(bytes: Uint8Array): number {
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    const previous = bytes[i - 1] === 0x0d ? i - 2 : i - 1;
    if (bytes[previous] === 0x0a) return previous + 1;
  }
  return bytes.length;
}

/**
 * Split a header block into headers. A line starting with a space or tab
 * continues the previous header (RFC 5322 folding; the work space stays).
 */
export function parseHeaders(text: string): RawHeader[] {
  const headers: RawHeader[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") continue;
    if (/^[ \t]/.test(line)) {
      const last = headers[headers.length - 1];
      if (last) last.value += line;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    headers.push({ key: line.slice(0, colon).trim(), value: line.slice(colon + 1).replace(/^[ \t]+/, "") });
  }
  return headers;
}

/** The first value of a header, compared case-insensitively, or null. */
export function firstHeader(headers: readonly RawHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  for (const h of headers) {
    if (h.key.toLowerCase() === wanted) return h.value;
  }
  return null;
}

/** Every value of a header, in the order the message carries them. */
export function allHeaders(headers: readonly RawHeader[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter((h) => h.key.toLowerCase() === wanted).map((h) => h.value);
}

/** Decode RFC 2047 encoded words in a plain header value (a subject, say). */
export function decodeHeaderValue(value: string): string {
  return decodeWords(value);
}

/**
 * Parse an address list (From, To, Cc). Groups are unwrapped and display names
 * are decoded by the parser, so encoded words are never decoded before the
 * split: a comma inside a name must not be read as a separator.
 */
export function parseAddressList(value: string): EmailAddress[] {
  return addressParser(value, { flatten: true })
    .filter((a): a is Mailbox => a.address !== undefined)
    .map((m) => ({ address: m.address.toLowerCase(), name: m.name }));
}

/** The part of an address after the last '@', lower-case, or "". */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}
