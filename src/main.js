import { EditorState, StateField, StateEffect } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  Decoration,
  WidgetType,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
  selectAll,
} from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Table, TaskList, Strikethrough, Autolink } from "@lezer/markdown";
import { marked } from "marked";
import {
  escapeHtml,
  renderInline,
  parseTable,
  parseImage,
  resolveImagePath,
} from "./markdown.js";

marked.setOptions({ gfm: true, breaks: false });

const initialDoc = `# Welcome

This is a **live-preview** markdown editor. Type and watch it render.

## Features

- *italic*, **bold**, ~~strike~~, \`inline code\`
- [links](https://example.com)
- Lists, quotes, code blocks

> Block quotes look like this.

\`\`\`js
console.log("hello");
\`\`\`

---

Open a \`.md\` file from Finder, or save changes with ⌘S.
`;

// Renders a markdown table block as a real HTML <table>.
// Uses simple line-level parsing rather than walking lezer cell nodes —
// tables in markdown are line-oriented and this keeps it readable.
class TableWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other.text === this.text;
  }
  toDOM() {
    const root = document.createElement("div");
    root.className = "md-table-rendered";

    const parsed = parseTable(this.text);
    if (!parsed) {
      root.textContent = this.text;
      return root;
    }
    const { header, aligns, rows } = parsed;

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    header.forEach((cell, i) => {
      const th = document.createElement("th");
      th.innerHTML = renderInline(cell);
      if (aligns[i]) th.style.textAlign = aligns[i];
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      row.forEach((cell, i) => {
        const td = document.createElement("td");
        td.innerHTML = renderInline(cell);
        if (aligns[i]) td.style.textAlign = aligns[i];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    root.appendChild(table);
    return root;
  }
  ignoreEvent() {
    return false;
  }
}

// Task-list checkbox shown in place of "[ ]" / "[x]" when the cursor is
// elsewhere. Clicks are handled by taskClickHandler below (widgets don't
// reliably know their own doc position).
class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "md-task-checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "completed task" : "open task");
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "md-bullet";
    span.textContent = "•";
    return span;
  }
}

// Resolve a markdown image target to something the webview can load.
// Remote and data URLs pass through; local paths (absolute or relative to the
// open document) go through Tauri's asset protocol.
function resolveImageSrc(rawUrl) {
  const { remote, src } = resolveImagePath(rawUrl, currentPath);
  if (remote || !isTauri) return src;
  try {
    return convertFileSrc(src);
  } catch {
    return src;
  }
}

class ImageWidget extends WidgetType {
  constructor(alt, url, standalone) {
    super();
    this.alt = alt;
    this.url = url;
    this.standalone = standalone;
  }
  eq(other) {
    return (
      other.alt === this.alt &&
      other.url === this.url &&
      other.standalone === this.standalone
    );
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = this.standalone ? "md-image" : "md-image md-image-inline";
    const img = document.createElement("img");
    img.alt = this.alt;
    img.src = resolveImageSrc(this.url);
    // A missing or unreadable file shouldn't leave a blank gap — say so.
    img.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "md-image-missing";
      fallback.textContent = `⚠ ${this.alt || "image"} — ${this.url}`;
      wrap.replaceChildren(fallback);
    });
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

const dragTracker = EditorView.domEventHandlers({
  mousedown(_event, view) {
    if (!view.state.field(draggingField, false)) {
      view.dispatch({ effects: setDragging.of(true) });
    }
    return false;
  },
});

const taskClickHandler = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.classList.contains("md-task-checkbox")) {
      return false;
    }
    const pos = view.posAtDOM(t);
    const marker = view.state.doc.sliceString(pos, pos + 3);
    if (!/^\[[ xX]\]$/.test(marker)) return false;
    const checked = marker[1] !== " ";
    view.dispatch({
      changes: { from: pos, to: pos + 3, insert: checked ? "[ ]" : "[x]" },
    });
    e.preventDefault();
    return true;
  },
});

// True from mousedown until the button comes back up. Revealing markers mid-drag
// would reflow the line under the pointer, so the reveal waits for the release.
const setDragging = StateEffect.define();

const draggingField = StateField.define({
  create() {
    return false;
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDragging)) return e.value;
    return value;
  },
});

