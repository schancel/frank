import katex from "katex";
import type MarkdownIt from "markdown-it";

/**
 * Modern KaTeX plugin for markdown-it using the top-level KaTeX engine (v0.16.x+).
 * Replaces the legacy markdown-it-katex which was bundled with KaTeX 0.6.0 (2016)
 * and failed on modern LaTeX syntax like \xrightarrow, \parallel, and environments.
 */
export function markdownItKatex(
  md: MarkdownIt,
  options: katex.KatexOptions = {}
) {
  const opts: katex.KatexOptions = {
    throwOnError: false,
    ...options,
  };

  function isValidDelim(state: any, pos: number) {
    const max = state.posMax;
    let can_open = true;
    let can_close = true;

    const prevChar = pos > 0 ? state.src.charCodeAt(pos - 1) : -1;
    const nextChar = pos + 1 <= max ? state.src.charCodeAt(pos + 1) : -1;

    if (
      prevChar === 0x20 ||
      prevChar === 0x09 ||
      (nextChar >= 0x30 && nextChar <= 0x39)
    ) {
      can_close = false;
    }
    if (nextChar === 0x20 || nextChar === 0x09) {
      can_open = false;
    }

    return { can_open, can_close };
  }

  function math_inline(state: any, silent: boolean) {
    if (state.src[state.pos] !== "$") {
      return false;
    }

    const res = isValidDelim(state, state.pos);
    if (!res.can_open) {
      if (!silent) {
        state.pending += "$";
      }
      state.pos += 1;
      return true;
    }

    const start = state.pos + 1;
    let match = start;
    while ((match = state.src.indexOf("$", match)) !== -1) {
      let pos = match - 1;
      while (state.src[pos] === "\\") {
        pos -= 1;
      }
      if ((match - pos) % 2 === 1) {
        break;
      }
      match += 1;
    }

    if (match === -1) {
      if (!silent) {
        state.pending += "$";
      }
      state.pos = start;
      return true;
    }

    if (match - start === 0) {
      if (!silent) {
        state.pending += "$$";
      }
      state.pos = start + 1;
      return true;
    }

    const closeRes = isValidDelim(state, match);
    if (!closeRes.can_close) {
      if (!silent) {
        state.pending += "$";
      }
      state.pos = start;
      return true;
    }

    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.markup = "$";
      token.content = state.src.slice(start, match);
    }

    state.pos = match + 1;
    return true;
  }

  function math_block(state: any, start: number, end: number, silent: boolean) {
    let firstLine: string | undefined;
    let lastLine: string | undefined;
    let next: number;
    let lastPos: number;
    let found = false;

    let pos = state.bMarks[start] + state.tShift[start];
    let max = state.eMarks[start];

    if (pos + 2 > max) {
      return false;
    }
    if (state.src.slice(pos, pos + 2) !== "$$") {
      return false;
    }

    pos += 2;
    firstLine = state.src.slice(pos, max);

    if (silent) {
      return true;
    }
    if (firstLine.trim().slice(-2) === "$$") {
      firstLine = firstLine.trim().slice(0, -2);
      found = true;
    }

    for (next = start; !found; ) {
      next++;
      if (next >= end) {
        break;
      }
      pos = state.bMarks[next] + state.tShift[next];
      max = state.eMarks[next];
      if (pos < max && state.tShift[next] < state.blkIndent) {
        break;
      }
      if (state.src.slice(pos, max).trim().slice(-2) === "$$") {
        lastPos = state.src.slice(0, max).lastIndexOf("$$");
        lastLine = state.src.slice(pos, lastPos);
        found = true;
      }
    }

    state.line = next + 1;

    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.content =
      (firstLine && firstLine.trim() ? firstLine + "\n" : "") +
      state.getLines(start + 1, next, state.tShift[start], true) +
      (lastLine && lastLine.trim() ? lastLine : "");
    token.map = [start, state.line];
    token.markup = "$$";
    return true;
  }

  md.inline.ruler.after("escape", "math_inline", math_inline);
  md.block.ruler.after("blockquote", "math_block", math_block, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

  md.renderer.rules.math_inline = (tokens, idx) => {
    try {
      return katex.renderToString(tokens[idx].content, {
        ...opts,
        displayMode: false,
      });
    } catch {
      return tokens[idx].content;
    }
  };

  md.renderer.rules.math_block = (tokens, idx) => {
    try {
      return (
        '<div class="katex-display">' +
        katex.renderToString(tokens[idx].content, {
          ...opts,
          displayMode: true,
        }) +
        "</div>\n"
      );
    } catch {
      return '<pre class="katex-error">' + tokens[idx].content + "</pre>\n";
    }
  };
}
