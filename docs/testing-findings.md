# Findings from live testing

Problems and requests found while the owner uses the live planner. Each item
is fixed later through a coding prompt; when it is done, it moves to "Done"
with the commit that fixed it.

## Open

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

Details (proposed; owner decisions marked):
- Two kinds of link: **depends on** (task to task only, directed) and
  **related** (any note or task, undirected, as today). Existing links become
  "related"; a migration adds the kind and keeps every current link.
- The item panel shows "Waits for: A" on B and "Needed for: B" on A, and lets
  a person make, reverse or remove a dependency.
- **Owner decision (2026-10-21):** on the board, drawing a connection from
  task A to task B makes "B depends on A" straight away, in the direction
  drawn, with a quick way to change it on the link itself (reverse it, or
  make it "related"). A connection that involves a note is "related".
- Circular dependencies (A waits for B waits for A) are refused.
- An open task that waits for an open task shows "Waiting for A" on its card
  and in the lists.
- **Owner decision (2026-10-21):** ticking off a task whose prerequisite is
  still open only warns ("A is not done yet"); it is never refused. This
  applies to Claude too: the write succeeds and the tool result carries the
  warning.
- Claude: link_items gets a kind (and direction), its description explains
  when a dependency is right (the capture says one thing must happen before
  another) versus a plain link, and get_board returns the kind and
  direction. Reverting and history work for the new links as for the old.

### 3. The phrase page should let you see the phrase while typing

Reported 2026-10-22. The sign-in field is a password field, so a typing
mistake in a long phrase cannot be seen.

Wanted: a "Show phrase" control next to the field that switches it between
hidden and visible, hidden by default.

Notes for whoever builds it:
- The sign-in page is deliberately self-contained: a worker test asserts it
  loads no scripts or other files, and the CSP allows scripts only from
  'self'. A show/hide toggle needs a few lines of script, so serve them as one
  small same-origin file (for example /login.js, public like /favicon.svg)
  and adjust that test to allow exactly that file; no inline script.
- The button has an accessible name ("Show phrase" / "Hide phrase") and
  aria-pressed; the field keeps autocomplete="current-password" so password
  managers still fill it. Without JavaScript the page still works (hidden).
- Apply the same control wherever a phrase is typed later (Phase 6 admin).

## Done

### 1. Tasks from outside senders must stand out in "Not on the board"

Done 2026-10-21 in `71c075c` and `3edcfca`: the Worker works out
`from_outside` for every task and sends it with the bootstrap, the change
feed, mutation responses and `get_board`; the tray puts flagged tasks below
all others, and the tray item, board card, List view and item panel mark
them in red with the text that says why.

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

Details:
- "From outside" means: the task's source captures include an email whose
  sender is not a registered planner address. A registered sender whose
  domain failed authentication ("Sender not verified") is flagged the same
  way, with the text "From an email whose sender is not verified".
- The Worker works this out and sends it with each task (`from_outside`
  on TaskView, one of `"unregistered"`, `"unverified"` or null), from the
  task's `source_capture_ids`; the app does not guess.
- The same red marking and text also appear on the task's card on the board,
  in the List view and in the item panel, so the flag does not disappear
  once the task is placed.
