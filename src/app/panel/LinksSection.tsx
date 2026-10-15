// The item panel's links: linked notes and tasks with Unlink, and a
// "Link to…" search picker.

import { useMemo, useState } from "react";
import type { ItemRef } from "../../shared/types";
import { linkItems, unlink } from "../actions";
import { NoteIcon, TaskIcon } from "../components/icons";
import { itemKey, linksOf, liveTitle, searchItems } from "../lib/items";
import { openItem } from "../router";
import { usePlanner } from "../store";

function TypeIcon({ type }: { type: ItemRef["type"] }) {
  return (
    <span className="type-icon" title={type === "note" ? "Note" : "Task"}>
      {type === "note" ? <NoteIcon /> : <TaskIcon />}
    </span>
  );
}

function LinkPicker({ item, exclude, onDone }: { item: ItemRef; exclude: ReadonlySet<string>; onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = usePlanner((s) => s.notes);
  const tasks = usePlanner((s) => s.tasks);
  const results = useMemo(() => searchItems(query, { notes, tasks }, exclude, 12), [query, notes, tasks, exclude]);
  return (
    <div className="link-picker">
      <input
        className="input"
        type="search"
        autoFocus
        value={query}
        placeholder="Search notes and tasks"
        aria-label="Search notes and tasks to link"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      />
      {results.length === 0 ? (
        <p className="muted small">No matching notes or tasks.</p>
      ) : (
        <ul className="picker-results">
          {results.map((match) => (
            <li key={itemKey(match.ref)}>
              <button
                type="button"
                className="picker-result"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const link = await linkItems(item, match.ref);
                  setBusy(false);
                  if (link) onDone();
                }}
              >
                <TypeIcon type={match.ref.type} />
                <span>{match.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="button button--quiet" onClick={onDone}>
        Cancel
      </button>
    </div>
  );
}

export function LinksSection({
  item,
  disabled,
  titles,
}: {
  item: ItemRef;
  disabled: boolean;
  titles: Readonly<Record<string, string>> | undefined;
}) {
  const links = usePlanner((s) => s.links);
  const notes = usePlanner((s) => s.notes);
  const tasks = usePlanner((s) => s.tasks);
  const [picking, setPicking] = useState(false);
  const linked = useMemo(() => linksOf(item, links.values()), [links, item]);
  const exclude = useMemo(() => new Set([itemKey(item), ...linked.map((l) => itemKey(l.other))]), [item, linked]);

  return (
    <section className="panel-section" aria-labelledby="links-heading">
      <h3 id="links-heading">Linked items</h3>
      {linked.length === 0 && <p className="muted small">Nothing linked yet.</p>}
      {linked.length > 0 && (
        <ul className="linked-list">
          {linked.map(({ link, other }) => {
            const title = liveTitle(other, { notes, tasks });
            return (
              <li key={link.id}>
                <TypeIcon type={other.type} />
                {title !== null ? (
                  <button type="button" className="link-button" onClick={() => openItem(other)}>
                    {title}
                  </button>
                ) : (
                  <span className="muted">{titles?.[itemKey(other)] ?? "Archived item"} (archived)</span>
                )}
                {!disabled && (
                  <button type="button" className="button button--small button--quiet" onClick={() => void unlink(link.id)}>
                    Unlink
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!disabled &&
        (picking ? (
          <LinkPicker item={item} exclude={exclude} onDone={() => setPicking(false)} />
        ) : (
          <button type="button" className="button" onClick={() => setPicking(true)}>
            Link to…
          </button>
        ))}
    </section>
  );
}
