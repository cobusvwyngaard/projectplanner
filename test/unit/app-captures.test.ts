import { describe, expect, it } from "vitest";
import { applyChanges, fromBootstrap } from "../../src/app/lib/state";
import { bootstrap, capture, changes } from "./app-fixtures";

describe("captures in the change feed", () => {
  it("adds and updates captures in the store map", () => {
    const base = fromBootstrap(bootstrap());
    const next = applyChanges(base, changes({ captures: [capture({ id: "C1" }), capture({ id: "C2", text: "Hello" })], cursor: "E11" }));
    expect(next.captures.get("C1")?.text).toBe("Capture C1");
    expect(next.captures.get("C2")?.text).toBe("Hello");
  });

  it("updates an existing capture when its transcript arrives", () => {
    let state = fromBootstrap(bootstrap());
    state = applyChanges(state, changes({ captures: [capture({ id: "C1", transcript_status: "pending", text: null })], cursor: "E11" }));
    const updated = applyChanges(state, changes({ captures: [capture({ id: "C1", transcript_status: "done", text: "Mock transcript" })], cursor: "E12" }));
    expect(updated.captures.get("C1")?.transcript_status).toBe("done");
    expect(updated.captures.get("C1")?.text).toBe("Mock transcript");
  });
});
