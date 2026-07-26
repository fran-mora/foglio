import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  renderInline,
  safeLinkTarget,
  isDelimiterRow,
  parseTable,
  parseImage,
  resolveImagePath,
} from "./markdown.js";

describe("escapeHtml", () => {
  it("escapes the characters that could open a tag or attribute", () => {
    expect(escapeHtml("<b>")).toBe("&lt;b&gt;");
    expect(escapeHtml('a "quoted" & \'single\'')).toBe(
      "a &quot;quoted&quot; &amp; &#39;single&#39;"
    );
  });

  it("leaves ordinary text alone", () => {
    expect(escapeHtml("Cardiff-Weston 12.3 m")).toBe("Cardiff-Weston 12.3 m");
  });
});

// Table cells are injected with innerHTML, so this is the boundary between a
// document someone sent you and script running in the editor.
describe("renderInline escaping", () => {
  it("neutralises a script tag in a cell", () => {
    const out = renderInline('<script>alert("x")</script>');
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("neutralises an image with an inline event handler", () => {
    const out = renderInline('<img src=x onerror="alert(1)">');
    // The handler survives as text, which is harmless: no tag is produced and
    // the quotes that would close an attribute are escaped.
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain('"');
  });

  it("escapes before applying markdown, so markup cannot be smuggled in", () => {
    const out = renderInline("**<em>bold</em>**");
    expect(out).toBe("<strong>&lt;em&gt;bold&lt;/em&gt;</strong>");
  });

  it("refuses javascript: and data: link targets", () => {
    expect(renderInline("[click](javascript:alert(1))")).not.toContain("href=\"javascript:");
    expect(renderInline("[click](DATA:text/html;base64,x)")).not.toContain("href=\"DATA:");
    expect(renderInline("[click](  javascript:alert(1))")).not.toMatch(/href="\s*javascript:/i);
  });

  it("keeps ordinary links working", () => {
    expect(renderInline("[docs](https://example.com/a)")).toBe(
      '<a href="https://example.com/a">docs</a>'
    );
    expect(renderInline("[rel](./notes.md)")).toBe('<a href="./notes.md">rel</a>');
  });
});

describe("safeLinkTarget", () => {
  it("allows the schemes a document legitimately links to", () => {
    expect(safeLinkTarget("https://example.com")).toBe("https://example.com");
    expect(safeLinkTarget("http://example.com")).toBe("http://example.com");
    expect(safeLinkTarget("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it("allows relative paths and anchors, which carry no scheme", () => {
    expect(safeLinkTarget("./notes.md")).toBe("./notes.md");
    expect(safeLinkTarget("/abs/path")).toBe("/abs/path");
    expect(safeLinkTarget("#section")).toBe("#section");
  });

  it("rejects schemes that could execute or impersonate", () => {
    expect(safeLinkTarget("javascript:alert(1)")).toBeNull();
    expect(safeLinkTarget("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeLinkTarget("  javascript:alert(1)")).toBeNull();
    expect(safeLinkTarget("data:text/html,<script>")).toBeNull();
    expect(safeLinkTarget("vbscript:msgbox")).toBeNull();
    expect(safeLinkTarget("file:///etc/passwd")).toBeNull();
  });
});

describe("renderInline formatting", () => {
  it("renders the inline constructs a table cell can hold", () => {
    expect(renderInline("**bold**")).toBe("<strong>bold</strong>");
    expect(renderInline("__bold__")).toBe("<strong>bold</strong>");
    expect(renderInline("*it*")).toBe("<em>it</em>");
    expect(renderInline("~~gone~~")).toBe("<s>gone</s>");
    expect(renderInline("`code`")).toBe("<code>code</code>");
  });

  it("does not treat bold as two italics", () => {
    expect(renderInline("**both**")).not.toContain("<em>");
  });

  it("leaves an unmatched marker as text", () => {
    expect(renderInline("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(renderInline("a _ b _ c")).toBe("a _ b _ c");
  });

  it("still emphasises single characters and snake_case survives", () => {
    expect(renderInline("*a*")).toBe("<em>a</em>");
    expect(renderInline("range_m and area_km2")).toBe("range_m and area_km2");
  });
});

describe("parseTable", () => {
  const table = [
    "| Site | Range | Capacity |",
    "|------|------:|:--------:|",
    "| Cardiff-Weston | 12.3 m | 8.6 GW |",
    "| Shoots | 11.9 m | 1.05 GW |",
  ].join("\n");

  it("reads the header, alignments and rows", () => {
    const { header, aligns, rows } = parseTable(table);
    expect(header).toEqual(["Site", "Range", "Capacity"]);
    expect(aligns).toEqual(["left", "right", "center"]);
    expect(rows).toEqual([
      ["Cardiff-Weston", "12.3 m", "8.6 GW"],
      ["Shoots", "11.9 m", "1.05 GW"],
    ]);
  });

  it("copes with missing outer pipes and stray whitespace", () => {
    const { header, rows } = parseTable("a | b\n--- | ---\n  1 |  2  ");
    expect(header).toEqual(["a", "b"]);
    expect(rows).toEqual([["1", "2"]]);
  });

  it("returns null when there is nothing to render", () => {
    expect(parseTable("")).toBeNull();
    expect(parseTable("\n\n")).toBeNull();
  });

  it("treats a table with no body as a header only", () => {
    const { header, rows } = parseTable("| a | b |\n|---|---|");
    expect(header).toEqual(["a", "b"]);
    expect(rows).toEqual([]);
  });

  it("recognises delimiter rows in their various spellings", () => {
    expect(isDelimiterRow("|---|---|")).toBe(true);
    expect(isDelimiterRow("--- | :---: | ---:")).toBe(true);
    expect(isDelimiterRow("| data | here |")).toBe(false);
  });
});

describe("parseImage", () => {
  it("reads alt text and target", () => {
    expect(parseImage("![Foglio icon](logo.png)")).toEqual({
      alt: "Foglio icon",
      url: "logo.png",
    });
  });

  it("accepts an empty alt, a title, and angle brackets", () => {
    expect(parseImage("![](a.png)")).toEqual({ alt: "", url: "a.png" });
    expect(parseImage('![x](a.png "A title")')).toEqual({ alt: "x", url: "a.png" });
    expect(parseImage("![x](<a.png>)")).toEqual({ alt: "x", url: "a.png" });
  });

  it("rejects things that are not a lone image", () => {
    expect(parseImage("[link](a.png)")).toBeNull();
    expect(parseImage("text ![x](a.png)")).toBeNull();
    expect(parseImage("![unclosed](a.png")).toBeNull();
  });
});

describe("resolveImagePath", () => {
  const doc = "/Users/f/notes/report.md";

  it("passes remote and data targets straight through", () => {
    expect(resolveImagePath("https://example.com/a.png", doc)).toEqual({
      remote: true,
      src: "https://example.com/a.png",
    });
    expect(resolveImagePath("data:image/png;base64,AAA", doc).remote).toBe(true);
  });

  it("resolves a relative path against the open document", () => {
    expect(resolveImagePath("logo.png", doc).src).toBe("/Users/f/notes/logo.png");
    expect(resolveImagePath("img/logo.png", doc).src).toBe("/Users/f/notes/img/logo.png");
  });

  it("leaves an absolute path as it is", () => {
    expect(resolveImagePath("/tmp/a.png", doc).src).toBe("/tmp/a.png");
  });

  it("decodes percent-escapes so spaces in filenames resolve", () => {
    expect(resolveImagePath("my%20logo.png", doc).src).toBe("/Users/f/notes/my logo.png");
  });

  it("keeps a malformed escape rather than dropping the path", () => {
    expect(resolveImagePath("bad%zz.png", doc).src).toBe("/Users/f/notes/bad%zz.png");
  });

  it("leaves a relative path alone when no document is open", () => {
    expect(resolveImagePath("logo.png", null).src).toBe("logo.png");
  });
});
