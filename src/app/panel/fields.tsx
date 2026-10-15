// Editors for the item panel. Text fields keep a local draft and save on
// blur or Enter; a failed save keeps the draft so no typing is lost.

import { useId, useMemo, useRef, type KeyboardEvent } from "react";
import type { Id, Label } from "../../shared/types";
import { LabelChip } from "../components/ui";
import { useDraft } from "../hooks";
import { dueDateProblem } from "../lib/items";
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
  autoFocus = false,
}: {
  label: string;
  value: string;
  onSave: (next: string) => Promise<boolean>;
  validate?: (next: string) => string | null;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  large?: boolean;
  autoFocus?: boolean;
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
    autoFocus,
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

/**
 * The native date input reports every keystroke as a value: half-typed years
 * ("0002-10-20") and "" while a part is empty. So the date is a draft, saved
 * when the field is left or Enter is pressed, and only when it is whole and
 * from 1900 on; Clear clears at once.
 */
export function DueDateField({
  value,
  onSave,
  disabled = false,
}: {
  value: string | null;
  onSave: (date: string | null) => Promise<boolean>;
  disabled?: boolean;
}) {
  const id = useId();
  const incomplete = useRef(false);
  const field = useDraft(
    value ?? "",
    (next) => onSave(next === "" ? null : next),
    (next) => dueDateProblem(next, incomplete.current),
  );
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Due date
        {field.saving && <span className="field-status">Saving…</span>}
      </label>
      <div className="inline-row">
        <input
          id={id}
          className="input input--date"
          type="date"
          value={field.draft}
          disabled={disabled}
          onChange={(e) => {
            incomplete.current = e.target.validity.badInput;
            field.change(e.target.value);
          }}
          onBlur={() => void field.commit()}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            void field.commit();
          }}
          aria-invalid={field.error ? true : undefined}
          aria-describedby={field.error ? `${id}-error` : undefined}
        />
        {value !== null && (
          <button
            type="button"
            className="button button--quiet"
            disabled={disabled}
            onClick={() => {
              field.cancel();
              void onSave(null);
            }}
          >
            Clear
          </button>
        )}
      </div>
      {field.error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {field.error}
        </p>
      )}
    </div>
  );
}
