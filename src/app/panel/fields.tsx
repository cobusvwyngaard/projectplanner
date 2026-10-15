// Editors for the item panel. Text fields keep a local draft and save on
// blur or Enter; a failed save keeps the draft so no typing is lost.

import { useId, useMemo, type KeyboardEvent } from "react";
import type { Id, Label } from "../../shared/types";
import { LabelChip } from "../components/ui";
import { useDraft } from "../hooks";
import { usePlanner } from "../store";

export function TextField({
  label,
  value,
  onSave,
  validate,
  multiline = false,
  placeholder,
  disabled = false,
  large = false,
}: {
  label: string;
  value: string;
  onSave: (next: string) => Promise<boolean>;
  validate?: (next: string) => string | null;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  large?: boolean;
}) {
  const id = useId();
  const field = useDraft(value, onSave, validate);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const submit = multiline ? e.key === "Enter" && (e.metaKey || e.ctrlKey) : e.key === "Enter";
    if (submit) {
      e.preventDefault();
      void field.commit();
    }
  };
  const common = {
    id,
    value: field.draft,
    placeholder,
    disabled,
    onChange: (e: { target: { value: string } }) => field.change(e.target.value),
    onBlur: () => void field.commit(),
    onKeyDown,
    "aria-invalid": field.error ? true : undefined,
    "aria-describedby": field.error ? `${id}-error` : undefined,
  };
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {field.saving && <span className="field-status">Saving…</span>}
      </label>
      {multiline ? (
        <textarea className="input textarea" rows={large ? 8 : 4} {...common} />
      ) : (
        <input className={`input${large ? " input--large" : ""}`} type="text" {...common} />
      )}
      {field.error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {field.error}
        </p>
      )}
    </div>
  );
}

function bySortOrder(a: Label, b: Label): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name);
}

/** Active labels in their order, plus the current label even if it is archived. */
export function useLabelOptions(current: Id | null): Label[] {
  const labels = usePlanner((s) => s.labels);
  return useMemo(() => {
    const active = [...labels.values()].filter((l) => l.archived_at === null).sort(bySortOrder);
    const kept = current === null ? undefined : labels.get(current);
    return kept && kept.archived_at !== null ? [...active, kept] : active;
  }, [labels, current]);
}

export function LabelPicker({ value, onChange, disabled = false }: { value: Id | null; onChange: (id: Id | null) => void; disabled?: boolean }) {
  const name = useId();
  const options = useLabelOptions(value);
  return (
    <fieldset className="field chip-picker" disabled={disabled}>
      <legend className="field-label">Label</legend>
      <label className="chip-option">
        <input type="radio" className="option-input" name={name} checked={value === null} onChange={() => onChange(null)} />
        <span className="chip chip--none">No label</span>
      </label>
      {options.map((label) => (
        <label key={label.id} className="chip-option">
          <input type="radio" className="option-input" name={name} checked={value === label.id} onChange={() => onChange(label.id)} />
          <LabelChip label={label} />
        </label>
      ))}
    </fieldset>
  );
}

export function AssigneePicker({ value, onChange, disabled = false }: { value: Id | null; onChange: (id: Id | null) => void; disabled?: boolean }) {
  const name = useId();
  const users = usePlanner((s) => s.users);
  const me = usePlanner((s) => s.me);
  return (
    <fieldset className="field chip-picker" disabled={disabled}>
      <legend className="field-label">Assigned to</legend>
      <label className="chip-option">
        <input type="radio" className="option-input" name={name} checked={value === null} onChange={() => onChange(null)} />
        <span className="chip chip--none">Nobody</span>
      </label>
      {[...users.values()].map((user) => (
        <label key={user.id} className="chip-option">
          <input type="radio" className="option-input" name={name} checked={value === user.id} onChange={() => onChange(user.id)} />
          <span className="chip">
            <span className="initials initials--small" aria-hidden="true">
              {user.initials}
            </span>
            {user.display_name}
            {user.id === me.id && " (me)"}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function DueDateField({ value, onChange, disabled = false }: { value: string | null; onChange: (date: string | null) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Due date
      </label>
      <div className="inline-row">
        <input
          id={id}
          className="input input--date"
          type="date"
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "" || /^\d{4}-\d{2}-\d{2}$/.test(next)) onChange(next === "" ? null : next);
          }}
        />
        {value !== null && (
          <button type="button" className="button button--quiet" disabled={disabled} onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
