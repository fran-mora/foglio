# Launch checklist

Working list for the open-source launch. Tick items as they land.
(Delete this file or fold leftovers into the README roadmap before the first public push.)

## Blockers — visible in the first five minutes

- [x] Syntax highlighting in code fences (143 languages via @codemirror/language-data; info string hidden off-cursor)
- [x] Task-list checkboxes — render as real checkboxes; click-to-toggle wired (verify a click by hand)
- [x] List bullets — `-`/`*` render as bullets off-cursor; ordered lists keep numbers
- [x] Inline images — relative + absolute paths, asset protocol, dashed placeholder when the file is missing, scaled to the line when inside a sentence
- [x] Name: **Foglio** — product, window titles, bundle ID (`md.foglio.editor`), crate, package renamed; foglio.md domain available (register it!)
- [x] Code signing — Developer ID, hardened runtime, secure timestamp, verified with `codesign`
- [ ] **Notarization** — needs your Apple ID + an app-specific password; steps are in RELEASING.md

## Polish — small, worth doing in the same pass

- [x] Save As… (⇧⌘S)
- [x] Editor zoom (⌘+ / ⌘− / ⌘0), persisted between launches
- [x] Native macOS menu bar: Foglio / File / Edit / View / Window, with Open, Save, Save As, Export PDF, New Window

## Launch

- [x] README rewritten, with roadmap and measured numbers
- [x] RELEASING.md with the signing and notarization runbook
- [x] Initial commit
- [ ] Create GitHub repo and push (currently local only)
- [ ] v0.1.0 release with a signed **and notarized** dmg
- [ ] Announcement copy leading with measured numbers (5 MB app, 3.1 MB dmg, ~0.4 s cold start, 56k-line file opens instantly)

## Worth doing before you announce

- [ ] Register foglio.md
- [ ] Click a task checkbox, use Save As, and zoom by hand — these were built and verified visually, not by simulated input
- [ ] Decide whether remote images should load by default (currently yes; a document can therefore ping a server when opened)

## Done earlier

- [x] MIT LICENSE
- [x] Debug logging gated behind `MD_DEBUG` (writes to `$TMPDIR`)
- [x] CSP tightened and verified against a real build
- [x] Niche research: slot open (minimal + macOS + CM6 live preview), closing fast — ship soon
- [x] Stress test: 1.2 MB / 56k-line document opens instantly, ~100 MB RSS, idle CPU 0%
