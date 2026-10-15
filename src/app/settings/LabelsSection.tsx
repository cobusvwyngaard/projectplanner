// Settings › Labels: create (preset palette or custom hex, with a live
// preview), rename, recolour, reorder, archive and unarchive, and the label
// new notes and tasks get.

import { useId, useMemo, useState, type FormEvent } from "react";
import { PRESET_COLOURS, textColourFor } from "../../shared/colour";
import type { Label } from "../../shared/types";
import { createLabel, reorderLabels, setLabelArchived, updateLabel, updateSetting } from "../actions";
import { DownIcon, UpIcon } from "../components/icons";
import { LabelChip } from "../components/ui";
import { useDraft } from "../hooks";
import { usePlanner } from "../store";
import { ColourPicker } from "./ColourPicker";

const NAME_MAX = 40;
const FIRST_PRESET = PRESET_COLOURS[0]?.hex ?? "#fde68a";

const nameProblem = (name: string) => (name.trim() === "" ? "Give the label a name." : null);

function bySortOrder(a: Label, b: Label): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name);
}

export function LabelsSection() {
  const labels = usePlanner((s) => s.labels);
  const active = useMemo(() => [...labels.values()].filter((l) => l.archived_at === null).sort(bySortOrder), [labels]);
  const archived = useMemo(
    () => [...labels.values()].filter((l) => l.archived_at !== null).sort((a, b) => a.name.localeCompare(b.name)),
    [labels],
  );

  const move = (index: number, delta: -1 | 1) => {
    const order = [...active];
    const [moved] = order.splice(index, 1);
    if (!moved) return;
    order.splice(index + delta, 0, moved);
    void reorderLabels(
      order.map((l) => l.id),
      order.map((l, i) => ({ ...l, sort_order: i })),
    );
  };

  return (
    <section className="settings-section" aria-labelledby="labels-heading">
      <h2 id="labels-heading">Labels</h2>
      <p className="muted">Labels colour notes and tasks. They have no fixed meaning; use them however suits you both.</p>
      {active.length === 0 ? (
        <p className="empty">No labels yet. Create one below.</p>
      ) : (
        <ol className="label-list" aria-label="Labels in order">
          {active.map((label, index) => (
            <LabelRow
              key={label.id}
              label={label}
              first={index === 0}
              last={index === active.length - 1}
              onMove={(delta) => move(index, delta)}
            />
          ))}
        </ol>
      )}
      <NewLabelForm />
      <DefaultLabelField active={active} />
      {archived.length > 0 && (
        <div className="archived-labels">
          <h3>Archived labels</h3>
          <p className="muted small">Items that have an archived label keep its colour. It cannot be given to other items.</p>
          <ul className="label-list">
            {archived.map((label) => (
              <li key={label.id} className="label-row label-row--archived">
                <LabelChip label={label} />
                <button type="button" className="button button--small" onClick={() => void setLabelArchived(label.id, false)}>
                  Unarchive
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function LabelRow({
  label,
  first,
  last,
  onMove,
}: {
  label: Label;
  first: boolean;
  last: boolean;
  onMove: (delta: -1 | 1) => void;
}) {
  const [recolouring, setRecolouring] = useState(false);
  const name = useDraft(
    label.name,
    async (next) => (await updateLabel(label.id, { name: next.trim() })) !== undefined,
    nameProblem,
  );
  const preview = { ...label, name: name.draft.trim() || label.name };
  return (
    <li className="label-row">
      <div className="label-row-main">
        <span className="label-row-preview">
          <LabelChip label={preview} />
        </span>
        <input
          className="input label-name"
          value={name.draft}
          maxLength={NAME_MAX}
          aria-label={`Name of the label ${label.name}`}
          aria-invalid={name.error ? true : undefined}
          onChange={(e) => name.change(e.target.value)}
          onBlur={() => void name.commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void name.commit();
            }
          }}
        />
        <div className="label-row-actions">
          <button
            type="button"
            className="button button--small"
            aria-expanded={recolouring}
            aria-label={`Recolour ${label.name}`}
            onClick={() => setRecolouring((open) => !open)}
          >
            <span className="swatch" style={{ background: label.colour_hex }} aria-hidden="true" />
            <span className="label-colour-text">Colour</span>
          </button>
          <button type="button" className="icon-button" disabled={first} aria-label={`Move ${label.name} up`} onClick={() => onMove(-1)}>
            <UpIcon />
          </button>
          <button type="button" className="icon-button" disabled={last} aria-label={`Move ${label.name} down`} onClick={() => onMove(1)}>
            <DownIcon />
          </button>
          <button type="button" className="button button--small button--quiet" onClick={() => void setLabelArchived(label.id, true)}>
            Archive
          </button>
        </div>
      </div>
      {name.error && (
        <p className="field-error" role="alert">
          {name.error}
        </p>
      )}
      {recolouring && <RecolourForm label={label} onDone={() => setRecolouring(false)} />}
    </li>
  );
}

function RecolourForm({ label, onDone }: { label: Label; onDone: () => void }) {
  const [colour, setColour] = useState(label.colour_hex);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const saved = await updateLabel(label.id, { colour_hex: colour });
    setBusy(false);
    if (saved) onDone();
  };
  return (
    <div className="recolour">
      <ColourPicker value={colour} onChange={setColour} legend={`New colour for ${label.name}`} />
      <Preview name={label.name} colour={colour} />
      <div className="button-row">
        <button type="button" className="button button--primary" disabled={busy || colour === label.colour_hex} onClick={() => void save()}>
          Save colour
        </button>
        <button type="button" className="button button--quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** How a label looks as a chip and as a sticky note. */
function Preview({ name, colour }: { name: string; colour: string }) {
  return (
    <div className="label-preview" aria-label="Preview">
      <span className="muted small">Preview</span>
      <LabelChip label={{ name: name || "New label", colour_hex: colour, archived_at: null }} />
      <span className="preview-note" style={{ background: colour, color: textColourFor(colour) }} aria-hidden="true">
        {name || "New label"}
      </span>
    </div>
  );
}

function NewLabelForm() {
  const nameId = useId();
  const [name, setName] = useState("");
  const [colour, setColour] = useState(FIRST_PRESET);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const created = await createLabel({ name: trimmed, colour_hex: colour });
    setBusy(false);
    // On failure the name and colour stay as they were typed.
    if (created) setName("");
  };

  return (
    <form className="new-label" onSubmit={(e) => void submit(e)} aria-labelledby={`${nameId}-heading`}>
      <h3 id={`${nameId}-heading`}>New label</h3>
      <div className="field">
        <label className="field-label" htmlFor={nameId}>
          Name
        </label>
        <input
          id={nameId}
          className="input"
          value={name}
          maxLength={NAME_MAX}
          placeholder="For example Garden or Admin"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <ColourPicker value={colour} onChange={setColour} legend="Colour" />
      <Preview name={name.trim()} colour={colour} />
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={busy || name.trim() === ""}>
          {busy ? "Creating…" : "Create label"}
        </button>
      </div>
    </form>
  );
}

function DefaultLabelField({ active }: { active: readonly Label[] }) {
  const id = useId();
  const value = usePlanner((s) => s.settings.default_label_id);
  const current = value !== null && active.some((l) => l.id === value) ? value : "";
  return (
    <div className="field default-label">
      <label className="field-label" htmlFor={id}>
        Label for new notes and tasks
      </label>
      <select
        id={id}
        className="input select"
        value={current}
        onChange={(e) => void updateSetting("default_label_id", e.target.value || null)}
      >
        <option value="">No label</option>
        {active.map((label) => (
          <option key={label.id} value={label.id}>
            {label.name}
          </option>
        ))}
      </select>
    </div>
  );
}
