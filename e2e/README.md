# Smoke tests (Playwright)

End-to-end checks of phase 1 in a real browser against `wrangler dev`.

```
cp .dev.vars.example .dev.vars          # once; the tests read the phrases from it
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e
```

`PLAYWRIGHT_BROWSERS_PATH` is only needed where the browsers live outside
Playwright's default folder (as in the development container). Elsewhere run
`npx playwright install chromium` once instead. Playwright is pinned to 1.56.1.

## How it runs

- `playwright.config.ts` starts `scripts/e2e-server.sh`, which deletes
  `.wrangler/e2e`, applies the D1 migrations there and runs
  `wrangler dev --local --port 8788 --persist-to .wrangler/e2e`. Wrangler
  builds the app first (the `build` command in `wrangler.jsonc`), so the tests
  always run against the current source.
- Chromium only, one worker, base URL `http://localhost:8788`, locale `en-ZA`
  and time zone Africa/Johannesburg.
- The tests sign in through the phrase page with `LOGIN_PHRASE_1` and
  `LOGIN_PHRASE_2` from `.dev.vars`. They never print them.
- Every name and text the tests create is made up, with a random suffix so the
  files can share one database in any order.
- No fixed sleeps: the tests wait for what the page shows (or poll the API with
  `expect.poll`) instead.

## The session cookie on http://localhost

The session cookie is `__Host-planner_session` with `Secure`. Chromium treats
`http://localhost` as a potentially trustworthy origin, so it stores and sends
Secure cookies there; the `__Host-` prefix is satisfied as well. No test-only
change to the cookie is needed, and production keeps the Secure cookie as it
is. `auth.spec.ts` checks the cookie's flags and lifetime.

## What is covered

| File | SPEC phase 1 check |
|---|---|
| `auth.spec.ts` | Phrase 1 signs in as Person 1 and phrase 2 as Person 2; a wrong phrase shows the generic message; a new context from saved storage state is still signed in; a 401 from the API goes to `/login?next=…` |
| `collaboration.spec.ts` | Person 1 creates a note and a task, assigns the task to Person 2, sets a due date, links the two and ticks the task off; Person 2 sees it all arrive through polling with Person 1's badges and history, then edits the task; the Activity view attributes every change, and Humans only and the person filter work; a single change is reverted from the history, and a revert over a later change asks first and then "Revert anyway" works |
| `list.spec.ts` | The list tabs show the right tasks, inline tick-off moves a task to Done, quick-add in Theirs assigns to the other person; a phone-sized screen opens the list, a wide one the board |
| `settings.spec.ts` | Labels are created (custom hex), renamed, recoloured (preset) and reordered; a person is renamed; keyterm prompting is switched and stays switched; Sign out this browser goes to the phrase page and ends the session |
| `canvas.spec.ts` | Dragging a note records exactly one move (checked in the item's history), resizing exactly one size change, a task dragged in from the tray is placed, and + Note twice in a row does not stack the notes |
| `layout.spec.ts` | Who last changed a task is shown in full on its card (wide and phone screens) |

Results and traces of failures go to `test-results/` (git-ignored).
