# Working on Foglio

macOS markdown editor. Tauri 2 (Rust) + CodeMirror 6. Live inline rendering.

**Keep this file short.** It is read in full at the start of every session, so
length costs attention. Add a line only when its absence would cause a real
mistake, and delete lines that stop being true.

**Update it as you go.** When you learn something the hard way here — a fix, a
wrong assumption, a platform limit, a rejected approach — add the one-line
lesson before moving on. Do not wait to be asked.

## The invariant

Foglio decorates the source text. It never parses the document into a model and
regenerates markdown from it. That is the whole product: the file it writes is
the file you wrote, byte for byte. Nothing may break this. If a feature needs a
document model, it does not belong here.

Consequences worth knowing:

- Load documents with a fresh `EditorState` (`loadDocument`), never a dispatch.
  A dispatch leaves the previous file in undo history, and undo-then-save writes
  the old text over the newly opened file.
- The file's own line ending is restored on write, and `.editorconfig` is
  honoured — except `trim_trailing_whitespace` when the document uses two-space
  hard breaks, which would silently change how it renders.
- ⇧⌘D shows the pending diff. For an untouched file that panel must be empty.

## WKWebView is not Chromium

macOS 11 is the floor, so check features against Safari, not Chrome. Failures
are silent, not loud.

- `-webkit-app-region` does nothing. Window dragging needs
  `data-tauri-drag-region` **and** `core:window:allow-start-dragging` in
  `src-tauri/capabilities/default.json`.
- No regex lookbehind. It throws at parse time and takes down the whole editor.
  A test guards the math regex; keep it.
- Adding any Tauri API means adding its permission to the capability file.

## Rendering rules

- Constructs render only when the caret is at rest and elsewhere. Not during a
  drag and not while a selection is open, or lines reflow under the pointer and
  selecting becomes a fight.
- No `drawSelection()`. It paints behind the text, and opaque code-block lines
  hide it completely.
- Table cells go through `innerHTML`: escape first, and restrict link schemes to
  http/https/mailto. `marked` passes raw HTML through, so exported files carry a
  CSP.
- A `WidgetType`'s `eq()` has to compare everything the widget draws with. One
  that returns true unconditionally is never rebuilt, so an indented bullet
  keeps the glyph of its old depth.
- Hide a `URL` node only when its parent is `Link`. There the link text stands
  in for it; everywhere else the URL *is* the visible text and hiding it wipes
  the text off the line. A GFM autolink (bare email or `www.` host) parses as a
  lone `URL` under the paragraph, `<https://…>` puts one under `Autolink`, and
  a `[ref]:` definition under `LinkReference`.

## Keyboard shortcuts

- A shortcut needs both halves: the binding in the CodeMirror keymap and the
  menu item in `lib.rs`. The native accelerator fires first in the packaged
  app, so a keymap-only binding looks dead there; `npm run dev` is the other
  way round and exercises only the keymap.
- Put custom bindings *before* `...defaultKeymap`. The first binding for a key
  that returns true wins, and defaultKeymap already owns ⌘I (selectParentSyntax)
  and ⇧⌘K (deleteLine).
- Give an editing command a `userEvent` history will not join, such as
  `input.format`. An untagged change folds into the undo step of whatever was
  typed in the half second before it.
- Tab must return false when the caret is not in a list. It is the only way to
  move focus out of the editor without a mouse. Which makes a gate that says
  "not a list" too readily look exactly like a dead key.
- Resolve the syntax tree at the construct, not at the caret. A caret at the
  end of a line sits on the node's closing boundary, and `resolveInner` there
  hands back the parent — so end-of-line, where clicking past the last word
  puts it, reads as outside the item. Drive a caret test from more than
  column 0.
- `markdown()` installs `markdownKeymap` at high precedence, so Enter already
  continues a list and Backspace already eats its marker. A test that builds a
  list by typing gets every marker twice — use Playwright's `insertText`.

## Testing

Pure logic lives in `src/markdown.js`, `src/editorconfig.js`, `src/diff.js`,
`src/format.js` and `src/list.js`, and is unit tested. Everything visual is
verified by running the app and looking at it — every bug found here so far has
been visual.

- Drive the UI with Playwright **webkit** against `npm run dev`. Chromium will
  lie to you. Synthetic CGEvent clicks do not reach the app at all.
- A screenshot of an occluded window comes back blank. Activate by PID first.
- Before a release, by hand: drag the window, toggle a checkbox, select text
  inside a code block, save. Those four gestures cover the bugs that reach users
  first, and no test catches them.

## Releasing

`RELEASING.md` has the runbook. Always build universal, or Intel Macs get an app
that will not launch:

```sh
export PATH="$HOME/.cargo/bin:$PATH"   # Homebrew's rust is host-arch only
npm run tauri build -- --target universal-apple-darwin
```

Bump the version in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` together. Quote the **download** size, not the
single-architecture build.
