import { describe, expect, it } from "vitest";
import { indentList, listLine, outdentList } from "../src/list.js";

// The slice of CodeMirror's Text that list.js actually uses.
function docOf(text) {
  const texts = text.split("\n");
  const starts = [];
  let pos = 0;
  for (const t of texts) {
    starts.push(pos);
    pos += t.length + 1;
  }
  const line = (n) => ({
    number: n,
    from: starts[n - 1],
    to: starts[n - 1] + texts[n - 1].length,
    text: texts[n - 1],
  });
  return {
    line,
    lineAt(p) {
      let n = 1;
      while (n < texts.length && starts[n] <= p) n++;
      return line(n);
    },
  };
}

// Apply the returned changes to the original text so tests read as before/after
// rather than as offset arithmetic.
function apply(text, result) {
  if (!result) return null;
  let out = text;
  for (const c of [...result.changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + (c.insert || "") + out.slice(c.to);
  }
  return out;
}

// Position of the caret marked with | in the fixture, which is stripped out.
function at(text, marker = "|") {
  const pos = text.indexOf(marker);
  return { text: text.replace(marker, ""), pos };
}

const run = (fn, fixture) => {
  const { text, pos } = at(fixture);
  return apply(text, fn(docOf(text), pos, pos));
};

describe("listLine", () => {
  it("reads a bullet item", () => {
    expect(listLine("- one")).toEqual({ indent: 0, marker: "-", contentCol: 2 });
  });

  it("reads a numbered item and its wider content column", () => {
    expect(listLine("1. one")).toEqual({ indent: 0, marker: "1.", contentCol: 3 });
    expect(listLine("10) one")).toEqual({ indent: 0, marker: "10)", contentCol: 4 });
  });

  it("counts the indent", () => {
    expect(listLine("    - deep")).toMatchObject({ indent: 4, contentCol: 6 });
  });

  it("ignores anything that is not a list item", () => {
    expect(listLine("just a paragraph")).toBeNull();
    expect(listLine("-no space after the marker")).toBeNull();
    expect(listLine("")).toBeNull();
  });

  it("ignores a tab-indented item rather than mixing tabs with spaces", () => {
    expect(listLine("\t- one")).toBeNull();
  });
});

describe("indentList", () => {
  it("nests an item under the one above it", () => {
    expect(run(indentList, "- one\n- t|wo")).toBe("- one\n  - two");
  });

  it("indents by the previous sibling's content column, not a fixed width", () => {
    expect(run(indentList, "1. one\n2. t|wo")).toBe("1. one\n   2. two");
    expect(run(indentList, "-   one\n-   t|wo")).toBe("-   one\n    -   two");
  });

  it("leaves the first item of a list alone", () => {
    expect(run(indentList, "- o|ne\n- two")).toBe("- one\n- two");
  });

  it("leaves the first child of a deeper list alone", () => {
    expect(run(indentList, "- one\n  - a|\n  - b")).toBe("- one\n  - a\n  - b");
  });

  it("nests under a sibling that is itself already nested", () => {
    expect(run(indentList, "- one\n  - a\n  - b|")).toBe("- one\n  - a\n    - b");
  });

  it("steps over a blank line inside the list", () => {
    expect(run(indentList, "- one\n\n- t|wo")).toBe("- one\n\n  - two");
  });

  it("does not reach across a paragraph that ended the list", () => {
    expect(run(indentList, "- one\n\nA paragraph.\n\n- t|wo")).toBe(
      "- one\n\nA paragraph.\n\n- two"
    );
  });

  it("indents a task item like any other", () => {
    expect(run(indentList, "- [ ] one\n- [x] t|wo")).toBe("- [ ] one\n  - [x] two");
  });

  it("hands back null when there is no list to indent", () => {
    const { text, pos } = at("just a p|aragraph");
    expect(indentList(docOf(text), pos, pos)).toBeNull();
  });

  it("swallows the key with an empty change list when it cannot go deeper", () => {
    const { text, pos } = at("- o|ne");
    expect(indentList(docOf(text), pos, pos)).toEqual({ changes: [] });
  });

  it("never renumbers an ordered list", () => {
    expect(run(indentList, "1. one\n2. t|wo\n3. three")).toBe(
      "1. one\n   2. two\n3. three"
    );
  });
});

describe("outdentList", () => {
  it("takes an item back out one level", () => {
    expect(run(outdentList, "- one\n  - t|wo")).toBe("- one\n- two");
  });

  it("undoes exactly what indent did, at any marker width", () => {
    for (const before of ["- one\n- two", "1. one\n2. two", "-   one\n-   two"]) {
      const caret = before.lastIndexOf("\n") + 3;
      const indented = apply(before, indentList(docOf(before), caret, caret));
      const back = apply(
        indented,
        outdentList(docOf(indented), indented.length - 1, indented.length - 1)
      );
      expect(back).toBe(before);
    }
  });

  it("leaves a top-level item alone", () => {
    expect(run(outdentList, "- one\n- t|wo")).toBe("- one\n- two");
  });

  it("takes a stray indented item back to the margin", () => {
    expect(run(outdentList, "    - o|nly")).toBe("- only");
  });

  it("hands back null when there is no list", () => {
    const { text, pos } = at("just a p|aragraph");
    expect(outdentList(docOf(text), pos, pos)).toBeNull();
  });
});

describe("a selection spanning several items", () => {
  const doc = "- one\n- two\n  - a\n  - b\n- three";

  it("shifts the whole block by one delta, keeping its shape", () => {
    const from = doc.indexOf("- two");
    const to = doc.indexOf("  - b") + 5;
    expect(apply(doc, indentList(docOf(doc), from, to))).toBe(
      "- one\n  - two\n    - a\n    - b\n- three"
    );
  });

  it("brings the same block back again", () => {
    const shifted = "- one\n  - two\n    - a\n    - b\n- three";
    const from = shifted.indexOf("  - two");
    const to = shifted.indexOf("    - b") + 7;
    expect(apply(shifted, outdentList(docOf(shifted), from, to))).toBe(doc);
  });

  it("never outdents past the margin, however deep the selection started", () => {
    const from = doc.indexOf("- one");
    const to = doc.length;
    expect(apply(doc, outdentList(docOf(doc), from, to))).toBe(doc);
  });

  it("ignores a line the selection only just touches", () => {
    const from = doc.indexOf("- two");
    const to = doc.indexOf("  - a"); // the very start of the next line
    expect(apply(doc, indentList(docOf(doc), from, to))).toBe(
      "- one\n  - two\n  - a\n  - b\n- three"
    );
  });

  it("skips the lines in between that are not list items", () => {
    const mixed = "- zero\n- one\n\nstill talking\n\n- two";
    const from = mixed.indexOf("- one");
    expect(apply(mixed, indentList(docOf(mixed), from, mixed.length))).toBe(
      "- zero\n  - one\n\nstill talking\n\n  - two"
    );
  });
});