// Build live-preview decorations (inline + block) from the syntax tree.
// Lives in a StateField because block decorations cannot come from a ViewPlugin.
function buildDecorations(state) {
  const builder = [];
  // Hidden markers ("> ", "# ", "**", a link's URL) come back only when the
  // caret is resting on a line. While the mouse is down or a selection is
  // open they stay hidden: revealing them re-flows the line, which moves the
  // text out from under the pointer and makes selecting by hand a fight.
  const sel = state.selection.main;
  const reveal = sel.empty && !state.field(draggingField, false);
  const cursorLine = reveal ? state.doc.lineAt(sel.head).number : -1;

  const tagLines = (from, to, cls) => {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      builder.push(Decoration.line({ class: cls }).range(line.from));
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  };

  syntaxTree(state).iterate({
    enter: (node) => {
      const name = node.name;

      if (name.startsWith("ATXHeading")) {
        const level = parseInt(name.slice("ATXHeading".length), 10);
        const line = state.doc.lineAt(node.from);
        builder.push(
          Decoration.line({ class: `md-h${level}` }).range(line.from)
        );
      } else if (name === "Blockquote") {
        tagLines(node.from, node.to, "md-quote");
      } else if (name === "FencedCode" || name === "CodeBlock") {
        tagLines(node.from, node.to, "md-code");
      } else if (name === "HorizontalRule") {
        const line = state.doc.lineAt(node.from);
        builder.push(Decoration.line({ class: "md-hr" }).range(line.from));
      } else if (name === "Table") {
        const startLine = state.doc.lineAt(node.from);
        const endLine = state.doc.lineAt(node.to);
        const cursorInside =
          cursorLine >= startLine.number && cursorLine <= endLine.number;
        if (cursorInside) {
          tagLines(node.from, node.to, "md-table");
        } else {
          const text = state.doc.sliceString(startLine.from, endLine.to);
          builder.push(
            Decoration.replace({
              widget: new TableWidget(text),
              block: true,
            }).range(startLine.from, endLine.to)
          );
        }
        return false;
      } else if (name === "TableHeader") {
        const line = state.doc.lineAt(node.from);
        builder.push(
          Decoration.line({ class: "md-table-header" }).range(line.from)
        );
      } else if (name === "Image") {
        const line = state.doc.lineAt(node.from);
        if (line.number === cursorLine) return false;
        const raw = state.doc.sliceString(node.from, node.to);
        const img = parseImage(raw);
        if (!img) return false;
        // An image alone on its line gets full width; one sitting inside a
        // sentence is capped to line height so the text still reads.
        const before = line.text.slice(0, node.from - line.from);
        const after = line.text.slice(node.to - line.from);
        const standalone = (before + after).trim().length === 0;
        builder.push(
          Decoration.replace({
            widget: new ImageWidget(img.alt, img.url, standalone),
          }).range(node.from, node.to)
        );
        return false;
      } else if (name === "StrongEmphasis") {
        builder.push(
          Decoration.mark({ class: "tok-strong" }).range(node.from, node.to)
        );
      } else if (name === "Emphasis") {
        builder.push(
          Decoration.mark({ class: "tok-em" }).range(node.from, node.to)
        );
      } else if (name === "Strikethrough") {
        builder.push(
          Decoration.mark({ class: "tok-strike" }).range(node.from, node.to)
        );
      } else if (name === "InlineCode") {
        builder.push(
          Decoration.mark({ class: "tok-code" }).range(node.from, node.to)
        );
      } else if (name === "TaskMarker") {
        const line = state.doc.lineAt(node.from);
        if (line.number === cursorLine) {
          builder.push(
            Decoration.mark({ class: "tok-marker" }).range(node.from, node.to)
          );
        } else {
          const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
          builder.push(
            Decoration.replace({ widget: new CheckboxWidget(checked) }).range(
              node.from,
              node.to
            )
          );
        }
      } else if (name === "ListMark") {
        const mark = state.doc.sliceString(node.from, node.to);
        if (/^[-*+]$/.test(mark)) {
          const line = state.doc.lineAt(node.from);
          if (line.number === cursorLine) {
            builder.push(
              Decoration.mark({ class: "tok-marker" }).range(node.from, node.to)
            );
          } else if (node.node.nextSibling?.name === "Task") {
            // Task items get a checkbox; the dash would just be noise.
            builder.push(Decoration.replace({}).range(node.from, node.to));
          } else {
            builder.push(
              Decoration.replace({ widget: new BulletWidget() }).range(
                node.from,
                node.to
              )
            );
          }
        }
      } else if (name === "Link") {
        builder.push(
          Decoration.mark({ class: "tok-link" }).range(node.from, node.to)
        );
      } else if (name === "URL") {
        const line = state.doc.lineAt(node.from);
        if (line.number === cursorLine) {
          builder.push(
            Decoration.mark({ class: "tok-marker" }).range(node.from, node.to)
          );
        } else if (node.from < node.to) {
          builder.push(Decoration.replace({}).range(node.from, node.to));
        }
      } else if (
        name === "HeaderMark" ||
        name === "EmphasisMark" ||
        name === "CodeMark" ||
        name === "CodeInfo" ||
        name === "StrikethroughMark" ||
        name === "QuoteMark" ||
        name === "LinkMark"
      ) {
        const line = state.doc.lineAt(node.from);
        if (line.number === cursorLine) {
          builder.push(
            Decoration.mark({ class: "tok-marker" }).range(node.from, node.to)
          );
        } else if (node.from < node.to) {
          builder.push(Decoration.replace({}).range(node.from, node.to));
        }
      }
    },
  });

  builder.sort((a, b) => a.from - b.from || a.startSide - b.startSide);
  return Decoration.set(builder, true);
}

