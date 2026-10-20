// Pure unit tests for reading an email's headers, for sender verification and
// for converting an HTML body to text (SPEC 11.2-11.3).

import { describe, expect, it } from "vitest";
import { htmlToText } from "../../src/worker/email/body";
import {
  allHeaders,
  decodeHeaderValue,
  domainOf,
  firstHeader,
  headerText,
  parseAddressList,
  parseHeaders,
} from "../../src/worker/email/headers";
import { authResultWords, authservId, senderVerified } from "../../src/worker/email/verify";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("headerText", () => {
  it("stops at the first empty line and keeps the headers whole", () => {
    expect(headerText(bytes("From: a@b\r\nSubject: hi\r\n\r\nBody\r\nhere"))).toBe("From: a@b\r\nSubject: hi\r\n");
    expect(headerText(bytes("From: a@b\nSubject: hi\n\nBody"))).toBe("From: a@b\nSubject: hi\n");
  });

  it("returns everything when there is no blank line", () => {
    expect(headerText(bytes("From: a@b"))).toBe("From: a@b");
  });
});

describe("parseHeaders", () => {
  it("unfolds a continued header, keeping the work space", () => {
    expect(parseHeaders("Subject: one\r\n two\r\nFrom: a@b")).toEqual([
      { key: "Subject", value: "one two" },
      { key: "From", value: "a@b" },
    ]);
  });

  it("keeps repeated headers in the order the message carries them", () => {
    const headers = parseHeaders("Received: one\r\nReceived: two\r\nReceived: three");
    expect(allHeaders(headers, "received")).toEqual(["one", "two", "three"]);
  });

  it("trims the space after the colon and ignores a line without one", () => {
    expect(parseHeaders("To:    a@b\r\nnot a header\r\nX: y")).toEqual([
      { key: "To", value: "a@b" },
      { key: "X", value: "y" },
    ]);
  });
});

describe("firstHeader and allHeaders", () => {
  it("compare names case-insensitively and firstHeader takes the first", () => {
    const headers = parseHeaders("Authentication-Results: first\r\nauthentication-results: second");
    expect(firstHeader(headers, "AUTHENTICATION-RESULTS")).toBe("first");
    expect(firstHeader(headers, "absent")).toBeNull();
    expect(allHeaders(headers, "Authentication-Results")).toEqual(["first", "second"]);
  });
});

describe("parseAddressList", () => {
  it("reads a display name and an angle-bracket address", () => {
    expect(parseAddressList("Person One <one@example.com>")).toEqual([
      { address: "one@example.com", name: "Person One" },
    ]);
  });

  it("keeps a comma inside a quoted display name", () => {
    expect(parseAddressList('"Doe, John" <john@example.com>')).toEqual([
      { address: "john@example.com", name: "Doe, John" },
    ]);
  });

  it("unwraps a group into its members", () => {
    expect(parseAddressList("Team: a@example.com, B <b@example.com>;")).toEqual([
      { address: "a@example.com", name: "" },
      { address: "b@example.com", name: "B" },
    ]);
  });

  it("lower-cases the address and reads a bare angle-bracket address", () => {
    expect(parseAddressList("<One@Example.COM>")).toEqual([{ address: "one@example.com", name: "" }]);
  });
});

describe("decodeHeaderValue and domainOf", () => {
  it("decodes RFC 2047 encoded words", () => {
    expect(decodeHeaderValue("=?utf-8?Q?caf=C3=A9?=")).toBe("café");
  });

  it("takes the domain after the last at-sign", () => {
    expect(domainOf("a@sub.example.com")).toBe("sub.example.com");
    expect(domainOf("nonsense")).toBe("");
  });
});

describe("authservId and authResultWords", () => {
  const results = "mx.cloudflare.net; dmarc=pass header.from=example.org; spf=pass smtp.mailfrom=example.org";

  it("reads the authserv-id, lower-case", () => {
    expect(authservId("MX.Cloudflare.NET (Postfix); dmarc=pass")).toBe("mx.cloudflare.net");
    expect(authservId("")).toBe("");
  });

  it("lists only the method results, in order", () => {
    expect(authResultWords(results)).toEqual(["dmarc=pass", "spf=pass"]);
  });
});

describe("senderVerified", () => {
  const pass = "mx.cloudflare.net; dmarc=pass header.from=example.org";

  it("accepts only a pass for the From domain", () => {
    expect(senderVerified(pass, "example.org")).toBe(true);
    expect(senderVerified(pass, "other.org")).toBe(false);
    expect(senderVerified("mx.cloudflare.net; dmarc=fail header.from=example.org", "example.org")).toBe(false);
    expect(senderVerified("mx.cloudflare.net; dmarc=pass", "example.org")).toBe(false);
  });

  it("ignores results from any other authserv-id", () => {
    expect(senderVerified("example.com; dmarc=pass header.from=example.org", "example.org")).toBe(false);
  });

  it("reads case-insensitively and refuses a missing header", () => {
    expect(senderVerified("MX.Cloudflare.NET; DMARC=PASS header.from=Example.ORG", "example.org")).toBe(true);
    expect(senderVerified(null, "example.org")).toBe(false);
    expect(senderVerified(pass, "")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("drops tags and turns block ends into blank lines", () => {
    expect(htmlToText("<p>Hello <b>there</b></p><br><p>Bye</p>")).toBe("Hello there\n\nBye");
  });

  it("decodes the common entities and drops style and script", () => {
    expect(htmlToText("<style>p{}</style>a &amp; b &lt;c&gt; &nbsp;d")).toBe("a & b <c> d");
  });
});
