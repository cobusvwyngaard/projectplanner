// Settings › Claude connections: every OAuth connection Claude holds for
// any person, newest first, with Disconnect per connection. Revoking one
// takes effect at once: the access token and the refresh token both stop
// working.

import { useCallback, useEffect, useState } from "react";
import type { ClaudeConnectionView } from "../../shared/api";
import { userName } from "../../shared/actors";
import { formatDay } from "../../shared/format";
import { api, errorMessage } from "../api";
import { ConfirmButton } from "../components/ui";
import { usePlanner } from "../store";
import { attempt } from "../toast";

export function ClaudeSection() {
  const users = usePlanner((s) => s.users);
  const [connections, setConnections] = useState<ClaudeConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.claudeConnections().then(
      (response) => {
        setConnections(response.connections);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);
  useEffect(load, [load]);

  const disconnect = async (connection: ClaudeConnectionView) => {
    setBusy(true);
    const done = await attempt(() => api.disconnectClaude(connection.user_id, connection.id));
    setBusy(false);
    if (done !== undefined) load();
  };

  return (
    <section className="settings-section" aria-labelledby="claude-heading">
      <h2 id="claude-heading">Claude connections</h2>
      <p className="muted">
        Claude keeps access until a connection is disconnected here. Disconnecting signs that connection out everywhere.
      </p>
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {!error && connections === null && <p className="muted">Loading the connections…</p>}
      {connections !== null && connections.length === 0 && <p className="empty">No Claude connections yet.</p>}
      {connections !== null && connections.length > 0 && (
        <ul className="sessions">
          {connections.map((connection) => (
            <li key={connection.id} className="session-row">
              <div className="session-info">
                <p className="session-device">
                  {connection.client_name}
                </p>
                <p className="muted small">
                  {userName(connection.user_id, users)} · Connected {formatDay(connection.connected_at)}
                </p>
              </div>
              <ConfirmButton
                question={`Disconnect ${connection.client_name}? ${userName(connection.user_id, users)} will need to allow it again before Claude can connect.`}
                confirmLabel="Disconnect"
                className="button button--small"
                disabled={busy}
                onConfirm={() => void disconnect(connection)}
              >
                Disconnect
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
