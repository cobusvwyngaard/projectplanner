// Phase 5: the board's shortcuts come from one table, and the resolver
// refuses any press that is not a plain key on the board itself.

import { describe, expect, it } from "vitest";
import { SHORTCUTS, resolveShortcut, type ShortcutContext } from "../../src/app/board/shortcuts";

function press(over: Partial<ShortcutContext> = {}): ShortcutContext {
  return { key: "n", ctrl: false, meta: false, alt: false, inTextField: false, dialogOpen: false, ...over };
}

describe("resolveShortcut", () => {
  it("maps every key on the board to its action, with or without Shift", () => {
    const actions: Array<[string, string]> = [
      ["n", "new-note"],
      ["N", "new-note"],
      ["t", "new-task"],
      ["f", "fit"],
      ["+", "zoom-in"],
      ["-", "zoom-out"],
      ["0", "zoom-100"],
      ["Escape", "clear-selection"],
      ["?", "show-shortcuts"],
    ];
    for (const [key, action] of actions) expect(resolveShortcut(press({ key })), key).toBe(action);
  });

  it("says nothing while Ctrl, Meta or Alt is held", () => {
    for (const over of [{ ctrl: true }, { meta: true }, { alt: true }]) {
      expect(resolveShortcut(press(over))).toBeNull();
    }
  });

  it("says nothing while typing in a field", () => {
    expect(resolveShortcut(press({ inTextField: true }))).toBeNull();
    expect(resolveShortcut(press({ key: "?", inTextField: true }))).toBeNull();
  });

  it("says nothing while a dialog is open", () => {
    expect(resolveShortcut(press({ dialogOpen: true }))).toBeNull();
  });

  it("leaves the keys React Flow handles to React Flow", () => {
    for (const key of ["Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Backspace"]) {
      expect(resolveShortcut(press({ key })), key).toBeNull();
    }
  });

  it("ignores keys no row claims", () => {
    expect(resolveShortcut(press({ key: "q" }))).toBeNull();
    expect(resolveShortcut(press({ key: "F5" }))).toBeNull();
  });
});

describe("the shortcuts table", () => {
  it("gives every action exactly once, with keys and a description", () => {
    const actions = SHORTCUTS.flatMap((row) => (row.action === null ? [] : [row.action]));
    expect(actions).toEqual(["new-note", "new-task", "fit", "zoom-in", "zoom-out", "zoom-100", "clear-selection", "show-shortcuts"]);
    for (const row of SHORTCUTS) {
      expect(row.keys.length, row.description).toBeGreaterThan(0);
      expect(row.description).not.toBe("");
      for (const key of row.keys) expect(key.label).not.toBe("");
    }
  });

  it("lists the keys that stay with React Flow", () => {
    const held = SHORTCUTS.filter((row) => row.action === null).map((row) => row.description);
    expect(held).toEqual(["Open the focused card", "Move the selected card", "Unlink the selected links"]);
  });
});
