-- Directed links between tasks (docs/testing-findings.md, item 2).
--
-- A link's two ends stay in the canonical order they have always had (the
-- smaller "type:id" first), so a pair is stored once. The new column says how
-- the two ends relate:
--
--   'none'   - a plain connection: the two items belong together
--   'a_to_b' - the a end must be done first; b waits for a
--   'b_to_a' - the b end must be done first; a waits for b
--
-- A direction is only ever set between two tasks; the Worker refuses it
-- otherwise. Every link that exists today is a plain connection, so the
-- column starts as 'none' for all of them.

ALTER TABLE links ADD COLUMN direction TEXT NOT NULL DEFAULT 'none'
  CHECK (direction IN ('none','a_to_b','b_to_a'));
