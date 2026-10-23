import { describe, expect, it } from "vitest";
import {
  dependencyBefore,
  isDependencyLink,
  linkEnds,
  linkRelation,
  openPrerequisiteIds,
  taskDependencies,
  waitingForText,
} from "../../src/app/lib/dependencies";
import { link, task } from "./app-fixtures";

const T1 = { type: "task", id: "T1" } as const;
const T2 = { type: "task", id: "T2" } as const;
const N1 = { type: "note", id: "N1" } as const;

describe("linkRelation", () => {
  it("reads the stored ends in order", () => {
    expect(linkEnds(link({ id: "L1", a_type: "task", a_id: "T1", b_type: "task", b_id: "T2" }))).toEqual([T1, T2]);
  });

  it("derives before and after from the direction, not the a/b order", () => {
    const ends = { a_type: "task", a_id: "T1", b_type: "task", b_id: "T2" } as const;
    expect(linkRelation(link({ id: "L1", ...ends, direction: "a_to_b" }))).toEqual({ before: T1, after: T2 });
    expect(linkRelation(link({ id: "L1", ...ends, direction: "b_to_a" }))).toEqual({ before: T2, after: T1 });
    expect(linkRelation(link({ id: "L1", ...ends, direction: "none" }))).toBe("related");
  });

  it("gives the first task of a dependency, or null for a related link", () => {
    const ends = { a_type: "task", a_id: "T1", b_type: "task", b_id: "T2" } as const;
    expect(dependencyBefore(link({ id: "L1", ...ends, direction: "b_to_a" }))).toEqual(T2);
    expect(dependencyBefore(link({ id: "L1", ...ends, direction: "none" }))).toBeNull();
  });

  it("recognises dependencies", () => {
    expect(isDependencyLink(link({ id: "L1", direction: "a_to_b" }))).toBe(true);
    expect(isDependencyLink(link({ id: "L1", direction: "none" }))).toBe(false);
  });
});

describe("taskDependencies", () => {
  const dependent = link({ id: "L1", a_type: "task", a_id: "T1", b_type: "task", b_id: "T2", direction: "a_to_b" });
  const related = link({ id: "L2", a_type: "note", a_id: "N1", b_type: "task", b_id: "T2" });

  it("separates what a task waits for from what waits for it", () => {
    expect(taskDependencies(T2, [dependent, related])).toEqual({
      waitsFor: [{ link: dependent, other: T1 }],
      neededFor: [],
      related: [{ link: related, other: N1 }],
    });
    expect(taskDependencies(T1, [dependent, related])).toEqual({
      waitsFor: [],
      neededFor: [{ link: dependent, other: T2 }],
      related: [],
    });
  });

  it("groups a note's links as related", () => {
    expect(taskDependencies(N1, [dependent, related])).toEqual({
      waitsFor: [],
      neededFor: [],
      related: [{ link: related, other: T2 }],
    });
  });

  it("leaves out links that do not touch the item", () => {
    expect(taskDependencies({ type: "task", id: "T9" }, [dependent, related])).toEqual({
      waitsFor: [],
      neededFor: [],
      related: [],
    });
  });
});

describe("openPrerequisiteIds", () => {
  const first = task({ id: "T1", title: "Book plumber" });
  const second = task({ id: "T2", title: "Fix leak" });
  const done = task({ id: "T3", title: "Buy tiles", status: "done" });
  const archived = task({ id: "T4", title: "Old job", archived_at: "2026-10-14T09:00:00.000Z" });
  const links = [
    link({ id: "L1", a_type: "task", a_id: "T1", b_type: "task", b_id: "T2", direction: "a_to_b" }),
    link({ id: "L2", a_type: "task", a_id: "T3", b_type: "task", b_id: "T2", direction: "a_to_b" }),
    link({ id: "L3", a_type: "task", a_id: "T4", b_type: "task", b_id: "T2", direction: "a_to_b" }),
    link({ id: "L4", a_type: "note", a_id: "N1", b_type: "task", b_id: "T2" }),
  ];
  const tasks = new Map([
    [first.id, first],
    [second.id, second],
    [done.id, done],
    [archived.id, archived],
  ]);

  it("names only the open prerequisites, ignoring done, archived and note links", () => {
    expect(openPrerequisiteIds(T2, links, tasks)).toEqual(["T1"]);
    expect(openPrerequisiteIds(T1, links, tasks)).toEqual([]);
  });

  it("names one waiting task, or counts several", () => {
    const extra = task({ id: "T5", title: "Call builder" });
    const open = new Map(tasks).set(extra.id, extra);
    const both = [...links, link({ id: "L5", a_type: "task", a_id: "T5", b_type: "task", b_id: "T2", direction: "a_to_b" })];
    expect(waitingForText(T2, links, tasks)).toBe('Waiting for "Book plumber"');
    expect(waitingForText(T2, both, open)).toBe("Waiting for 2 tasks");
    expect(waitingForText(T2, [], tasks)).toBeNull();
  });

  it("names a prerequisite without a title", () => {
    const unnamed = task({ id: "T6", title: "   " });
    const open = new Map(tasks).set(unnamed.id, unnamed);
    const waiting = link({ id: "L6", a_type: "task", a_id: "T6", b_type: "task", b_id: "T2", direction: "a_to_b" });
    expect(waitingForText(T2, [waiting], open)).toBe('Waiting for "an unnamed task"');
  });
});
