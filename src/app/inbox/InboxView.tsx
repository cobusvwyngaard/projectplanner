// The Inbox: captures waiting to be processed, with editable transcripts.

import { useCallback, useEffect, useState } from "react";
import type { Capture, Id, User } from "../../shared/types";
import type { Run } from "../../shared/types";
import type { CaptureDetailResponse, CapturesResponse } from "../../shared/api";
import { api, errorMessage } from "../api";
import { useDraft } from "../hooks";
import { navigate, openItem } from "../router";
import { store, usePlanner } from "../store";
import { reportError } from "../toast";
import { TimeAgo } from "../components/ui";
import { CaptureAudio } from "../capture/AudioPlayer";

type StatusFilter = "new" | "claimed" | "processed" | "ignored" | "all";

const FILTERS: readonly { id: StatusFilter; label: string }[] = [
  { id: "new", label: "New" },
  { id: "claimed", label: "Claimed" },
  { id: "processed", label: "Processed" },
  { id: "ignored", label: "Ignored" },
  { id: "all", label: "All" },
];

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function kindLabel(kind: Capture["kind"]): string {
  if (kind === "voice") return "Voice";
  if (kind === "file") return "Upload";
  if (kind === "email") return "Email";
  return "Text";
}

export function InboxView() {
  const users = usePlanner((s) => s.users);
  const capturesMap = usePlanner((s) => s.captures);

  const [status, setStatus] = useState<StatusFilter>("new");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [runs, setRuns] = useState<Map<Id, Run>>(new Map());
  const [next, setNext] = useState<string | null>(null);
  const [problem, setProblem] = useState<CapturesResponse["transcription"]["problem"]>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<Id>>(new Set());
  const [details, setDetails] = useState<Map<Id, CaptureDetailResponse>>(new Map());

  const mergeRuns = useCallback((incoming: readonly Run[]) => {
    setRuns((prev) => {
      const next = new Map(prev);
      for (const r of incoming) next.set(r.id, r);
      return next;
    });
  }, []);

  const load = useCallback(async (filter: StatusFilter) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.captures({ status: filter, limit: 30 });
      setCaptures(res.captures);
      setNext(res.next);
      setProblem(res.transcription.problem);
      mergeRuns(res.runs);
      for (const c of res.captures) store.putCapture(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [mergeRuns]);

  useEffect(() => {
    void load(status);
  }, [status, load]);

  // Live updates from the store's captures map.
  useEffect(() => {
    setCaptures((prev) => {
      let changed = false;
      const byId = new Map(prev.map((c) => [c.id, c]));
      const nextList = prev.map((c) => {
        const sc = capturesMap.get(c.id);
        if (sc && sc !== c) {
          changed = true;
          return sc;
        }
        return c;
      });
      for (const sc of capturesMap.values()) {
        if (!byId.has(sc.id) && (status === "all" || sc.inbox_status === status)) {
          nextList.unshift(sc);
          changed = true;
        }
      }
      return changed ? nextList : prev;
    });
  }, [capturesMap, status]);

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const res = await api.captures({ status, before: next, limit: 30 });
      setCaptures((prev) => [...prev, ...res.captures.filter((c) => !prev.some((p) => p.id === c.id))]);
      setNext(res.next);
      setProblem(res.transcription.problem);
      mergeRuns(res.runs);
      for (const c of res.captures) store.putCapture(c);
    } catch (err) {
      reportError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const updateCapture = useCallback(async (id: Id, body: { text?: string; inbox_status?: "new" | "ignored" | "processed" }) => {
    try {
      const res = await api.updateCapture(id, body);
      setCaptures((prev) => prev.map((c) => (c.id === id ? res.row : c)));
      store.putCapture(res.row);
      return res.row;
    } catch (err) {
      reportError(err);
      return null;
    }
  }, []);

  const toggleExpand = useCallback(async (id: Id) => {
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });
    if (!details.has(id)) {
      try {
        const d = await api.capture(id);
        setDetails((prev) => {
          const m = new Map(prev);
          m.set(id, d);
          return m;
        });
        mergeRuns(d.runs);
      } catch (err) {
        reportError(err);
      }
    }
  }, [details, mergeRuns]);

  return (
    <div className="page inbox">
      <header className="page-head">
        <h1>Inbox</h1>
      </header>

      {problem === "missing_key" && (
        <p className="banner" role="status">
          Transcription is not set up. Add the ELEVENLABS_API_KEY secret (see SETUP.md).
        </p>
      )}
      {problem === "bad_key" && (
        <p className="banner" role="status">
          ElevenLabs refused the API key. Check the ELEVENLABS_API_KEY secret (see SETUP.md).
        </p>
      )}

      <div className="segmented" role="group" aria-label="Inbox filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="segment"
            aria-pressed={status === f.id}
            onClick={() => setStatus(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading && <p className="muted">Loading the inbox…</p>}

      {!loading && captures.length === 0 && (
        <p className="empty">Nothing in the inbox. Tap Record to capture something.</p>
      )}

      <ul className="capture-list">
        {captures.map((capture) => (
          <CaptureCard
            key={capture.id}
            capture={capture}
            users={users}
            runs={runs}
            expanded={expanded.has(capture.id)}
            detail={details.get(capture.id)}
            onToggleExpand={() => void toggleExpand(capture.id)}
            onUpdate={(body) => void updateCapture(capture.id, body)}
          />
        ))}
      </ul>

      {next && (
        <div className="load-more">
          <button type="button" className="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

interface CardProps {
  capture: Capture;
  users: ReadonlyMap<Id, User>;
  runs: Map<Id, Run>;
  expanded: boolean;
  detail: CaptureDetailResponse | undefined;
  onToggleExpand: () => void;
  onUpdate: (body: { text?: string; inbox_status?: "new" | "ignored" | "processed" }) => void;
}

function CaptureCard({ capture, users, runs, expanded, detail, onToggleExpand, onUpdate }: CardProps) {
  const author = capture.author_user_id === null ? "Email" : users.get(capture.author_user_id)?.display_name ?? "Someone";
  const runId = capture.processed_by_run_id ?? capture.claimed_by_run_id;
  const run = runId ? runs.get(runId) ?? detail?.runs.find((r) => r.id === runId) : undefined;
  const actorName = run?.user_id ? users.get(run.user_id)?.display_name : undefined;

  const saveTranscript = useCallback(
    async (next: string) => {
      const updated = await api.updateCapture(capture.id, { text: next });
      store.putCapture(updated.row);
      return true;
    },
    [capture.id],
  );

  // A failed save keeps the typing and reports the reason in a toast.
  const draft = useDraft(capture.text ?? "", async (next) => {
    try {
      return await saveTranscript(next);
    } catch (err) {
      reportError(err);
      return false;
    }
  });

  const retryTranscription = async () => {
    try {
      const res = await api.retryCapture(capture.id);
      store.putCapture(res.capture);
    } catch (err) {
      reportError(err);
    }
  };

  const showRetry =
    capture.transcript_status === "failed" ||
    (capture.transcript_status === "pending" &&
      Date.now() - new Date(capture.created_at).getTime() > 10 * 60 * 1000);

  return (
    <li className="capture-card" data-capture-id={capture.id}>
      <div className="capture-card-head">
        <span className="capture-author">{author}</span>
        <TimeAgo ts={capture.created_at} />
        <span className="capture-kind">{kindLabel(capture.kind)}</span>
        {capture.duration_s !== null && <span className="capture-duration">{formatDuration(capture.duration_s)}</span>}
      </div>

      {(capture.kind === "voice" || capture.kind === "file") && capture.r2_key && (
        <CaptureAudio captureId={capture.id} />
      )}

      <div className="capture-transcript">
        {capture.transcript_status === "pending" && <p className="muted">Transcribing…</p>}
        {capture.transcript_status === "failed" && capture.transcript_error && (
          <p className="notice notice--error" role="alert">{capture.transcript_error}</p>
        )}
        <textarea
          className="input textarea"
          value={draft.draft}
          onChange={(e) => draft.change(e.target.value)}
          onBlur={() => void draft.commit()}
          rows={4}
        />
        {draft.error && <p className="field-error" role="alert">{draft.error}</p>}
        <div className="button-row">
          <button type="button" className="button button--small" disabled={draft.saving} onClick={() => void draft.commit()}>
            {draft.saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {showRetry && (
        <button type="button" className="button button--small" onClick={() => void retryTranscription()}>
          Retry transcription
        </button>
      )}

      {runId && (
        <div className="capture-run">
          <p>
            <span className="badge badge--claude">Claude (via {actorName ?? "someone"})</span>
          </p>
          {run?.summary && <p className="run-summary">{run.summary}</p>}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              if (runId) navigate(`/activity?run=${runId}`);
            }}
          >
            View in Activity
          </button>
        </div>
      )}

      <div className="button-row">
        {capture.inbox_status === "new" && (
          <>
            <button type="button" className="button button--small" onClick={() => onUpdate({ inbox_status: "ignored" })}>
              Ignore
            </button>
            <button type="button" className="button button--small button--primary" onClick={() => onUpdate({ inbox_status: "processed" })}>
              Mark as processed
            </button>
          </>
        )}
        {(capture.inbox_status === "ignored" || capture.inbox_status === "processed") && (
          <button type="button" className="button button--small" onClick={() => onUpdate({ inbox_status: "new" })}>
            Back to inbox
          </button>
        )}
        {capture.inbox_status === "claimed" && <p className="muted small">Claude is working on this capture.</p>}
      </div>

      <button type="button" className="link-button" onClick={onToggleExpand}>
        {expanded ? "Hide details" : "Show details"}
      </button>
      {expanded && !detail && <p className="muted small">Loading…</p>}
      {expanded && detail && (
        <div className="capture-detail">
          {detail.items.length === 0 ? (
            <p className="muted small">No items changed.</p>
          ) : (
            <ul>
              {detail.items.map((item) => (
                <li key={`${item.type}:${item.id}`}>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      if (item.type === "note" || item.type === "task") openItem({ type: item.type, id: item.id });
                    }}
                  >
                    {item.title}
                  </button>
                  <span className="muted small"> {item.actions.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}