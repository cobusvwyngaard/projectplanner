// One event in words (item history and Activity view), its field-level diff,
// the Claude run and source captures behind it, and Revert with its conflict
// confirmation.

import { useState, type ReactNode } from "react";
import type { RevertConflictView, RevertResponse } from "../../shared/api";
import type { Capture, Id, ItemRef, PlannerEvent, Run } from "../../shared/types";
import { api, revertConflicts } from "../api";
import { describeEvent, eventSentences, fieldLabel, type DescribeContext, type EventView, type FieldChange } from "../lib/events";
import { followLink, itemHref, openItem } from "../router";
import { store } from "../store";
import { reportError, showToast } from "../toast";
import { TimeAgo } from "./ui";
import { CaptureAudio } from "../capture/AudioPlayer";

export function ChangeList({ changes }: { changes: readonly FieldChange[] }) {
  if (changes.length === 0) return null;
  return (
    <ul className="diff">
      {changes.map((change) => (
        <li key={change.field}>
          <span className="diff-field">{change.label}:</span>{" "}
          {change.before !== null && (
            <>
              <Value text={change.before} colour={change.beforeColour} old />
              <span className="diff-arrow" aria-label="changed to">
                {" → "}
              </span>
            </>
          )}
          <Value text={change.after} colour={change.afterColour} />
        </li>
      ))}
    </ul>
  );
}

function Value({ text, colour, old = false }: { text: string; colour?: string | null | undefined; old?: boolean }) {
  return (
    <span className={old ? "diff-old" : "diff-new"}>
      {colour && <span className="swatch" style={{ background: colour }} aria-hidden="true" />}
      {text}
    </span>
  );
}

/**
 * "Cobus ticked off the task “Book flights”"; the title can be a button. In
 * an item's own history (`self`) the item is "this task" instead of its title.
 */
export function EventSentence({
  event,
  ctx,
  self = false,
  open,
}: {
  event: PlannerEvent;
  ctx: DescribeContext;
  self?: boolean;
  /** The item the title links to (opens the item panel) */
  open?: ItemRef | undefined;
}) {
  return <Sentence view={describeEvent(event, ctx)} event={event} self={self} open={open} />;
}

/**
 * One event, or a run of events that read as one sentence (the attachments of
 * an email), in words. `event` carries the kind and actor styling.
 */
export function Sentence({
  view,
  event,
  self = false,
  open,
  onRunClick,
}: {
  view: EventView;
  event: PlannerEvent;
  self?: boolean;
  open?: ItemRef | undefined;
  onRunClick?: ((runId: Id) => void) | undefined;
}) {
  const noun = self ? `this ${event.entity_type}` : view.noun;
  const run = event.actor_kind === "claude" && onRunClick !== undefined && event.run_id !== null ? event.run_id : null;
  let title: ReactNode = null;
  if (!self && view.title !== null) {
    const quoted = `“${view.title}”`;
    title = open ? (
      <a className="event-link" href={itemHref(open)} onClick={(e) => followLink(e, () => openItem(open))}>
        {quoted}
      </a>
    ) : (
      <span className="event-title">{quoted}</span>
    );
  }
  return (
    <span className="event-sentence">
      <span className={`badge badge--${event.actor_kind}`}>{view.actor}</span> {view.verb}
      {noun && ` ${noun}`}
      {title && <> {title}</>}
      {view.suffix && ` ${view.suffix}`}
      {run !== null && onRunClick && (
        <>
          {" "}
          <button type="button" className="link-button" onClick={() => onRunClick(run)}>
            <span className="run-label">Run:</span> Show this run's changes
          </button>
        </>
      )}
    </span>
  );
}

/**
 * A run of events that are shown as one sentence: the events grouped and
 * described, each with its own time, diff and Revert.
 */
