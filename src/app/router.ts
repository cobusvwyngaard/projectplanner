// A tiny History API router: path routes (/board, /list, /activity,
// /settings) and the open item in the query string (?item=task:<id>), so the
// back button closes the item panel on a phone.

import { useSyncExternalStore, type MouseEvent } from "react";
import type { ItemRef } from "../shared/types";
import { itemKey } from "./lib/items";

export type Route = "board" | "list" | "inbox" | "activity" | "settings";

export const ROUTES: readonly { route: Route; path: string; label: string }[] = [
  { route: "board", path: "/board", label: "Board" },
  { route: "list", path: "/list", label: "List" },
  { route: "inbox", path: "/inbox", label: "Inbox" },
  { route: "activity", path: "/activity", label: "Activity" },
  { route: "settings", path: "/settings", label: "Settings" },
];

export function routeOf(path: string): Route | null {
  return ROUTES.find((r) => r.path === path.replace(/\/+$/, ""))?.route ?? null;
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("popstate", emit);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("popstate", emit);
  };
}

const currentUrl = () => window.location.pathname + window.location.search;

/** The current path and query string; re-renders on navigation. */
export function useLocation(): { path: string; search: URLSearchParams } {
  const url = useSyncExternalStore(subscribe, currentUrl);
  const parsed = new URL(url, "http://local");
  return { path: parsed.pathname, search: parsed.searchParams };
}

interface PanelState {
  panel: true;
}

function isPanelState(state: unknown): state is PanelState {
  return typeof state === "object" && state !== null && (state as { panel?: unknown }).panel === true;
}

export function navigate(to: string, options: { replace?: boolean; state?: unknown } = {}): void {
  if (to === currentUrl()) return;
  if (options.replace) window.history.replaceState(options.state ?? null, "", to);
  else window.history.pushState(options.state ?? null, "", to);
  emit();
}

function withItem(item: string | null): string {
  const params = new URLSearchParams(window.location.search);
  if (item === null) params.delete("item");
  else params.set("item", item);
  const query = params.toString();
  return window.location.pathname + (query ? `?${query}` : "");
}

/** The current page with the item panel open on this item, for links. */
export function itemHref(ref: ItemRef): string {
  return withItem(itemKey(ref));
}

/** Plain clicks on a link navigate inside the app; modified clicks (new tab) are left to the browser. */
export function followLink(e: MouseEvent<HTMLAnchorElement>, go: () => void): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

/** Open the item panel. Switching between items replaces the history entry. */
export function openItem(ref: ItemRef): void {
  const open = new URLSearchParams(window.location.search).has("item");
  navigate(withItem(itemKey(ref)), { replace: open && isPanelState(window.history.state), state: { panel: true } });
}

/** Close the item panel: back to where it was opened from, if the app opened it. */
export function closeItem(): void {
  if (isPanelState(window.history.state)) window.history.back();
  else navigate(withItem(null), { replace: true });
}

/** Go to a route, closing any open item. */
export function goTo(route: Route): void {
  const path = ROUTES.find((r) => r.route === route)?.path ?? "/";
  navigate(path);
}
