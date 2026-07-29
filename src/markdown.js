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

// YAML frontmatter: a --- fenced block at the very top of the file, used by
// Hugo, Astro, Jekyll and Obsidian. Only the shallow key/value shape is read,
// which is what a summary needs; the block itself is never rewritten, so
// anything deeper still round-trips untouched.
export function parseFrontmatter(doc) {
  if (!/^---[ \t]*(\r?\n|$)/.test(doc)) return null;

  const lines = doc.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*\r?$|^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return null; // unterminated: treat as ordinary text

  const body = lines.slice(1, end);
  const entries = [];
  for (const raw of body) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // nested value, belongs to the key above
    const m = /^([^:]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    entries.push({ key: m[1].trim(), value });
  }

  // Character offset of the closing fence's line end, so a caller can decorate
  // exactly the block and nothing after it.
  const to = lines.slice(0, end + 1).join("\n").length;
  return { from: 0, to, entries };
}

// TeX spans. Inline is $...$, display is $$...$$. A lone dollar amount like
// "$5" must not open one, so the opening delimiter may not be followed by a
// space or a digit, and the content may not end in a space. Expressed with a
// trailing character class rather than a lookbehind, which macOS 11's WebKit
// does not support — a lookbehind here would fail to parse and take the whole
// editor down on the oldest supported system.
const MATH_INLINE = /(^|[^\\$])\$(?![\s\d])((?:[^$\\\n]|\\.)*?[^\s$\\])\$(?!\d)/;

export function findInlineMath(text) {
  const out = [];
  let offset = 0;
  let rest = text;
  // Written as a loop over a non-global regex so the lookbehind-free variant
  // below can replace it if an old WebKit ever needs it.
  for (;;) {
    const m = MATH_INLINE.exec(rest);
    if (!m) break;
    const lead = m[1].length;
    const start = offset + m.index + lead;
    const end = start + (m[0].length - lead);
    out.push({ from: start, to: end, tex: m[2] });
    offset = end;
    rest = text.slice(offset);
  }
  return out;
}

// A display block is $$ alone on a line, TeX, then $$ alone on a line.
export function findDisplayMath(doc) {
  const out = [];
  const lines = doc.split("\n");
  let pos = 0;
  let openAt = null;
  let openLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "$$") {
      if (openAt === null) {
        openAt = pos;
        openLine = i;
      } else {
        const to = pos + lines[i].length;
        const tex = lines.slice(openLine + 1, i).join("\n");
        out.push({ from: openAt, to, tex });
        openAt = null;
      }
    }
    pos += lines[i].length + 1;
  }
  return out;
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