export function EventEntries({
  events,
  ctx,
  extras,
  onReverted,
  selfFor,
  open,
  onRunClick,
}: {
  events: readonly PlannerEvent[];
  ctx: DescribeContext;
  extras: EventExtras;
  onReverted: () => void;
  /** The event is about the item whose history this is ("this task") */
  selfFor?: ((event: PlannerEvent) => boolean) | undefined;
  /** The item the title links to */
  open?: ((event: PlannerEvent) => ItemRef | undefined) | undefined;
  onRunClick?: ((runId: Id) => void) | undefined;
}) {
  const views = eventSentences(events, ctx);
  return (
    <>
      {views.map((view, index) => {
        const event = events[index];
        if (!event) return null;
        const self = selfFor?.(event) ?? false;
        return (
          <EventEntry
            key={event.id}
            event={event}
            view={view}
            sentence={<Sentence view={view} event={event} self={self} open={open?.(event)} onRunClick={onRunClick} />}
            self={self}
            ctx={ctx}
            extras={extras}
            onReverted={onReverted}
          />
        );
      })}
    </>
  );
}

function CaptureView({ capture, ctx }: { capture: Capture; ctx: DescribeContext }) {
  const kind =
    capture.kind === "voice" ? "Voice note" : capture.kind === "file" ? "Audio file" : capture.kind === "email" ? "Email" : "Typed note";
  const author =
    capture.author_user_id === null
      ? "Email"
      : "get" in ctx.users
        ? ctx.users.get(capture.author_user_id)?.display_name
        : undefined;
  return (
    <figure className="capture">
      <figcaption>
        {kind}
        {author && ` by ${author}`} · <TimeAgo ts={capture.created_at} />
      </figcaption>
      {capture.text ? (
        <blockquote className="capture-text">{capture.text}</blockquote>
      ) : (
        <p className="muted">
          {capture.transcript_status === "pending" ? "Transcription in progress." : "No transcript."}
        </p>
      )}
      {capture.r2_key && <CaptureAudio captureId={capture.id} />}
    </figure>
  );
}

export interface EventExtras {
  runs: ReadonlyMap<Id, Run>;
  captures?: ReadonlyMap<Id, Capture>;
}

/**
 * One event: sentence, time, diff and Revert. In an item's history it also
 * shows Claude's run (intent and summary) and the captures behind the change;
 * in the Activity feed a Claude change names its run, which filters the feed.
 */
export function EventEntry({
  event,
  view,
  sentence,
  self = false,
  ctx,
  extras,
  onReverted,
}: {
  event: PlannerEvent;
  /** The event in words; given when a run of events reads as one sentence */
  view: EventView;
  /** The sentence to show, when it is not this event alone */
  sentence: ReactNode;
  /** The event is about the item whose history this is */
  self?: boolean;
  ctx: DescribeContext;
  extras: EventExtras;
  onReverted: () => void;
}) {
  const revert = useRevert((confirm) => api.revertEvent(event.id, confirm), onReverted);
  const run = event.run_id ? extras.runs.get(event.run_id) : undefined;
  const sources = (event.source_capture_ids ?? []).flatMap((id) => {
    const capture = extras.captures?.get(id);
    return capture ? [capture] : [];
  });
  return (
    <li className={`event event--${event.actor_kind}`}>
      <div className="event-head">
        {sentence}
        <span className="event-meta">
          <TimeAgo ts={event.ts} />
          {view.revertible && <RevertButton revert={revert} label="Revert" title="Undo this change" />}
        </span>
      </div>
      {event.reverts_event_id !== null && <p className="muted small">Undoes an earlier change.</p>}
      <ChangeList changes={view.changes} />
      {event.actor_kind === "claude" && run && (
        <div className="run-note">
          <p>
            <span className="run-label">Run:</span> {run.intent}
          </p>
          {run.summary ? <p className="run-summary">{run.summary}</p> : <p className="small">No summary yet.</p>}
        </div>
      )}
      {event.actor_kind === "claude" && !run && <p className="small">Made by Claude in a run.</p>}
      {sources.length > 0 && (
        <div className="sources">
          <p className="sources-title">Based on</p>
          {sources.map((capture) => (
            <CaptureView key={capture.id} capture={capture} ctx={ctx} />
          ))}
        </div>
      )}
      <RevertConflicts revert={revert} ctx={ctx} self={self} />
    </li>
  );
}

