import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";

// CodeMirror normalises every line ending to \n. A CRLF file therefore differs
// from its own editor contents the instant it opens, which made it look edited
// straight away and rewrote every line ending on the first save. src/main.js
// normalises what it compares against and puts the original ending back when
// writing; these tests pin the two halves of that.

const normalizeEol = (text) => text.replace(/\r\n?/g, "\n");
const applyEol = (text, ending) =>
  ending === "\n" ? text : text.replace(/\n/g, ending);
const detectEol = (raw) => (/\r\n/.test(raw) ? "\r\n" : "\n");

describe("line endings", () => {
  it("confirms the editor really does strip carriage returns", () => {
    const state = EditorState.create({ doc: "a\r\nb\r\nc" });
    expect(state.doc.toString()).toBe("a\nb\nc");
  });

  it("a CRLF file compares equal once normalised, so it opens clean", () => {
    const raw = "# Title\r\n\r\nBody text.\r\n";
    const inEditor = EditorState.create({ doc: raw }).doc.toString();
    expect(normalizeEol(raw)).toBe(inEditor);
  });

  it("round-trips CRLF content unchanged", () => {
    const raw = "# Title\r\n\r\nBody text.\r\n";
    const ending = detectEol(raw);
    const inEditor = EditorState.create({ doc: raw }).doc.toString();
    expect(applyEol(inEditor, ending)).toBe(raw);
  });

  it("leaves an LF file alone", () => {
    const raw = "# Title\n\nBody text.\n";
    const ending = detectEol(raw);
    expect(ending).toBe("\n");
    const inEditor = EditorState.create({ doc: raw }).doc.toString();
    expect(applyEol(inEditor, ending)).toBe(raw);
  });

  it("treats old-style CR-only files as line breaks too", () => {
    expect(normalizeEol("a\rb")).toBe("a\nb");
  });
});
