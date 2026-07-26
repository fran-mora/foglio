// Pure markdown helpers, kept apart from the editor so they can be tested
// without a DOM or a Tauri runtime. Nothing here touches the document.

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Schemes a link in a document is allowed to point at. A `javascript:` href
// would run in the editor's own webview, which can reach the Tauri commands
// that read and write files, so anything unrecognised loses its link.
const ALLOWED_SCHEMES = ["http", "https", "mailto"];

export function safeLinkTarget(url) {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!scheme) return trimmed; // relative path or anchor
  return ALLOWED_SCHEMES.includes(scheme[1].toLowerCase()) ? trimmed : null;
}

// Emphasis must not open or close against whitespace, so "2 * 3 * 4" stays as
// arithmetic. Underscores additionally may not sit inside a word, so
// identifiers like range_m and area_km2 survive a table cell intact.
// Written without lookbehind, which macOS 11's WebKit lacks.
const EM_STAR = /(^|[^*])\*([^\s*][^*\n]*[^\s*]|[^\s*])\*/g;
const EM_UNDERSCORE =
  /(^|[^_A-Za-z0-9])_([^\s_][^_\n]*[^\s_]|[^\s_])_(?![A-Za-z0-9])/g;

// Inline markdown (bold/italic/strike/code/links) for table cells, which are
// injected as HTML. Escaping runs first and is the only thing standing between
// a document and script execution, so it must stay ahead of the replacements.
export function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_full, label, url) => {
      const href = safeLinkTarget(url);
      return href === null ? label : `<a href="${href}">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(EM_STAR, "$1<em>$2</em>")
    .replace(EM_UNDERSCORE, "$1<em>$2</em>");
}

function splitRow(line) {
  let s = line;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

export function isDelimiterRow(line) {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim());
}

// Markdown tables are line-oriented, so they are parsed by line rather than by
// walking the syntax tree. Returns null when there is no header to render.
export function parseTable(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let header = null;
  let aligns = [];
  const rows = [];

  for (const line of lines) {
    if (isDelimiterRow(line)) {
      aligns = splitRow(line).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      });
      continue;
    }
    if (header === null) header = splitRow(line);
    else rows.push(splitRow(line));
  }

  return header ? { header, aligns, rows } : null;
}

const IMAGE_RE = /^!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)$/;

export function parseImage(raw) {
  const m = IMAGE_RE.exec(raw);
  return m ? { alt: m[1], url: m[2] } : null;
}

// Works out what an image target points at. Remote and data URLs pass straight
// through; a local path is resolved against the directory of the open document
// so `![](logo.png)` finds the file sitting next to it.
export function resolveImagePath(rawUrl, docPath) {
  if (/^(https?:|data:)/i.test(rawUrl)) return { remote: true, src: rawUrl };

  let p = rawUrl;
  try {
    p = decodeURI(p);
  } catch {
    // A malformed percent-escape is left alone rather than dropped.
  }

  if (!p.startsWith("/") && docPath) {
    const dir = docPath.slice(0, docPath.lastIndexOf("/"));
    p = `${dir}/${p}`;
  }
  return { remote: false, src: p };
}
