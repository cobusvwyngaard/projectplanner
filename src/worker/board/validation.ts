// Field rules for board data, shared by the app API and the MCP tools so a
// value is accepted or refused the same way whichever door it comes through.

import { z } from "zod";
import type { Id } from "../../shared/types";
import { ValidationError } from "../lib/errors";
import { isLocalDate } from "../lib/time";
import { activeLabels, getRow } from "./queries";

export const LIMITS = {
  title: 200,
  text: 20_000,
  labelName: 40,
  displayName: 40,
  coordinate: 1_000_000,
  noteWidth: { min: 120, max: 2000 },
  noteHeight: { min: 80, max: 2000 },
} as const;

const id = z.string().min(1, "An id cannot be empty.").max(64, "That id is too long.");
const localDate = z.string().refine(isLocalDate, "A date must be a real date written as YYYY-MM-DD.");

export const fields = {
  id,
  localDate,
  taskTitle: z
    .string()
    .trim()
    .min(1, "Give the task a title.")
    .max(LIMITS.title, `A title can be at most ${LIMITS.title} characters.`),
  noteTitle: z.string().trim().max(LIMITS.title, `A title can be at most ${LIMITS.title} characters.`),
  text: z.string().max(LIMITS.text, "The text can be at most 20 000 characters."),
  labelId: id.nullable(),
  assigneeId: id.nullable(),
  dueDate: localDate.nullable(),
  coordinate: z
    .number()
    .min(-LIMITS.coordinate, "That position is too far from the centre of the board.")
    .max(LIMITS.coordinate, "That position is too far from the centre of the board."),
  noteWidth: z
    .number()
    .min(LIMITS.noteWidth.min, `A note must be at least ${LIMITS.noteWidth.min} pixels wide.`)
    .max(LIMITS.noteWidth.max, `A note can be at most ${LIMITS.noteWidth.max} pixels wide.`),
  noteHeight: z
    .number()
    .min(LIMITS.noteHeight.min, `A note must be at least ${LIMITS.noteHeight.min} pixels high.`)
    .max(LIMITS.noteHeight.max, `A note can be at most ${LIMITS.noteHeight.max} pixels high.`),
  labelName: z
    .string()
    .trim()
    .min(1, "Give the label a name.")
    .max(LIMITS.labelName, `A label name can be at most ${LIMITS.labelName} characters.`),
  colour: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "A colour must be written as #rrggbb, for example #1d4ed8.")
    .toLowerCase(),
  displayName: z
    .string()
    .trim()
    .min(1, "A name cannot be empty.")
    .max(LIMITS.displayName, `A name can be at most ${LIMITS.displayName} characters.`),
  initials: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[\p{L}\p{N}]{1,3}$/u, "Initials must be 1 to 3 letters or digits."),
};

/**
 * The label must exist and not be archived. `current` is the label the item
 * already has: keeping an archived label on an item is allowed.
 */
export async function checkLabelId(db: D1Database, labelId: Id | null | undefined, current?: Id | null): Promise<void> {
  if (labelId === null || labelId === undefined) return;
  const label = await getRow(db, "label", labelId);
  if (!label) throw new ValidationError("That label does not exist.", { field: "label_id" });
  if (label.archived_at !== null && labelId !== current) {
    throw new ValidationError("That label has been archived. Choose another one.", { field: "label_id" });
  }
}

/** The assignee must be one of the two people (or nobody). */
export async function checkAssigneeId(db: D1Database, userId: Id | null | undefined): Promise<void> {
  if (userId === null || userId === undefined) return;
  if (!(await getRow(db, "user", userId))) {
    throw new ValidationError("A task can only be assigned to one of the two people.", { field: "assignee_id" });
  }
}

/** Label names are unique among labels that are not archived, ignoring case. */
export async function checkLabelNameFree(db: D1Database, name: string, exceptId?: Id): Promise<void> {
  const wanted = name.toLowerCase();
  const clash = (await activeLabels(db)).find((l) => l.id !== exceptId && l.name.toLowerCase() === wanted);
  if (clash) throw new ValidationError(`There is already a label called "${clash.name}".`, { field: "name" });
}
