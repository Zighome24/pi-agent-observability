import { marked, type TokenizerAndRendererExtension } from "marked";

/**
 * Inline extension: turn an @artifact-ref into a clickable button that the
 * chat pane delegates clicks from (see onRefClick in App.vue). Registered once
 * at module load so every parse picks it up. Runs as an inline tokenizer, so it
 * never fires inside code spans / fenced blocks (marked extracts those first).
 */
const artifactRef: TokenizerAndRendererExtension = {
  name: "artifactRef",
  level: "inline",
  start(src: string) {
    const i = src.indexOf("@");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^@([a-zA-Z0-9_-]+)/.exec(src);
    if (!m) return undefined;
    return { type: "artifactRef", raw: m[0], ref: m[1] };
  },
  renderer(token: any) {
    return `<button type="button" class="ref" data-ref="${token.ref}">@${token.ref}</button>`;
  },
};

marked.use({
  gfm: true,
  breaks: true,
  extensions: [artifactRef],
  renderer: {
    // Inline citations from the agent should open in a new tab, not navigate
    // away from the run. Preserve nested inline formatting via the parser.
    link(this: any, token: any) {
      const href = String(token.href ?? "");
      const safeHref = /^https?:\/\//i.test(href) ? href : "#";
      const text = token.tokens ? this.parser.parseInline(token.tokens) : (token.text ?? safeHref);
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

/** Render agent markdown (with @ref buttons) to an HTML string for v-html. */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  return marked.parse(text, { async: false }) as string;
}