interface ConflictGroup {
  event: PlannerEvent;
  fields: string[];
}

function groupConflicts(conflicts: readonly RevertConflictView[]): ConflictGroup[] {
  const groups = new Map<Id, ConflictGroup>();
  for (const conflict of conflicts) {
    const group = groups.get(conflict.later_event.id) ?? { event: conflict.later_event, fields: [] };
    const label = fieldLabel(conflict.field);
    if (!group.fields.includes(label)) group.fields.push(label);
    groups.set(conflict.later_event.id, group);
  }
  return [...groups.values()];
}

export interface Revert {
  busy: boolean;
  /** Later changes that touched the same fields, while asking for confirmation */
  conflicts: ConflictGroup[] | null;
  /** Extra titles for the items named in the conflicts */
  titles: Readonly<Record<string, string>> | null;
  start: () => void;
  confirm: () => void;
  cancel: () => void;
}

/**
 * Reverting an event or a run. A 409 revert_conflict keeps the later changes
 * so they can be shown with "Revert anyway", which sends confirm: true.
 */
export function useRevert(
  run: (confirm: boolean) => Promise<RevertResponse>,
  onReverted: () => void,
  conflictTitles?: () => Promise<Readonly<Record<string, string>>>,
): Revert {
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictGroup[] | null>(null);
  const [titles, setTitles] = useState<Readonly<Record<string, string>> | null>(null);

  const go = async (confirm: boolean) => {
    setBusy(true);
    try {
      const result = await run(confirm);
      setConflicts(null);
      showToast(
        result.reverted === 0
          ? "Nothing to revert: it was already undone."
          : `Reverted ${result.reverted === 1 ? "1 change" : `${result.reverted} changes`}.`,
      );
      store.pollNow();
      onReverted();
    } catch (err) {
      const found = revertConflicts(err);
      if (!found) {
        reportError(err);
        return;
      }
      if (conflictTitles) setTitles(await conflictTitles().catch(() => null));
      setConflicts(groupConflicts(found));
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    conflicts,
    titles,
    start: () => void go(false),
    confirm: () => void go(true),
    cancel: () => setConflicts(null),
  };
}

export function RevertButton({ revert, label, title }: { revert: Revert; label: string; title: string }) {
  return (
    <button
      type="button"
      className="button button--small"
      title={title}
      disabled={revert.busy || revert.conflicts !== null}
      onClick={revert.start}
    >
      {revert.busy && revert.conflicts === null ? "Reverting…" : label}
    </button>
  );
}

/** The later changes a revert would overwrite, with "Revert anyway" and Cancel. */
export function RevertConflicts({ revert, ctx, self = false }: { revert: Revert; ctx: DescribeContext; self?: boolean }) {
  if (!revert.conflicts) return null;
  const shown: DescribeContext = revert.titles ? { ...ctx, titles: { ...ctx.titles, ...revert.titles } } : ctx;
  return (
    <div className="conflict" role="alert">
      <p>
        <strong>Later changes touched the same fields.</strong> Reverting will overwrite them:
      </p>
      <ul>
        {revert.conflicts.map(({ event, fields }) => (
          <li key={event.id}>
            <EventSentence event={event} ctx={shown} self={self} /> <TimeAgo ts={event.ts} />
            <span className="conflict-fields"> ({fields.join(", ")})</span>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button type="button" className="button button--danger" disabled={revert.busy} onClick={revert.confirm}>
          {revert.busy ? "Reverting…" : "Revert anyway"}
        </button>
        <button type="button" className="button button--quiet" disabled={revert.busy} onClick={revert.cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
