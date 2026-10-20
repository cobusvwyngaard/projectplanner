// Settings › People: the display name and initials of each person, and the
// email addresses that reach the planner's Inbox (SPEC 11.2).

import { useId, useMemo, useState, type FormEvent } from "react";
import type { UpdateUserRequest } from "../../shared/api";
import type { User, UserEmail } from "../../shared/types";
import { archiveUserEmail, createUserEmail, updateUser } from "../actions";
import { errorMessage } from "../api";
import { ConfirmButton } from "../components/ui";
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
  // You first, then the other person. The list is by id, so it works for any number of people.
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
          <PersonCard key={user.id} user={user} isMe={user.id === me.id} />
        ))}
      </div>
    </section>
  );
}

/** One person's card: their name form and their email addresses. */
function PersonCard({ user, isMe }: { user: User; isMe: boolean }) {
  return (
    <div className="person-card">
      <PersonForm user={user} isMe={isMe} />
      <EmailAddresses userId={user.id} />
    </div>
  );
}

/** A person's registered email addresses, oldest first. */
function useEmailsFor(userId: string): UserEmail[] {
  // Select the whole map (a stable value) and derive the list here, so the
  // component re-renders when this person's addresses change, not on every
  // store change.
  const emails = usePlanner((s) => s.emails);
  return useMemo(
    () => [...emails.values()].filter((e) => e.user_id === userId).sort((a, b) => a.address.localeCompare(b.address)),
    [emails, userId],
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

/** The addresses of one person, each with a Remove, and the field to add one. */
function EmailAddresses({ userId }: { userId: string }) {
  const id = useId();
  const emails = useEmailsFor(userId);
  return (
    <div className="person-emails">
      <h4>Email addresses</h4>
      <p className="muted small">Email sent from, to or cc'd to these addresses can reach the planner's Inbox.</p>
      {emails.length === 0 ? (
        <p className="muted small">No email addresses yet.</p>
      ) : (
        <ul className="email-list">
          {emails.map((email) => (
            <AddressRow key={email.id} email={email} />
          ))}
        </ul>
      )}
      <AddEmail userId={userId} idPrefix={id} />
    </div>
  );
}

function AddressRow({ email }: { email: UserEmail }) {
  return (
    <li className="email-row">
      <span className="email-address">{email.address}</span>
      <ConfirmButton
        className="button button--small button--quiet"
        question={`Remove ${email.address}?`}
        confirmLabel="Remove"
        onConfirm={() => void archiveUserEmail(email.id)}
      >
        Remove
      </ConfirmButton>
    </li>
  );
}

function AddEmail({ userId, idPrefix }: { userId: string; idPrefix: string }) {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = address.trim() === "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (empty || busy) return;
    setBusy(true);
    try {
      await createUserEmail(userId, address.trim());
      setAddress("");
      setError(null);
    } catch (err) {
      // The message names the person the address already belongs to, so it
      // stays under the field.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-email" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label className="field-label" htmlFor={`${idPrefix}-address`}>
          Add an email address
        </label>
        <input
          id={`${idPrefix}-address`}
          className="input"
          type="email"
          value={address}
          autoComplete="off"
          placeholder="name@example.com"
          onChange={(e) => {
            setAddress(e.target.value);
            setError(null);
          }}
        />
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button button--primary" disabled={empty || busy}>
        {busy ? "Adding…" : "Add"}
      </button>
    </form>
  );
}
