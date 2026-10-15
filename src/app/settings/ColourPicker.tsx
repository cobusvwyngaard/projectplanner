// Choosing a label colour: the preset palette, or any colour through the
// browser's colour input or a #rrggbb text field.

import { useId, useState } from "react";
import { PRESET_COLOURS, normaliseHex, textColourFor } from "../../shared/colour";

export function ColourPicker({ value, onChange, legend }: { value: string; onChange: (hex: string) => void; legend: string }) {
  const name = useId();
  const hexId = useId();
  // The hex field follows the chosen colour, except while someone types in it.
  const [typing, setTyping] = useState<string | null>(null);
  const text = typing ?? value;
  const valid = normaliseHex(text) !== null;
  const custom = !PRESET_COLOURS.some((p) => p.hex === value);

  return (
    <fieldset className="colour-picker">
      <legend className="field-label">{legend}</legend>
      <div className="swatches">
        {PRESET_COLOURS.map((preset) => (
          <label key={preset.hex} className="swatch-option" title={preset.name}>
            <input
              type="radio"
              name={name}
              className="option-input"
              checked={value === preset.hex}
              onChange={() => onChange(preset.hex)}
            />
            <span className="swatch-big" style={{ background: preset.hex, color: textColourFor(preset.hex) }} aria-hidden="true">
              {value === preset.hex ? "✓" : ""}
            </span>
            <span className="visually-hidden">{preset.name}</span>
          </label>
        ))}
      </div>
      <div className="custom-colour">
        <label className={`colour-input${custom ? " colour-input--chosen" : ""}`}>
          <input type="color" value={value} onChange={(e) => onChange(e.target.value.toLowerCase())} />
          <span>Custom colour</span>
        </label>
        <label className="visually-hidden" htmlFor={hexId}>
          Hex colour
        </label>
        <input
          id={hexId}
          className="input input--hex"
          value={text}
          maxLength={7}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          aria-invalid={valid ? undefined : true}
          onFocus={() => setTyping(value)}
          onChange={(e) => {
            setTyping(e.target.value);
            const hex = normaliseHex(e.target.value);
            if (hex !== null) onChange(hex);
          }}
          onBlur={() => setTyping(null)}
        />
      </div>
      {!valid && <p className="field-error">Write the colour as #rrggbb, for example #1d4ed8.</p>}
    </fieldset>
  );
}