const livePreview = StateField.define({
  create(state) {
    return buildDecorations(state);
  },
  update(_value, tr) {
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// File I/O — Tauri APIs at runtime; no-op fallbacks during plain-vite dev.
let currentPath = null;
// Last content we know is on disk for the open file. Updated after read and
// after our own writes. Used to detect external modifications: if the editor
// content matches this, a reload is safe; otherwise we prompt.
let lastDiskContent = "";

// Tauri 2 exposes `window.__TAURI_INTERNALS__` (was `__TAURI__` in v1).
const isTauri = "__TAURI_INTERNALS__" in window;

// Content an untitled window started with — an untitled window is dirty
// only once its doc diverges from this.
let baseContent = isTauri ? "" : initialDoc;
let lastReportedDirty = false;
let winLabel = "main";
let appWindow = null;

async function rpc(cmd, args) {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

async function tauriWindow() {
  if (!isTauri) return null;
  if (!appWindow) {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    appWindow = getCurrentWebviewWindow();
  }
  return appWindow;
}

async function readFile(path) {
  if (!isTauri) return "";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("read_text_file", { path });
}

async function writeFile(path, contents) {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("write_text_file", { path, content: contents });
}

async function pickOpen() {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }],
  });
}

async function pickSave() {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    filters: [{ name: "Markdown", extensions: ["md"] }],
    defaultPath: "untitled.md",
  });
}

function fileName() {
  return currentPath ? currentPath.split("/").pop() : "untitled.md";
}

// --- editor zoom -------------------------------------------------------------
// Drives --editor-font-size; persisted so a window opens at the size you left.

const ZOOM_KEY = "foglio:font-size";
const BASE_FONT_SIZE = 17;
let fontSize = Number(localStorage.getItem(ZOOM_KEY)) || BASE_FONT_SIZE;

function applyFontSize() {
  document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);
  try {
    localStorage.setItem(ZOOM_KEY, String(fontSize));
  } catch {
    // Private mode or a full quota — zoom just won't persist.
  }
}

function zoomBy(delta) {
  fontSize = Math.min(34, Math.max(11, fontSize + delta));
  applyFontSize();
}

function zoomReset() {
  fontSize = BASE_FONT_SIZE;
  applyFontSize();
}

applyFontSize();

function updateTitle() {
  const t = (lastReportedDirty ? "• " : "") + fileName();
  document.title = t;
  if (isTauri) {
    tauriWindow()
      .then((w) => w && w.setTitle(t))
      .catch((e) => jsLog(`setTitle failed: ${e}`));
  }
}

function isDirty() {
  const doc = view.state.doc.toString();
  return currentPath ? doc !== lastDiskContent : doc !== baseContent;
}

// Mirror dirty transitions to the window title and to the Rust registry
// (which drives the quit-with-unsaved-changes guard).
function reportDirty() {
  const d = isDirty();
  if (d === lastReportedDirty) return;
  lastReportedDirty = d;
  updateTitle();
  rpc("set_dirty", { dirty: d }).catch(() => {});
}

