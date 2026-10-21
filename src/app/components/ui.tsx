// Small building blocks shared by the views: label chips, initials, due-date
// chips, provenance badges, times and a two-step confirm button.

import { useState, type ReactNode } from "react";
import { actorLabel, sameActor } from "../../shared/actors";
import { textColourFor } from "../../shared/colour";
import { dueState } from "../../shared/dates";
import { formatDateTime, formatDue, relativeTime } from "../../shared/format";
import type { FromOutside, Id, Label, Provenance, User } from "../../shared/types";
import { useNow } from "../hooks";
import { usePlanner } from "../store";

export function LabelChip({ label, small = false }: { label: Pick<Label, "name" | "colour_hex" | "archived_at">; small?: boolean }) {
  return (
    <span
      className={`label-chip${small ? " label-chip--small" : ""}`}
      style={{ background: label.colour_hex, color: textColourFor(label.colour_hex) }}
    >
      {label.name || "Untitled label"}
      {label.archived_at !== null && <span className="visually-hidden"> (archived)</span>}
    </span>
  );
}

/** The label of an item, by id (archived labels included). */
export function ItemLabel({ labelId, small = false }: { labelId: Id | null; small?: boolean }) {
  const label = usePlanner((s) => (labelId === null ? undefined : s.labels.get(labelId)));
  return label ? <LabelChip label={label} small={small} /> : null;
}

export function Initials({ user, title }: { user: Pick<User, "initials" | "display_name"> | undefined; title?: string }) {
  if (!user) return null;
  return (
    <span className="initials" title={title ?? user.display_name} aria-label={title ?? user.display_name}>
      {user.initials}
    </span>
  );
}

/** Initials of whoever a task is assigned to. */
export function AssigneeChip({ userId }: { userId: Id | null }) {
  const user = usePlanner((s) => (userId === null ? undefined : s.users.get(userId)));
  return user ? <Initials user={user} title={`Assigned to ${user.display_name}`} /> : null;
}

/** Due date: amber when due today or soon, red when overdue (open tasks only). */
export function DueChip({ due, done }: { due: string | null; done: boolean }) {
  const today = usePlanner((s) => s.today);
  if (due === null) return null;
  const state = done ? "later" : dueState(due, today);
  const words = state === "overdue" ? "Overdue: " : "Due ";
  return (
    <span className={`due-chip due-chip--${state ?? "later"}`} title={`${words}${formatDue(due, today)}`}>
      {formatDue(due, today)}
    </span>
  );
}

export function TimeAgo({ ts, now }: { ts: string; now?: Date }) {
  const clock = useNow();
  return (
    <time dateTime={ts} title={formatDateTime(ts)}>
      {relativeTime(ts, now ?? clock)}
    </time>
  );
}

/** Why a task counts as coming from outside, said in red (SPEC section 5). */
export function FromOutsideNote({ kind }: { kind: FromOutside }) {
  return (
    <span className="from-outside">
      {kind === "unregistered" ? "From an unregistered email address" : "From an email whose sender is not verified"}
    </span>
  );
}

/** "Cobus" or "Claude (via Cobus)", plus "changed by …" when someone else changed it later. */
export function ProvenanceLine({ prov, detailed = false }: { prov: Provenance | null; detailed?: boolean }) {
  const users = usePlanner((s) => s.users);
  if (!prov) return null;
  const created = actorLabel(prov.created_by, users);
  const changedBySomeoneElse = !sameActor(prov.created_by, prov.changed_by);
  const changed = actorLabel(prov.changed_by, users);
  if (detailed) {
    return (
      <dl className="provenance provenance--detailed">
        <div>
          <dt>Created by</dt>
          <dd>
            <Badge kind={prov.created_by.kind}>{created}</Badge> <TimeAgo ts={prov.created_at} />
          </dd>
        </div>
        {prov.changed_at !== prov.created_at && (
          <div>
            <dt>Last changed by</dt>
            <dd>
              <Badge kind={prov.changed_by.kind}>{changed}</Badge> <TimeAgo ts={prov.changed_at} />
            </dd>
          </div>
        )}
      </dl>
    );
  }
  return (
    <span className="provenance" title={`Created by ${created}${changedBySomeoneElse ? `, last changed by ${changed}` : ""}`}>
      <Badge kind={prov.created_by.kind}>{created}</Badge>
      {changedBySomeoneElse && (
        <>
          {" · changed by "}
          <Badge kind={prov.changed_by.kind}>{changed}</Badge>
        </>
      )}
    </span>
  );
}

function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`badge badge--${kind}`}>{children}</span>;
}

/** A button that asks "Are you sure?" in place before acting. */
export function ConfirmButton({
  children,
  question,
  confirmLabel,
  onConfirm,
  className = "button",
  disabled = false,
}: {
  children: ReactNode;
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={className} disabled={disabled} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={question}>
      <span className="confirm-question">{question}</span>
      <button
        type="button"
        className="button button--danger"
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="button button--quiet" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
