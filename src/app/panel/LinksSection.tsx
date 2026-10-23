// The item panel's links: a task's dependencies grouped into waits for /
// needed for / related, plain links for a note, and a "Link to…" search picker.

import { useMemo, useState } from "react";
import type { ItemRef, Link } from "../../shared/types";
import { createDependency, linkItems, makeDependency, makeRelated, reverseDependency, unlink } from "../actions";
import { NoteIcon, TaskIcon } from "../components/icons";
import { itemKey, linksOf, liveTitle, searchItems } from "../lib/items";
import { taskDependencies } from "../lib/dependencies";
import { openItem } from "../router";
import { usePlanner } from "../store";

function TypeIcon({ type }: { type: ItemRef["type"] }) {
  return (
    <span className="type-icon" title={type === "note" ? "Note" : "Task"}>
      {type === "note" ? <NoteIcon /> : <TaskIcon />}
    </span>
  );
}

/** The item's title, or its last known name when it has been archived. */
function LinkTarget({ other, title, fallback }: { other: ItemRef; title: string | null; fallback: string | undefined }) {
  return (
    <>
      <TypeIcon type={other.type} />
      {title !== null ? (
        <button type="button" className="link-button" onClick={() => openItem(other)}>
          {title}
        </button>
      ) : (
        <span className="muted">{fallback ?? "Archived item"} (archived)</span>
      )}
    </>
  );
}

function LinkPicker({ item, exclude, onDone }: { item: ItemRef; exclude: ReadonlySet<string>; onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = usePlanner((s) => s.notes);
  const tasks = usePlanner((s) => s.tasks);
  const results = useMemo(() => searchItems(query, { notes, tasks }, exclude, 12), [query, notes, tasks, exclude]);
  const canDepend = item.type === "task";
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
            <li key={itemKey(match.ref)} className={canDepend && match.ref.type === "task" ? "picker-choice" : undefined}>
              {canDepend && match.ref.type === "task" ? (
                <>
                  <div className="picker-choice-head">
                    <TypeIcon type={match.ref.type} />
                    <span>{match.title}</span>
                  </div>
                  <div className="picker-choice-actions">
                    <button
                      type="button"
                      className="button button--small"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const link = await createDependency(match.ref, item);
                        setBusy(false);
                        if (link) onDone();
                      }}
                    >
                      This task waits for it
                    </button>
                    <button
                      type="button"
                      className="button button--small"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const link = await createDependency(item, match.ref);
                        setBusy(false);
                        if (link) onDone();
                      }}
                    >
                      It waits for this task
                    </button>
                    <button
                      type="button"
                      className="button button--small"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const link = await linkItems(item, match.ref);
                        setBusy(false);
                        if (link) onDone();
                      }}
                    >
                      Related
                    </button>
                  </div>
                </>
              ) : (
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
              )}
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

/** A dependency's action buttons: reverse it, make it related, or remove it. */
function DependencyActions({ link, before, after }: { link: Link; before: ItemRef; after: ItemRef }) {
  return (
    <span className="link-actions">
      <button type="button" className="button button--small button--quiet" onClick={() => void reverseDependency(link.id, before, after)}>
        Reverse
      </button>
      <button type="button" className="button button--small button--quiet" onClick={() => void makeRelated(link.id)}>
        Make related
      </button>
      <button type="button" className="button button--small button--quiet" onClick={() => void unlink(link.id)}>
        Remove
      </button>
    </span>
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
  const deps = useMemo(() => taskDependencies(item, links.values()), [item, links]);
  const isTask = item.type === "task";
  const hasDependencies = isTask && (deps.waitsFor.length > 0 || deps.neededFor.length > 0);

  const target = (other: ItemRef) => (
    <LinkTarget other={other} title={liveTitle(other, { notes, tasks })} fallback={titles?.[itemKey(other)]} />
  );

  return (
    <section className="panel-section" aria-labelledby="links-heading">
      <h3 id="links-heading">Linked items</h3>
      {linked.length === 0 && <p className="muted small">Nothing linked yet.</p>}
      {deps.waitsFor.length > 0 && (
        <>
          <h4 className="panel-subheading">Waits for</h4>
          <ul className="linked-list">
            {deps.waitsFor.map(({ link, other }) => (
              <li key={link.id}>
                {target(other)}
                {!disabled && <DependencyActions link={link} before={{ type: "task", id: item.id }} after={other} />}
              </li>
            ))}
          </ul>
        </>
      )}
      {deps.neededFor.length > 0 && (
        <>
          <h4 className="panel-subheading">Needed for</h4>
          <ul className="linked-list">
            {deps.neededFor.map(({ link, other }) => (
              <li key={link.id}>
                {target(other)}
                {!disabled && <DependencyActions link={link} before={other} after={{ type: "task", id: item.id }} />}
              </li>
            ))}
          </ul>
        </>
      )}
      {deps.related.length > 0 && (
        <>
          {hasDependencies && <h4 className="panel-subheading">Related</h4>}
          <ul className="linked-list">
            {deps.related.map(({ link, other }) => (
              <li key={link.id}>
                {target(other)}
                {!disabled && (
                  <span className="link-actions">
                    {other.type === "task" && (
                      <button
                        type="button"
                        className="button button--small button--quiet"
                        onClick={() => void makeDependency(link.id, { type: "task", id: item.id }, other)}
                      >
                        Make dependency
                      </button>
                    )}
                    <button type="button" className="button button--small button--quiet" onClick={() => void unlink(link.id)}>
                      {other.type === "task" ? "Remove" : "Unlink"}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
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
