// Settings › People: the display name and initials of both people.

import { useId, useMemo, useState, type FormEvent } from "react";
import type { UpdateUserRequest } from "../../shared/api";
import type { User } from "../../shared/types";
import { updateUser } from "../actions";
import { usePlanner } from "../store";

const NAME_MAX = 40;
const INITIALS = /^[\p{L}\p{N}]{1,3}$/u;

function problemWith(name: string, initials: string): string | null {
  if (name.trim() === "") return "A name cannot be empty.";
  if (!INITIALS.test(initials.trim())) return "Initials must be 1 to 3 letters or digits.";
  return null;
}

export function PeopleSection() {
  const users = usePlanner((s) => s.users);
  const me = usePlanner((s) => s.me);
  // You first, then the other person.
  const people = useMemo(
    () => [...users.values()].sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id) || a.id.localeCompare(b.id)),
    [users, me.id],
  );
  return (
    <section className="settings-section" aria-labelledby="people-heading">
      <h2 id="people-heading">People</h2>
      <p className="muted">Names and initials show on cards, in item histories and in the activity.</p>
      <div className="people">
        {people.map((user) => (
          <PersonForm key={user.id} user={user} isMe={user.id === me.id} />
        ))}
      </div>
    </section>
  );
}

function PersonForm({ user, isMe }: { user: User; isMe: boolean }) {
  const id = useId();
  // null while not editing, so a change from the other browser shows straight away.
  const [draft, setDraft] = useState<{ name: string; initials: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const name = draft?.name ?? user.display_name;
  const initials = draft?.initials ?? user.initials;
  const patch: UpdateUserRequest = {};
  if (name.trim() !== user.display_name) patch.display_name = name.trim();
  if (initials.trim().toUpperCase() !== user.initials) patch.initials = initials.trim().toUpperCase();
  const changed = Object.keys(patch).length > 0;
  const problem = draft ? problemWith(name, initials) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || problem || busy) return;
    setBusy(true);
    const saved = await updateUser(user.id, patch);
    setBusy(false);
    // On failure the typed name and initials stay.
    if (saved) setDraft(null);
  };

  return (
    <form className="person" onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-heading`}>
      <div className="person-head">
        <span className="initials initials--large" aria-hidden="true">
          {initials.trim().toUpperCase() || "?"}
        </span>
        <h3 id={`${id}-heading`}>
          {user.display_name}
          {isMe && <span className="muted"> (you)</span>}
        </h3>
      </div>
      <div className="field-grid">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-name`}>
            Display name
          </label>
          <input
            id={`${id}-name`}
            className="input"
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(e) => setDraft({ name: e.target.value, initials })}
          />
        </div>
        <div className="field field--initials">
          <label className="field-label" htmlFor={`${id}-initials`}>
            Initials
          </label>
          <input
            id={`${id}-initials`}
            className="input"
            value={initials}
            maxLength={3}
            autoComplete="off"
            autoCapitalize="characters"
            onChange={(e) => setDraft({ name, initials: e.target.value })}
          />
        </div>
      </div>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={!changed || problem !== null || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {draft && (
          <button type="button" className="button button--quiet" onClick={() => setDraft(null)}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
