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

**Done on the Worker and Claude side** in `a0fb3e5` and `992c8ba`: every link
now carries a direction (`none`, `a_to_b`, `b_to_a`), a dependency is only
allowed between two tasks, a dependency that would make a circle of tasks
waiting for each other is refused, and ticking a task off while it still
waits for a task that is not done yet warns instead of being refused. The
API takes `depends` on `POST /api/links` and `PATCH /api/links/:id`, and
Claude's `link_items` takes a `kind`, `get_board` returns the kind and
which end comes first, and `update_task` returns the warning. What is left
is the app: the arrow on the board, the words in the List view and the item
panel, and the way to reverse a dependency or turn it back into a plain
connection.

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
