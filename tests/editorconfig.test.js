import { describe, it, expect } from "vitest";
import {
  parseEditorConfig,
  sectionMatches,
  resolveConfig,
  applyEditorConfig,
  wouldBreakHardLineBreaks,
} from "../src/editorconfig.js";

const SAMPLE = `
root = true

[*]
end_of_line = lf
insert_final_newline = true

# comment
[*.md]
trim_trailing_whitespace = false

[*.{js,ts}]
indent_size = 2
`;

describe("parsing", () => {
  it("reads sections and key/value pairs", () => {
    const s = parseEditorConfig(SAMPLE);
    const patterns = s.map((x) => x.pattern);
    expect(patterns).toContain("*");
    expect(patterns).toContain("*.md");
    expect(s.find((x) => x.pattern === "*").props.end_of_line).toBe("lf");
  });

  it("ignores comments and blank lines", () => {
    const s = parseEditorConfig("# c\n; also c\n\n[*]\nkey = value\n");
    expect(s.find((x) => x.pattern === "*").props.key).toBe("value");
  });

  it("survives a file with no sections at all", () => {
    expect(() => parseEditorConfig("")).not.toThrow();
    expect(parseEditorConfig("")).toEqual([]);
  });
});

describe("section matching", () => {
  it("matches the forms that appear for markdown", () => {
    expect(sectionMatches("*", "notes.md")).toBe(true);
    expect(sectionMatches("*.md", "notes.md")).toBe(true);
    expect(sectionMatches("*.md", "script.js")).toBe(false);
    expect(sectionMatches("*.{md,txt}", "notes.txt")).toBe(true);
    expect(sectionMatches("*.{md,txt}", "notes.js")).toBe(false);
    expect(sectionMatches("README.md", "README.md")).toBe(true);
  });

  it("matches on the basename, not the whole path", () => {
    expect(sectionMatches("*.md", "/a/b/c/notes.md")).toBe(true);
  });
});

describe("resolving", () => {
  it("lets a later, more specific section win", () => {
    const c = resolveConfig(SAMPLE, "notes.md");
    expect(c.end_of_line).toBe("lf");           // from [*]
    expect(c.trim_trailing_whitespace).toBe("false"); // from [*.md]
  });

  it("skips sections that do not apply", () => {
    const c = resolveConfig(SAMPLE, "notes.md");
    expect(c.indent_size).toBeUndefined();      // that was [*.{js,ts}]
  });
});

describe("applying to file contents", () => {
  it("adds a final newline when asked", () => {
    expect(applyEditorConfig("a", { insert_final_newline: "true" })).toBe("a\n");
    expect(applyEditorConfig("a\n", { insert_final_newline: "true" })).toBe("a\n");
  });

  it("removes trailing newlines when told to", () => {
    expect(applyEditorConfig("a\n\n", { insert_final_newline: "false" })).toBe("a");
  });

  it("trims trailing whitespace only when asked", () => {
    expect(applyEditorConfig("a   \nb\n", { trim_trailing_whitespace: "true" })).toBe("a\nb\n");
    expect(applyEditorConfig("a   \nb\n", {})).toBe("a   \nb\n");
  });

  it("converts line endings on request", () => {
    expect(applyEditorConfig("a\nb\n", { end_of_line: "crlf" })).toBe("a\r\nb\r\n");
    expect(applyEditorConfig("a\r\nb\r\n".replace(/\r\n/g, "\n"), { end_of_line: "lf" })).toBe("a\nb\n");
  });

  it("keeps the file's existing ending when the config says nothing", () => {
    expect(applyEditorConfig("a\nb\n", {}, "\r\n")).toBe("a\r\nb\r\n");
    expect(applyEditorConfig("a\nb\n", {}, "\n")).toBe("a\nb\n");
  });

  it("changes nothing at all for an empty config", () => {
    const text = "# Title\n\nBody with  \na hard break.\n";
    expect(applyEditorConfig(text, {}, "\n")).toBe(text);
  });

  it("leaves an empty document empty rather than inventing a newline", () => {
    expect(applyEditorConfig("", { insert_final_newline: "true" })).toBe("");
  });
});

describe("hard line break guard", () => {
  it("notices the two-space line break markdown depends on", () => {
    expect(wouldBreakHardLineBreaks("line one  \nline two\n")).toBe(true);
    expect(wouldBreakHardLineBreaks("line one\nline two\n")).toBe(false);
  });

  it("is what stands between trim_trailing_whitespace and a silent rewrite", () => {
    const doc = "line one  \nline two\n";
    // Applying the setting blindly would destroy the break.
    expect(applyEditorConfig(doc, { trim_trailing_whitespace: "true" })).toBe("line one\nline two\n");
    // So the caller checks first.
    expect(wouldBreakHardLineBreaks(doc)).toBe(true);
  });
});