const state = EditorState.create({
  doc: isTauri ? "" : initialDoc,
  extensions: [
    EditorView.updateListener.of((u) => {
      if (u.docChanged) reportDirty();
    }),
    history(),
    // No drawSelection(): it paints the selection in a layer behind the text,
    // which the opaque background on code-block lines hides completely. The
    // browser's own selection draws with the text, so it stays visible.
    highlightActiveLine(),
    EditorView.lineWrapping,
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [Table, TaskList, Strikethrough, Autolink],
    }),
    syntaxHighlighting(classHighlighter),
    draggingField,
    dragTracker,
    taskClickHandler,
    livePreview,
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      {
        key: "Mod-s",
        run: () => {
          saveCurrent();
          return true;
        },
      },
      {
        key: "Mod-o",
        run: () => {
          openDialog();
          return true;
        },
      },
      {
        key: "Mod-n",
        run: () => {
          rpc("new_window");
          return true;
        },
      },
      {
        key: "Mod-Shift-s",
        run: () => {
          saveAs();
          return true;
        },
      },
      { key: "Mod-=", run: () => (zoomBy(1), true) },
      { key: "Mod-Shift-=", run: () => (zoomBy(1), true) },
      { key: "Mod--", run: () => (zoomBy(-1), true) },
      { key: "Mod-0", run: () => (zoomReset(), true) },
    ]),
  ],
});

const view = new EditorView({
  state,
  parent: document.getElementById("editor"),
});

view.focus();
updateTitle();

// The button often comes up outside the editor (or outside the window), so the
// release is tracked here rather than through a CodeMirror handler. Blur is a
// safety net: without it a drag that ends off-window would leave markers hidden.
function endDrag() {
  if (view.state.field(draggingField, false)) {
    view.dispatch({ effects: setDragging.of(false) });
  }
}
window.addEventListener("mouseup", endDrag);
window.addEventListener("blur", endDrag);

async function openPath(path) {
  if (!path) return;
  const text = await readFile(path);
  const oldPath = currentPath;
  currentPath = path;
  lastDiskContent = text;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
  reportDirty();
  updateTitle();
  if (isTauri) {
    rpc("register_path", { path }).catch(() => {});
    if (oldPath && oldPath !== path) {
      rpc("unwatch_file", { path: oldPath }).catch(() => {});
    }
    try {
      await rpc("watch_file", { path });
    } catch (e) {
      jsLog(`watch_file failed: ${e}`);
    }
  }
}

async function openDialog() {
  const path = await pickOpen();
  if (!path) return;
  // An empty untitled window takes the file itself. Otherwise hand off to
  // Rust, which focuses the window already showing it or opens a new one.
  if (!isTauri || (!currentPath && !isDirty())) {
    await openPath(path);
  } else {
    await rpc("deliver_path", { path });
  }
}

// Returns true if the document ended up on disk (false = user cancelled).
async function saveCurrent() {
  const text = view.state.doc.toString();
  let path = currentPath;
  const isNew = !path;
  if (!path) {
    path = await pickSave();
    if (!path) return false;
    currentPath = path;
  }
  await writeFile(path, text);
  lastDiskContent = text;
  reportDirty();
  updateTitle();
  if (isTauri && isNew) {
    rpc("register_path", { path }).catch(() => {});
    rpc("watch_file", { path }).catch((e) => jsLog(`watch_file failed: ${e}`));
  }
  return true;
}

// Save under a new name. The old file stays on disk; this window follows the
// new one (watcher included).
async function saveAs() {
  const path = await pickSave();
  if (!path) return false;
  const text = view.state.doc.toString();
  const oldPath = currentPath;
  await writeFile(path, text);
  currentPath = path;
  lastDiskContent = text;
  reportDirty();
  updateTitle();
  if (isTauri) {
    rpc("register_path", { path }).catch(() => {});
    if (oldPath && oldPath !== path) {
      rpc("unwatch_file", { path: oldPath }).catch(() => {});
    }
    rpc("watch_file", { path }).catch((e) => jsLog(`watch_file failed: ${e}`));
  }
  return true;
}

