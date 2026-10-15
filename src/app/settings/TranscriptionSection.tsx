// Settings › Transcription: keyterms (names of people and projects the
// transcription should spell right) and whether to send them to ElevenLabs.

import { useId, useState } from "react";
import { updateSetting } from "../actions";
import { usePlanner } from "../store";

/** The Worker's limits on keyterms (src/worker/settings.ts). */
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_LENGTH = 50;

function parseKeyterms(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function keytermProblem(terms: readonly string[]): string | null {
  if (terms.length > MAX_KEYTERMS) return `There can be at most ${MAX_KEYTERMS} keyterms.`;
  const long = terms.find((t) => t.length > MAX_KEYTERM_LENGTH);
  return long ? `“${long}” is longer than ${MAX_KEYTERM_LENGTH} characters.` : null;
}

export function TranscriptionSection() {
  const id = useId();
  const keyterms = usePlanner((s) => s.settings.stt_keyterms);
  const enabled = usePlanner((s) => s.settings.stt_keyterms_enabled);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const text = draft ?? keyterms.join("\n");
  const terms = parseKeyterms(text);
  const problem = keytermProblem(terms);
  const changed = draft !== null && terms.join("\n") !== keyterms.join("\n");

  const save = async () => {
    setSaving(true);
    const saved = await updateSetting("stt_keyterms", terms);
    setSaving(false);
    // On failure the typed keyterms stay.
    if (saved) setDraft(null);
  };

  const toggle = async () => {
    setSwitching(true);
    await updateSetting("stt_keyterms_enabled", !enabled);
    setSwitching(false);
  };

  return (
    <section className="settings-section" aria-labelledby="transcription-heading">
      <h2 id="transcription-heading">Transcription</h2>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-keyterms`}>
          Keyterms
        </label>
        <p className="muted small" id={`${id}-keyterms-hint`}>
          Names of people, places and projects the transcription should recognise. One per line.
        </p>
        <textarea
          id={`${id}-keyterms`}
          className="input textarea"
          rows={6}
          value={text}
          spellCheck={false}
          aria-describedby={`${id}-keyterms-hint`}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className="button-row">
        <button type="button" className="button button--primary" disabled={!changed || problem !== null || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save keyterms"}
        </button>
        {draft !== null && (
          <button type="button" className="button button--quiet" onClick={() => setDraft(null)}>
            Cancel
          </button>
        )}
      </div>
      <div className="switch-row">
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={enabled}
          aria-describedby={`${id}-switch-note`}
          disabled={switching}
          onClick={() => void toggle()}
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span>Use keyterm prompting</span>
        </button>
        <p className="muted small" id={`${id}-switch-note`}>
          ElevenLabs bills keyterm prompting extra per hour of audio. While this is off, the keyterms are kept but not sent.
        </p>
      </div>
    </section>
  );
}
