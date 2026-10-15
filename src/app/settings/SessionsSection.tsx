// Settings › Signed-in browsers: every active session of both people, with
// Sign out per browser, Sign out everywhere (all of mine) and Sign out this
// browser. Signing this browser out goes to the phrase page.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionView } from "../../shared/api";
import { userName } from "../../shared/actors";
import { describeUserAgent, formatDateTime } from "../../shared/format";
import { api, errorMessage } from "../api";
import { ConfirmButton, TimeAgo } from "../components/ui";
import { usePlanner } from "../store";
import { attempt } from "../toast";

function toPhrasePage(): void {
  window.location.assign("/login");
}

export function SessionsSection() {
  const users = usePlanner((s) => s.users);
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.sessions().then(
      (response) => {
        setSessions(response.sessions);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);
  useEffect(load, [load]);

  // This browser first, then the most recently used.
  const shown = useMemo(
    () => (sessions ? [...sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at.localeCompare(a.last_seen_at)) : null),
    [sessions],
  );

  const run = async (action: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    const done = await attempt(action);
    setBusy(false);
    if (done !== undefined) after();
  };

  const signOut = (session: SessionView) =>
    void run(() => api.revokeSession(session.id), session.current ? toPhrasePage : load);

  return (
    <section className="settings-section" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Signed-in browsers</h2>
      <p className="muted">Each browser stays signed in until it is signed out here. Signing in again needs the phrase.</p>
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {!error && shown === null && <p className="muted">Loading the browsers…</p>}
      {shown && (
        <ul className="sessions">
          {shown.map((session) => (
            <li key={session.id} className="session-row">
              <div className="session-info">
                <p className="session-device">
                  {describeUserAgent(session.user_agent)}
                  {session.current && <span className="badge badge--current">This browser</span>}
                </p>
                <p className="muted small">
                  {userName(session.user_id, users)} · last seen <TimeAgo ts={session.last_seen_at} /> · signed in{" "}
                  {formatDateTime(session.created_at)}
                </p>
              </div>
              <button type="button" className="button button--small" disabled={busy} onClick={() => signOut(session)}>
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="button-row session-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void run(() => api.revokeCurrentSession(), toPhrasePage)}
        >
          Sign out this browser
        </button>
        <ConfirmButton
          question="Sign out of every browser you use, this one included?"
          confirmLabel="Sign out everywhere"
          disabled={busy}
          onConfirm={() => void run(() => api.revokeMySessions(), toPhrasePage)}
        >
          Sign out everywhere
        </ConfirmButton>
      </div>
    </section>
  );
}
