import { describe, it, expect } from "vitest";
import { diffLines, changedHunks, diffStats, isWhitespaceOnlyChange } from "../src/diff.js";

const text = (rows) => rows.map((r) => `${r.type}:${r.text}`);

describe("diffLines", () => {
  it("reports nothing changed for identical text", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.type === "same")).toBe(true);
    expect(diffStats("a\nb\nc", "a\nb\nc")).toEqual({ added: 0, removed: 0, truncated: false });
  });

  it("finds a changed line as a remove plus an add", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    expect(text(rows)).toContain("remove:b");
    expect(text(rows)).toContain("add:B");
    expect(diffStats("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1, truncated: false });
  });

  it("finds a pure insertion", () => {
    expect(diffStats("a\nc", "a\nb\nc")).toEqual({ added: 1, removed: 0, truncated: false });
  });

  it("finds a pure deletion", () => {
    expect(diffStats("a\nb\nc", "a\nc")).toEqual({ added: 0, removed: 1, truncated: false });
  });

  it("reconstructs the new text from same+add rows", () => {
    const before = "one\ntwo\nthree\n";
    const after = "one\ntwo point five\nthree\nfour\n";
    const rebuilt = diffLines(before, after)
      .filter((r) => r.type === "same" || r.type === "add")
      .map((r) => r.text)
      .join("\n");
    expect(rebuilt).toBe(after);
  });

  it("preserves the original for same+remove rows", () => {
    const before = "one\ntwo\nthree\n";
    const after = "one\nthree\n";
    const rebuilt = diffLines(before, after)
      .filter((r) => r.type === "same" || r.type === "remove")
      .map((r) => r.text)
      .join("\n");
    expect(rebuilt).toBe(before);
  });

  it("refuses to diff an enormous file rather than hanging", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    expect(diffLines(huge, huge + "\nx")[0].type).toBe("truncated");
    expect(diffStats(huge, huge + "\nx").truncated).toBe(true);
  });
});

describe("changedHunks", () => {
  it("keeps only changed rows plus context", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
    const after = "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10";
    const hunks = changedHunks(before, after, 1);
    expect(hunks.length).toBeLessThan(10);
    expect(text(hunks)).toContain("add:FIVE");
    expect(text(hunks)).toContain("remove:5");
  });

  it("returns nothing when the files match", () => {
    expect(changedHunks("a\nb", "a\nb")).toEqual([]);
  });
});

describe("isWhitespaceOnlyChange", () => {
  it("spots a reformat that only moved whitespace", () => {
    expect(isWhitespaceOnlyChange("a   \nb", "a\nb")).toBe(true);
    expect(isWhitespaceOnlyChange("- item", "-   item")).toBe(true);
  });

  it("does not flag a real edit", () => {
    expect(isWhitespaceOnlyChange("a\nb", "a\nc")).toBe(false);
  });

  it("is false when nothing changed at all", () => {
    expect(isWhitespaceOnlyChange("a\nb", "a\nb")).toBe(false);
  });
});
