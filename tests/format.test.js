import { describe, it, expect } from "vitest";
import { toggleWrap, toggleLink } from "../src/format.js";

// Applies the returned changes to the document and marks the resulting
// selection with pipes, so a case reads as the thing the user would see.
function apply(doc, from, to, fn) {
  const r = fn(doc, from, to);
  const sorted = [...r.changes].sort((a, b) => b.from - a.from);
  let out = doc;
  for (const c of sorted) {
    out = out.slice(0, c.from) + (c.insert || "") + out.slice(c.to);
  }
  const [a, b] = [r.anchor, r.head].sort((x, y) => x - y);
  return out.slice(0, a) + "|" + out.slice(a, b) + "|" + out.slice(b);
}

const bold = (doc, from, to) => apply(doc, from, to, (d, f, t) => toggleWrap(d, f, t, "**"));
const italic = (doc, from, to) => apply(doc, from, to, (d, f, t) => toggleWrap(d, f, t, "*"));
const strike = (doc, from, to) => apply(doc, from, to, (d, f, t) => toggleWrap(d, f, t, "~~"));
const code = (doc, from, to) => apply(doc, from, to, (d, f, t) => toggleWrap(d, f, t, "`"));

// Offsets of a word in a document, so the cases below stay readable.
const at = (doc, word) => [doc.indexOf(word), doc.indexOf(word) + word.length];

describe("toggleWrap", () => {
  it("wraps a selection and keeps it on the same text", () => {
    expect(bold("make me bold", ...at("make me bold", "me"))).toBe("make **|me|** bold");
  });

  it("unwraps when the selection is the text inside the markers", () => {
    expect(bold("make **me** bold", ...at("make **me** bold", "me"))).toBe("make |me| bold");
  });

  it("unwraps when the selection includes the markers", () => {
    expect(bold("make **me** bold", ...at("make **me** bold", "**me**"))).toBe("make |me| bold");
  });

  it("leaves a trailing space outside the markers", () => {
    // A double-click takes the space with it, and `**me **` is not bold at all.
    expect(bold("make me bold", 5, 8)).toBe("make **|me|** bold");
  });

  it("bolds the word under the caret when nothing is selected", () => {
    expect(bold("make me bold", 6, 6)).toBe("make **|me|** bold");
  });

  it("unbolds from a caret inside an already bold word", () => {
    expect(bold("make **me** bold", 8, 8)).toBe("make |me| bold");
  });

  it("opens an empty pair when there is no word to take", () => {
    expect(bold("line ", 5, 5)).toBe("line **||**");
  });

  it("stacks italic on top of bold", () => {
    expect(italic("**me**", ...at("**me**", "me"))).toBe("***|me|***");
  });

  it("takes italic back off bold-italic without adding a fourth star", () => {
    expect(italic("***me***", ...at("***me***", "me"))).toBe("**|me|**");
  });

  it("takes bold off bold-italic and leaves the italic", () => {
    expect(bold("***me***", ...at("***me***", "me"))).toBe("*|me|*");
  });

  it("adds bold to italic text", () => {
    expect(bold("*me*", ...at("*me*", "me"))).toBe("***|me|***");
  });

  it("does not mistake a neighbour's markers for its own", () => {
    // The stars before `bar` close the bold on `foo`; `bar` itself is not bold,
    // so this must add markers rather than steal foo's.
    const doc = "**foo**bar";
    expect(bold(doc, ...at(doc, "bar"))).toBe("**foo****|bar|**");
  });

  it("handles strikethrough and inline code", () => {
    expect(strike("gone", 0, 4)).toBe("~~|gone|~~");
    expect(strike("~~gone~~", 2, 6)).toBe("|gone|");
    expect(code("x = 1", 0, 5)).toBe("`|x = 1|`");
    expect(code("`x = 1`", 1, 6)).toBe("|x = 1|");
  });

  it("wraps a multi-word selection spanning punctuation", () => {
    const doc = "keep the whole phrase, please";
    expect(bold(doc, ...at(doc, "whole phrase, please"))).toBe(
      "keep the **|whole phrase, please|**"
    );
  });

  it("wraps a non-ASCII word from a bare caret", () => {
    expect(bold("il perché è questo", 5, 5)).toBe("il **|perché|** è questo");
  });
});

describe("toggleLink", () => {
  const link = (doc, from, to) => apply(doc, from, to, toggleLink);

  it("makes the selection the label and waits in the target", () => {
    expect(link("see the docs", ...at("see the docs", "the docs"))).toBe("see [the docs](||)");
  });

  it("makes a selected URL the target and waits in the label", () => {
    const doc = "https://example.com";
    expect(link(doc, 0, doc.length)).toBe("[||](https://example.com)");
  });

  it("leaves the caret in the label with nothing selected", () => {
    expect(link("see ", 4, 4)).toBe("see [||]()");
  });

  it("unwraps a selected link back to its label", () => {
    const doc = "see [the docs](https://example.com) now";
    expect(link(doc, ...at(doc, "[the docs](https://example.com)"))).toBe("see |the docs| now");
  });

  it("ignores a trailing space in the selection", () => {
    expect(link("see the docs ", 4, 13)).toBe("see [the docs](||) ");
  });
});