async function handleExternalChange(path) {
  if (!isTauri) return;
  if (path !== currentPath) return;
  let newContent;
  try {
    newContent = await readFile(path);
  } catch (e) {
    jsLog(`re-read after change failed: ${e}`);
    return;
  }
  const editorContent = view.state.doc.toString();
  // Our own save: editor and disk match. Just sync the marker.
  if (newContent === editorContent) {
    lastDiskContent = newContent;
    return;
  }
  // No local edits since last sync — reload silently.
  if (editorContent === lastDiskContent) {
    lastDiskContent = newContent;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newContent },
    });
    return;
  }
  // Conflict: ask.
  const { ask } = await import("@tauri-apps/plugin-dialog");
  const reload = await ask(
    "This file changed on disk. Discard your unsaved edits and reload?",
    { title: "File changed", kind: "warning", okLabel: "Reload", cancelLabel: "Keep mine" }
  );
  if (reload) {
    lastDiskContent = newContent;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newContent },
    });
    reportDirty();
  }
  // If the user keeps theirs, lastDiskContent stays pointing at the old
  // version — the next save will overwrite the on-disk file as they intend.
}

// Tauri: when the OS opens a file with this app (Finder double-click,
// "Open With"), the Rust side emits an "open-file" event with the path.
async function jsLog(msg) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("js_log", { msg });
  } catch {}
}

// Three-way close prompt: "save" | "discard" | "review".
// Enter = Save, Esc = Review (keep editing), ⌘D = Don't Save.
function confirmClose() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card" role="alertdialog">
        <div class="modal-title">Save changes to “${escapeHtml(fileName())}”?</div>
        <div class="modal-sub">Your changes will be lost if you don’t save them.</div>
        <div class="modal-buttons">
          <button class="modal-btn" data-act="discard">Don’t Save</button>
          <span class="modal-spacer"></span>
          <button class="modal-btn" data-act="review">Review</button>
          <button class="modal-btn modal-primary" data-act="save">Save</button>
        </div>
      </div>`;
    const done = (act) => {
      overlay.remove();
      view.focus();
      resolve(act);
    };
    overlay.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (b) done(b.dataset.act);
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done("review");
      } else if (e.key === "Enter") {
        e.preventDefault();
        done("save");
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        done("discard");
      }
    });
    document.body.appendChild(overlay);
    overlay.querySelector(".modal-primary").focus();
  });
}

const printStyles = `
  @page { margin: 18mm 16mm; }
  html, body { background: #fff; color: #111; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 12pt;
    line-height: 1.55;
    margin: 0;
    padding: 0;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.5em; }
  h1 { font-size: 2em; }
  h2 { font-size: 1.5em; }
  h3 { font-size: 1.2em; }
  p, ul, ol, blockquote, pre, table { margin: 0.6em 0; }
  ul, ol { padding-left: 1.6em; }
  blockquote {
    border-left: 3px solid #d4d0c8;
    color: #555;
    margin: 0.8em 0;
    padding: 0.1em 0 0.1em 0.9em;
    font-style: italic;
  }
  code {
    font-family: "SF Mono", ui-monospace, Menlo, monospace;
    background: #f3efe7;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.92em;
  }
  pre {
    font-family: "SF Mono", ui-monospace, Menlo, monospace;
    background: #f3efe7;
    padding: 10px 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.9em;
  }
  pre code { background: none; padding: 0; border-radius: 0; }
  a { color: #2a6dc6; }
  hr { border: 0; border-top: 1px solid #d4d0c8; margin: 1.4em 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d4d0c8; padding: 5px 10px; text-align: left; vertical-align: top; }
  th { background: #f3efe7; font-weight: 700; }
  img { max-width: 100%; }
  /* Avoid orphan headings */
  h1, h2, h3, h4 { break-after: avoid-page; }
  pre, blockquote, table { break-inside: avoid; }
`;

async function exportPdf() {
  jsLog("exportPdf: clicked");
  const md = view.state.doc.toString();
  let bodyHtml;
  try {
    bodyHtml = marked.parse(md);
  } catch (e) {
    jsLog(`marked.parse failed: ${e}`);
    return;
  }
  const baseName = currentPath
    ? currentPath.split("/").pop().replace(/\.[^.]+$/, "")
    : "untitled";

  const screenStyles = `
    body { padding: 32px 48px 64px; max-width: 820px; margin: 0 auto; }
    .print-hint {
      position: fixed; top: 14px; right: 16px;
      background: #2a6dc6; color: #fff;
      padding: 8px 14px; border-radius: 6px;
      font: 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      box-shadow: 0 6px 18px rgba(0,0,0,0.15);
      z-index: 1000;
    }
    @media print {
      body { padding: 0; max-width: none; margin: 0; }
      .print-hint { display: none; }
    }
  `;

  const docHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(baseName)}</title>
<style>${printStyles}${screenStyles}</style>
</head><body>
<div class="print-hint">Press ⌘P → Save as PDF</div>
${bodyHtml}</body></html>`;

  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke("export_html", { html: docHtml, name: baseName });
      jsLog(`export_html ok: ${path}`);
    } catch (e) {
      jsLog(`export_html failed: ${e}`);
    }
    return;
  }

  // Browser/vite dev fallback: hidden iframe + window.print().
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);

  await new Promise((resolve) => {
    iframe.addEventListener("load", resolve, { once: true });
    iframe.srcdoc = docHtml;
  });

  try {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  } catch (e) {
    jsLog(`print failed: ${e}`);
  }
  setTimeout(() => iframe.remove(), 1000);
}

