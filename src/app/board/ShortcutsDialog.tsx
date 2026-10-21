// The "Keyboard shortcuts" dialog: a native <dialog> opened with showModal,
// so Escape closes it and focus returns to the toolbar button that opened it.
// The rows come from the same table the key handling reads.

import { useEffect, useId, useRef } from "react";
import { CloseIcon } from "../components/icons";
import { SHORTCUTS } from "./shortcuts";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const frame = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = frame.current;
    if (!dialog) return;
    // Escape closes the dialog itself; the close event then tells the board.
    const closed = () => onClose();
    dialog.addEventListener("close", closed);
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => dialog.removeEventListener("close", closed);
  }, [open, onClose]);

  return (
    <dialog ref={frame} className="modal shortcuts" aria-labelledby={headingId}>
      <header className="modal-head">
        <h2 id={headingId}>Keyboard shortcuts</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={() => frame.current?.close()}>
          <CloseIcon />
        </button>
      </header>
      <dl>
        {SHORTCUTS.map((row) => (
          <div className="shortcuts-row" key={row.description}>
            <dt>
              {row.keys.map((key) => (
                <kbd key={key.event}>{key.label}</kbd>
              ))}
            </dt>
            <dd>{row.description}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}
