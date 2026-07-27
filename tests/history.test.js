import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";

// Loading a file must not leave the previous document sitting in undo history.
// If it did, undo after opening would restore the old text while the window
// still pointed at the new path, and the next save would write it over the
// newly opened file. src/main.js loads documents by building a fresh state
// (loadDocument) rather than dispatching an edit; these tests pin down the
// difference between the two, since only one of them is safe.

const extensions = [history()];

// CodeMirror commands take a { state, dispatch } pair, so no DOM is needed.
function tryUndo(state) {
  let next = state;
  const applied = undo({
    state,
    dispatch: (tr) => {
      next = tr.state;
    },
  });
  return { applied, doc: next.doc.toString() };
}

describe("document loading and undo history", () => {
  it("can undo an ordinary edit", () => {
    let state = EditorState.create({ doc: "original", extensions });
    state = state.update({ changes: { from: 0, to: 8, insert: "edited" } }).state;
    expect(state.doc.toString()).toBe("edited");

    const { applied, doc } = tryUndo(state);
    expect(applied).toBe(true);
    expect(doc).toBe("original");
  });

  it("leaves nothing to undo when a document is loaded as a fresh state", () => {
    // What loadDocument does.
    const loaded = EditorState.create({ doc: "contents of the opened file", extensions });

    const { applied } = tryUndo(loaded);
    expect(applied).toBe(false);
  });

  it("would expose the previous document if a load were dispatched as an edit", () => {
    // What the code used to do, kept as a demonstration of why it was wrong.
    let state = EditorState.create({ doc: "previous document", extensions });
    state = state.update({
      changes: { from: 0, to: state.doc.length, insert: "contents of the opened file" },
    }).state;

    const { applied, doc } = tryUndo(state);
    expect(applied).toBe(true);
    expect(doc).toBe("previous document"); // the old file's text, under the new file's path
  });
});