const exportBtn = document.getElementById("export-pdf");
if (exportBtn) {
  exportBtn.addEventListener("click", () => {
    exportPdf();
  });
}

if (isTauri) {
  (async () => {
    jsLog(`startup: isTauri=${isTauri}`);
    const win = await tauriWindow();
    winLabel = win.label;
    await rpc("register_window");

    // Close guard: a dirty window vetoes the close until the user decides.
    // Tauri holds the actual close until this handler resolves.
    let closePromptOpen = false;
    await win.onCloseRequested(async (event) => {
      if (!isDirty()) return;
      if (closePromptOpen) {
        event.preventDefault();
        return;
      }
      closePromptOpen = true;
      const act = await confirmClose();
      closePromptOpen = false;
      if (act === "save") {
        let saved = false;
        try {
          saved = await saveCurrent();
        } catch (e) {
          jsLog(`save on close failed: ${e}`);
        }
        if (!saved) {
          event.preventDefault();
          rpc("cancel_quit").catch(() => {});
        }
      } else if (act !== "discard") {
        event.preventDefault();
        rpc("cancel_quit").catch(() => {});
      }
    });

    // Window-scoped listeners: receive app-wide broadcasts plus events
    // targeted at this window's label, but not those aimed at other windows.
    await win.listen("open-file", (e) => {
      jsLog(`[${winLabel}] event open-file: ${JSON.stringify(e.payload)}`);
      openPath(e.payload);
    });
    await win.listen("file-changed", (e) => {
      handleExternalChange(e.payload);
    });
    // Native menu commands arrive as events aimed at the focused window.
    await win.listen("menu", (e) => {
      switch (e.payload) {
        case "open":
          openDialog();
          break;
        case "save":
          saveCurrent();
          break;
        case "save_as":
          saveAs();
          break;
        case "export_pdf":
          exportPdf();
          break;
        case "undo":
          undo(view);
          view.focus();
          break;
        case "redo":
          redo(view);
          view.focus();
          break;
        case "select_all": {
          // ⌘A inside the search field should select that field, not the doc.
          const el = document.activeElement;
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
            el.select();
          } else {
            selectAll(view);
            view.focus();
          }
          break;
        }
        case "zoom_in":
          zoomBy(1);
          break;
        case "zoom_out":
          zoomBy(-1);
          break;
        case "zoom_reset":
          zoomReset();
          break;
        default:
          jsLog(`unhandled menu event: ${e.payload}`);
      }
    });
    // Quit flow: Rust asks every window to close itself; dirty ones prompt.
    await win.listen("request-close", () => {
      win.close().catch((e) => jsLog(`close failed: ${e}`));
    });

    try {
      const argPath = await rpc("initial_file");
      jsLog(`[${winLabel}] initial_file returned: ${JSON.stringify(argPath)}`);
      if (argPath) {
        try {
          await openPath(argPath);
          jsLog(`openPath succeeded for ${argPath}`);
        } catch (e) {
          jsLog(`openPath failed: ${e}`);
        }
      } else if (winLabel === "main" && !currentPath && view.state.doc.length === 0) {
        // First-ever window with nothing to show: welcome content.
        baseContent = initialDoc;
        view.dispatch({ changes: { from: 0, insert: initialDoc } });
        reportDirty();
      }
    } catch (e) {
      jsLog(`initial_file invoke failed: ${e}`);
    }
  })();
} else {
  // Tauri detection failed in this build context. Log to console.
  console.warn("[md] Tauri not detected — file ops disabled");
}
