import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchPhrase, normalise } from "../../src/worker/auth/phrase";
import { PHRASE_USERS, USER_1_ID, USER_2_ID } from "../../src/worker/auth/users";
import { PHRASE_1, PHRASE_2 } from "../helpers/auth";
import { USER_1, USER_2 } from "../helpers/db";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalise", () => {
  it("trims, collapses inner whitespace and lower-cases", () => {
    expect(normalise("  Blue   Kettle\tON  the\n\nStove ")).toBe("blue kettle on the stove");
  });

  it("collapses Unicode spaces too", () => {
    expect(normalise("blue  kettle")).toBe("blue kettle");
  });

  it("puts composed and decomposed accents in the same form (NFC)", () => {
    const composed = "café crème";
    const decomposed = "café crème";
    expect(composed).not.toBe(decomposed);
    expect(normalise(decomposed)).toBe(normalise(composed));
  });
});

describe("matchPhrase", () => {
  it("uses the test bindings, not .dev.vars", () => {
    expect(env.LOGIN_PHRASE_1).toBe(PHRASE_1);
    expect(env.LOGIN_PHRASE_2).toBe(PHRASE_2);
  });

  it("maps phrase 1 and phrase 2 to the two seeded users", async () => {
    expect(await matchPhrase(env, PHRASE_1)).toBe(1);
    expect(await matchPhrase(env, PHRASE_2)).toBe(2);
    expect(PHRASE_USERS[1]).toBe(USER_1);
    expect(PHRASE_USERS[2]).toBe(USER_2);
    expect([USER_1_ID, USER_2_ID]).toEqual([USER_1, USER_2]);
  });

  it("matches whatever the case and spacing", async () => {
    expect(await matchPhrase(env, "  test PHRASE    one ")).toBe(1);
    expect(await matchPhrase(env, "TEST PHRASE TWO")).toBe(2);
    expect(await matchPhrase(env, "test\tphrase\n two")).toBe(2);
  });

  it("matches composed against decomposed accents", async () => {
    const accented = { LOGIN_PHRASE_1: "Crème Brûlée", LOGIN_PHRASE_2: "other words" };
    expect(await matchPhrase(accented, "crème brûlée")).toBe(1);
  });

  it("rejects wrong, partial and empty input", async () => {
    expect(await matchPhrase(env, "test phrase three")).toBeNull();
    expect(await matchPhrase(env, "test phrase")).toBeNull();
    expect(await matchPhrase(env, "")).toBeNull();
    expect(await matchPhrase(env, "   ")).toBeNull();
  });

  it("never matches a missing or blank configured phrase", async () => {
    const onlyTwo = { LOGIN_PHRASE_2: "second placeholder" };
    expect(await matchPhrase(onlyTwo, "")).toBeNull();
    expect(await matchPhrase(onlyTwo, "undefined")).toBeNull();
    expect(await matchPhrase(onlyTwo, "second placeholder")).toBe(2);
    const blank = { LOGIN_PHRASE_1: "   ", LOGIN_PHRASE_2: "" };
    expect(await matchPhrase(blank, "")).toBeNull();
    expect(await matchPhrase(blank, " ")).toBeNull();
  });

  it("refuses every sign-in when both phrases are equal, and logs no phrase", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const twins = { LOGIN_PHRASE_1: "Placeholder Twin", LOGIN_PHRASE_2: "  placeholder   TWIN " };
    expect(await matchPhrase(twins, "placeholder twin")).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("LOGIN_PHRASE_1");
    expect(logged.toLowerCase()).not.toContain("placeholder");
    expect(logged.toLowerCase()).not.toContain("twin");
  });
});
