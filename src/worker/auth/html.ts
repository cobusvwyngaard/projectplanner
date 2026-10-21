// The small server-rendered pages (login, consent, errors) share this shell:
// inline styles only, no scripts, no external resources, light and dark.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for use in HTML content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f4f2ec; --card: #ffffff; --text: #1d2025; --muted: #5a606a; --border: #dcd8cd;
  --field: #fbfaf7; --accent: #2b6b5a; --accent-hover: #235a4b; --accent-text: #ffffff;
  --note: #f6d36b; --note-edge: #e0b93f; --focus: rgba(43, 107, 90, 0.35);
  --error-bg: #fbe9e6; --error-text: #8a2216; --warn-bg: #fff4d6; --warn-text: #6b4b00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141619; --card: #1d2024; --text: #e9e7e2; --muted: #a3a9b1; --border: #33373d;
    --field: #16191c; --accent: #6cc4a9; --accent-hover: #86d2ba; --accent-text: #0d1b16;
    --note: #d8b44c; --note-edge: #b8952f; --focus: rgba(108, 196, 169, 0.4);
    --error-bg: #3b1e1a; --error-text: #f5b8ae; --warn-bg: #3a3017; --warn-text: #f1d58a;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  min-height: 100vh; min-height: 100dvh; display: grid; place-items: center;
  padding: 24px 16px; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}
main {
  width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--border);
  border-radius: 18px; padding: 32px 24px 28px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 32px rgba(0, 0, 0, 0.07);
}
.mark {
  width: 40px; height: 40px; margin-bottom: 16px; border-radius: 6px 6px 14px 6px;
  background: var(--note); box-shadow: inset 0 -6px 0 var(--note-edge); transform: rotate(-4deg);
}
h1 { font-size: 1.35rem; line-height: 1.3; margin: 0 0 6px; }
p { margin: 0 0 16px; }
.muted { color: var(--muted); }
.small { font-size: 0.875rem; }
label { display: block; font-weight: 600; margin: 8px 0 6px; }
input[type="password"] {
  width: 100%; font: inherit; font-size: 1rem; padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--field); color: var(--text);
}
input[type="password"]:focus { outline: 3px solid var(--focus); outline-offset: 1px; border-color: var(--accent); }
button {
  width: 100%; margin-top: 16px; padding: 12px 16px; border: 1px solid transparent; border-radius: 10px;
  font: inherit; font-weight: 600; background: var(--accent); color: var(--accent-text); cursor: pointer;
}
button:hover { background: var(--accent-hover); }
button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
button.secondary { background: transparent; color: var(--text); border-color: var(--border); }
button.secondary:hover { background: var(--field); }
.actions { display: flex; gap: 12px; flex-wrap: wrap-reverse; }
.actions button { flex: 1 1 140px; }
.notice { border-radius: 10px; padding: 10px 12px; margin: 0 0 16px; }
.error { background: var(--error-bg); color: var(--error-text); }
.warning { background: var(--warn-bg); color: var(--warn-text); }
strong { overflow-wrap: anywhere; }
`;

/** A complete page. `body` must already be escaped HTML. */
export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en-ZA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="mark" aria-hidden="true"></div>
${body}
</main>
</body>
</html>
`;
}

/** A page with a heading and one paragraph, for errors. */
export function renderMessagePage(title: string, message: string): string {
  return renderPage(title, `<h1>${escapeHtml(title)}</h1>\n<p class="muted">${escapeHtml(message)}</p>`);
}
