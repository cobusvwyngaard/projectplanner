# Findings from live testing

Problems and requests found while the owner uses the live planner. Each item
is fixed later through a coding prompt; when it is done, it moves to "Done"
with the commit that fixed it.

## Open

### 1. Tasks from outside senders must stand out in "Not on the board"

Reported 2026-10-21. An email is accepted when a registered address is in
To/Cc (SPEC 11.2), so an email from anyone else, cc'd to the planner and a
registered person, becomes a capture, and Claude turns it into tasks that
land in the tray ("Not on the board", `src/app/board/Tray.tsx`) like any
other.

Wanted:
- In the tray, tasks that came from an outside sender go **at the bottom**,
  below all other tasks.
- They are **marked in red**.
- They carry the text **"From an unregistered email address"**.

Proposed details (to confirm with the owner):
- "From outside" means: the task's source captures include an email whose
  sender is not a registered planner address. A registered sender whose
  domain failed authentication ("Sender not verified") is flagged the same
  way, with the text "From an email whose sender is not verified".
- The Worker works this out and sends it with each task (for example
  `from_outside: "unregistered" | "unverified" | null` on TaskView), from the
  task's `source_capture_ids`; the app does not guess.
- The same red marking and text also appear on the task's card on the board,
  in the List view and in the item panel, so the flag does not disappear
  once the task is placed.

### 2. Links between tasks must show which task depends on which

Reported 2026-10-21. Today a link has no direction: each pair is stored once
with its two ends sorted (DECISIONS.md, "Links are stored once per pair"), so
"A → B" and "B → A" are the same link and the board draws a plain line. The
owner wants connections between tasks to flow from one task to the other, so
it is clear which task is the dependent one.

Wanted:
- A link between two tasks can say "B depends on A" (A must be done first).
- The board draws it as an arrow from A to B; the List view and the item
  panel say it in words.

Proposed details (to confirm with the owner):
- Two kinds of link: **depends on** (task to task only, directed) and
  **related** (any note or task, undirected, as today). Existing links become
  "related"; a migration adds the kind and keeps every current link.
- The item panel shows "Waits for: A" on B and "Needed for: B" on A, and lets
  a person make, reverse or remove a dependency; on the board, drawing a
  connection between two tasks asks "depends on" or "related" (or uses a
  default the owner chooses).
- Circular dependencies (A waits for B waits for A) are refused.
- An open task that waits for an open task shows "Waiting for A" on its card
  and in the lists. Open question for the owner: should ticking it off first
  only warn, or be refused?
- Claude: link_items gets a kind (and direction), its description explains
  when a dependency is right (the capture says one thing must happen before
  another) versus a plain link, and get_board returns the kind and
  direction. Reverting and history work for the new links as for the old.

## Done

(nothing yet)
