// Minimal .editorconfig support: enough of the format to stop Foglio from
// disagreeing with the repository a file lives in. Pure functions so they can
// be tested without a filesystem; the caller supplies the file contents.
//
// Deliberately not implemented: [section] globs beyond simple extension and
// brace lists, charset, max_line_length, and the `root` chain beyond stopping
// the upward walk. Those don't change what we write to disk.

// One .editorconfig file into { section: { key: value } }, in file order.
export function parseEditorConfig(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text).split(/\r\n?|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = { pattern: header[1], props: {} };
      sections.push(current);
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (current) current.props[key] = value;
    else sections.push({ pattern: null, props: { [key]: value } });
  }
  return sections;
}

// Does an .editorconfig section pattern cover this filename? Supports the
// forms that actually appear for markdown: *, *.md, *.{md,txt}, and a bare
// name. Anything more exotic is treated as no match rather than guessed at.
export function sectionMatches(pattern, filename) {
  if (!pattern) return true;
  const name = filename.split("/").pop();

  const braces = /^\*\.\{([^}]+)\}$/.exec(pattern);
  if (braces) {
    return braces[1]
      .split(",")
      .map((e) => e.trim())
      .some((ext) => name.endsWith(`.${ext}`));
  }
  if (pattern === "*") return true;
  const star = /^\*\.([A-Za-z0-9]+)$/.exec(pattern);
  if (star) return name.endsWith(`.${star[1]}`);
  return pattern === name;
}

// Later sections win, which is what the spec says and what people expect when
// they add a [*.md] block under a [*] block.
export function resolveConfig(text, filename) {
  const out = {};
  for (const { pattern, props } of parseEditorConfig(text)) {
    if (!sectionMatches(pattern, filename)) continue;
    Object.assign(out, props);
  }
  return out;
}

const EOL = { lf: "\n", crlf: "\r\n", cr: "\r" };

// Applies the settings that change bytes on disk. `fallbackEol` is the ending
// the file already had, so a document with no .editorconfig keeps what it came
// with rather than being converted.
export function applyEditorConfig(text, config, fallbackEol = "\n") {
  let out = text;

  if (config.trim_trailing_whitespace === "true") {
    out = out.replace(/[ \t]+$/gm, "");
  }

  if (config.insert_final_newline === "true") {
    if (out.length && !out.endsWith("\n")) out += "\n";
  } else if (config.insert_final_newline === "false") {
    out = out.replace(/\n+$/, "");
  }

  const eol = EOL[String(config.end_of_line || "").toLowerCase()] || fallbackEol;
  return eol === "\n" ? out : out.replace(/\n/g, eol);
}

// Markdown uses two trailing spaces as a hard line break, so trimming
// whitespace would silently rewrite the document. Callers should check this
// before honouring trim_trailing_whitespace.
export function wouldBreakHardLineBreaks(text) {
  return /[ ]{2,}\n/.test(text);
}
