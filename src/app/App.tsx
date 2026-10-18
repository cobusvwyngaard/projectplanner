// The app shell: header with the navigation (a bottom tab bar on phones), the
// current view, the item panel over it and the toasts.

import { Suspense, lazy, useEffect, useState, type JSX } from "react";
import { ActivityView } from "./activity/ActivityView";
import { ActivityIcon, BoardIcon, InboxIcon, ListIcon, SettingsIcon } from "./components/icons";
import { CaptureSheet } from "./capture/CaptureSheet";
import { InboxView } from "./inbox/InboxView";
import { useIsPhone } from "./hooks";
import { ListView } from "./list/ListView";
import { ItemPanel } from "./panel/ItemPanel";
import { ROUTES, followLink, goTo, navigate, routeOf, useLocation, type Route } from "./router";
import { SettingsView } from "./settings/SettingsView";
import { api } from "./api";
import { store, useLoadStatus, usePlanner, useSyncTrouble } from "./store";
import { Toasts } from "./toast";

// React Flow is the largest part of the app; phones open the list first.
const BoardView = lazy(() => import("./board/BoardView"));

const ICONS: Record<Route, () => JSX.Element> = {
  board: BoardIcon,
  list: ListIcon,
  inbox: InboxIcon,
  activity: ActivityIcon,
  settings: SettingsIcon,
};

export function App() {
  const status = useLoadStatus();
  if (status.phase === "ready") return <Shell />;
  if (status.phase === "error") return <LoadError message={status.message} />;
  return <Splash text="Loading the planner…" />;
}

function Splash({ text }: { text: string }) {
  return (
    <div className="splash" role="status">
      <span className="brand-mark brand-mark--large" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function LoadError({ message }: { message: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="splash" role="alert">
      <span className="brand-mark brand-mark--large" aria-hidden="true" />
      <h1>The planner could not load</h1>
      <p className="muted">{message}</p>
      <button
        type="button"
        className="button button--primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void store.start().finally(() => setBusy(false));
        }}
      >
        {busy ? "Trying again…" : "Try again"}
      </button>
    </div>
  );
}

function Shell() {
  const { path, search } = useLocation();
  const phone = useIsPhone();
  const trouble = useSyncTrouble();
  const route: Route | null = path === "/" ? (phone ? "list" : "board") : routeOf(path);
  const item = search.get("item");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAutoStart, setCaptureAutoStart] = useState(false);
  const openCapture = (autoStart: boolean) => {
    setCaptureAutoStart(autoStart);
    setCaptureOpen(true);
  };
  useEffect(() => {
    void api.captures({ status: "new", limit: 100 }).then((res) => {
      for (const c of res.captures) store.putCapture(c);
    }).catch(() => undefined);
  }, []);

  // "/" opens the board on wide screens and the list on phones.
  useEffect(() => {
    if (path === "/") navigate((phone ? "/list" : "/board") + window.location.search, { replace: true });
  }, [path, phone]);

  const routeLabel = ROUTES.find((r) => r.route === route)?.label;
  useEffect(() => {
    document.title = routeLabel ? `${routeLabel} · Planner` : "Planner";
  }, [routeLabel]);

  return (
    <div className={`app app--${route ?? "missing"}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <a className="brand" href="/" onClick={(e) => followLink(e, () => goTo(phone ? "list" : "board"))}>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Shared Planner</span>
        </a>
        {!phone && <NavLinks current={route} className="top-nav" />}
        {!phone && (
          <button type="button" className="button button--primary button--small" onClick={() => openCapture(true)}>
            Record
          </button>
        )}
        <Me />
      </header>
      {trouble && (
        <p className="sync-banner" role="status">
          Cannot reach the planner right now. Retrying; your changes show once it is back.
        </p>
      )}
      <main className="app-main" id="main" tabIndex={-1}>
        <View route={route} />
      </main>
      {phone && (
        <div className="tab-bar-wrap">
          <NavLinks current={route} className="tab-bar" />
          <button
            type="button"
            className="record-button record-button--bar"
            onClick={() => openCapture(true)}
            aria-label="Record"
          >
            <span className="record-dot" aria-hidden="true" />
            <span>Record</span>
          </button>
        </div>
      )}
      {item !== null && <ItemPanel key={item} itemKey={item} />}
      {captureOpen && <CaptureSheet autoStart={captureAutoStart} onClose={() => setCaptureOpen(false)} />}
      <Toasts />
    </div>
  );
}

function View({ route }: { route: Route | null }) {
  switch (route) {
    case "board":
      return (
        <Suspense fallback={<p className="view-loading">Loading the board…</p>}>
          <BoardView />
        </Suspense>
      );
    case "list":
      return <ListView />;
    case "inbox":
      return <InboxView />;
    case "activity":
      return <ActivityView />;
    case "settings":
      return <SettingsView />;
    case null:
      return (
        <div className="page">
          <h1>Not found</h1>
          <p className="muted">There is nothing at this address.</p>
          <button type="button" className="button" onClick={() => goTo("list")}>
            Go to the list
          </button>
        </div>
      );
  }
}

function NavLinks({ current, className }: { current: Route | null; className: string }) {
  const newCaptures = usePlanner((s) => [...s.captures.values()].filter((c) => c.inbox_status === "new").length);
  return (
    <nav className={className} aria-label="Main">
      {ROUTES.map(({ route, path, label }) => {
        const Icon = ICONS[route];
        return (
          <a
            key={route}
            href={path}
            className="nav-link"
            aria-current={current === route ? "page" : undefined}
            onClick={(e) => followLink(e, () => goTo(route))}
          >
            <Icon />
            <span>{label}</span>
            {route === "inbox" && newCaptures > 0 && <span className="badge badge--count">{newCaptures}</span>}
          </a>
        );
      })}
    </nav>
  );
}

function Me() {
  const me = usePlanner((s) => s.me);
  return (
    <span className="me initials" title={`Signed in as ${me.display_name}`} aria-label={`Signed in as ${me.display_name}`}>
      {me.initials}
    </span>
  );
}
