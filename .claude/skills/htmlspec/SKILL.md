---
name: htmlspec
description: Creates a text-only engineering implementation plan as a single self-contained HTML page saved to specs/<name>.html — the plan authored directly in styled HTML plus a freeform HTML zone where the agent can author any custom HTML/CSS/SVG/JS (inline SVG diagrams, interactive toggles, comparison matrices, decision trees) that aids comprehension. No images are generated; visual richness comes from inline HTML/SVG only. Use when the user says "htmlspec", wants a text-only HTML implementation plan, a browser-openable spec, or a richly-formatted HTML engineering plan without per-section image generation.
argument-hint: "[user prompt]"
---

# htmlspec

## Purpose

Produce an engineering implementation plan as **one self-contained, text-only HTML page** —
`specs/<plan-name>.html` — that you can open directly in a browser. Unlike a markdown spec,
the plan is authored **directly in HTML** using the template below, and a dedicated
**Freeform** zone lets you author any HTML you want (interactive toggles, animated SVG flows,
comparison matrices, decision trees, etc.) to make the plan clearer and richer than prose
could. **No images are generated** — all visual enrichment comes from inline HTML, CSS, SVG,
and JS authored directly into the page.

Phases, in order:

1. **Plan phase** — analyze, explore, design (same thinking as a normal spec).
2. **HTML authoring phase** — write the plan into the **HTML Plan Template**.
3. **Freeform phase** — enrich the page with custom HTML per the **Freeform Instruction Set**.

## Variables

USER_PROMPT: $1
ALL_ARGUMENTS: $ARGUMENTS
PLAN_OUTPUT_DIRECTORY: `specs/`
PLAN_SLUG: kebab-case name derived from the plan topic (e.g. `in-memory-ttl-lru-cache`)
HTML_OUTPUT: `specs/htmlspec-<PLAN_SLUG>.html`  — **the filename MUST always begin with the `htmlspec-` prefix**

## Instructions

### Plan phase

- IMPORTANT: If no `USER_PROMPT` is provided, stop and ask the user to provide it.
- Carefully analyze the USER_PROMPT. Determine task type (chore|feature|refactor|fix|enhancement) and complexity (simple|medium|complex).
- Think deeply (ultrathink) about the best implementation approach.
- Explore the codebase to understand existing patterns and architecture.
- Decide which sections from the HTML Plan Template apply (include the conditional sections only when task type/complexity warrants them, exactly like a normal spec).
- Generate a descriptive kebab-case PLAN_SLUG from the topic.

### HTML authoring phase

- Author the plan **directly in HTML** using the **HTML Plan Template** below — do not write a markdown file. The output is a single `specs/htmlspec-<PLAN_SLUG>.html`.
- Keep the page **self-contained**: all CSS inline in `<style>`, any JS inline in `<script>`, no external network/CDN dependencies unless genuinely required (and if so, note it in Notes).
- Fill every applicable section with real, detailed content — the plan must be implementable by another developer. Use semantic HTML: `<ul>`/`<ol>` for lists, `<table>` for comparisons, `<pre><code>` for code/commands.
- Preserve the dark visual theme defined by the template's CSS tokens so the page reads as one body of work.
- **Do not include any `<figure>`/`<img>` elements** — this skill is text-only.

### Freeform Instruction Set

The HTML Plan Template includes a **Freeform** zone (`<section class="freeform">`). Here — and
anywhere else a visual would help more than prose — you have **full creative latitude to author
any HTML you want**. This is the most valuable part of the page: with no image generation,
freeform is where the plan earns its richness, so **lean into it heavily**.

- **Communicate concrete implementation work.** Freeform is not decoration — it is where another developer learns *exactly* what to build. Encode the things prose makes muddy: file paths to touch, function signatures with full type info, data shapes (request/response/DB rows), the precise sequence of operations, decision points with the chosen branch, edge cases and what happens at each, error/timeout/retry behavior, ordering and concurrency constraints, before/after diffs, migration steps, and any invariants the implementation must preserve. Always prefer specific over abstract — names, types, numbers, paths.
- **Use a wide variety of HTML tags to convey meaning.** Different ideas deserve different shapes. Reach for:
  - `<details>`/`<summary>` for expandable deep-dives, alternative-considered-and-rejected, and FAQ-style "why not X".
  - `<table>` for comparison matrices (option A vs B vs C), API contracts (field · type · required · description), decision matrices (criterion × option), and before/after columns.
  - `<dl>`/`<dt>`/`<dd>` for definitions, glossaries, and field-by-field schema docs.
  - Inline **SVG** for architecture diagrams, data flow, state machines, sequence diagrams, dependency graphs, decision trees, timelines, ER diagrams, and topology maps. SVG is your image substitute — use it liberally.
  - `<pre><code>` blocks (with a language hint) for code snippets, shell sessions, JSON/YAML payloads, SQL, and diffs. Use `<samp>` for expected output and `<kbd>` for keystrokes/commands.
  - `<aside>` (styled as a callout) for warnings, "gotchas", and side notes that would interrupt the main flow.
  - `<mark>` to highlight the critical word/line a reader must not miss.
  - Nested `<ol>` for ordered, branching procedures; nested `<ul>` for grouped checklists.
  - `<figure>` wrapping inline SVG with a `<figcaption>` so the diagram has a citable label.
  - Animated SVG / CSS transitions and tabbed views only where they genuinely make the plan faster to absorb.
- **Self-contained only.** Inline all CSS and JS. Do not pull external scripts/styles/fonts over the network unless truly necessary; if you must, declare it under Notes.
- **Stay on-theme.** Reuse the template's CSS custom properties (`--bg`, `--cyan`, `--amber`, `--red`, `--line`, etc.) so freeform content matches the rest of the page. SVG strokes/fills should use the same palette.
- **Don't break the core plan.** The standard sections must remain present and complete; freeform is additive enrichment, not a replacement.
- **Earn its place.** No decorative filler — every freeform element should make the spec clearer or faster to act on. If an SVG diagram or table would not change what the developer types next, don't include it.

## Workflow

### Phase 1 — Plan
1. THINK HARD: parse the USER_PROMPT; settle task type, complexity, and the architecture.
2. Explore the codebase for patterns and relevant files.
3. Decide the section set and the PLAN_SLUG.

### Phase 2 — Author the HTML
4. Create `specs/` if missing. Write `specs/htmlspec-<PLAN_SLUG>.html` from the **HTML Plan Template**, filling every applicable section with detailed content. Emit no `<figure>`/`<img>` elements — this skill is text-only.

### Phase 3 — Freeform enrichment
5. Author the **Freeform** section and any in-section enrichments per the **Freeform Instruction Set** above — inline SVG/CSS/JS, self-contained, on-theme, additive.

### Phase 4 — Finish
6. Validate the HTML is well-formed (see Validation).
7. Follow the **Report Format**.

## HTML Plan Template

Author the page from this skeleton. Keep the `<head>`/`<style>` block intact (it defines the
shared theme); fill the `{{…}}` slots; drop the conditional sections that don't apply.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Plan: {{TASK_NAME}}</title>
<style>
  :root{
    --bg:#0A0E1A; --panel:#111726; --ink:#F5F5F0; --muted:#9AA4B2;
    --cyan:#22D3EE; --amber:#F59E0B; --red:#EF4444; --line:#1E2A3C;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:48px 24px 96px}
  header.hero{text-align:center;margin-bottom:36px}
  header.hero h1{font-size:2.2rem;margin:0 0 10px;letter-spacing:-.02em}
  .meta{color:var(--muted);font-size:.9rem}
  .badge{display:inline-block;background:var(--cyan);color:#001018;border-radius:999px;
         padding:2px 11px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  section{background:var(--panel);border:1px solid var(--line);border-radius:14px;
          padding:24px 28px;margin:20px 0}
  section>h2{margin:0 0 14px;color:var(--cyan);font-size:1.3rem;
             border-bottom:1px solid var(--line);padding-bottom:10px}
  ul,ol{padding-left:22px}
  li{margin:4px 0}
  table{width:100%;border-collapse:collapse;margin:12px 0}
  th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
  th{background:#0d1422;color:var(--cyan)}
  pre{background:#0d1422;border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
  :not(pre)>code{background:#0d1422;border:1px solid var(--line);border-radius:6px;
                 padding:2px 6px;color:var(--amber)}
  .freeform{border-style:dashed;border-color:var(--cyan)}
  .freeform>h2::after{content:" · author anything that helps";color:var(--muted);
                      font-size:.7rem;font-weight:400;text-transform:none}
  a{color:var(--cyan)}
</style>
</head>
<body>
<div class="wrap">

  <header class="hero">
    <h1>Plan: {{TASK_NAME}}</h1>
    <p class="meta"><span class="badge">{{TASK_TYPE}}</span> &middot; {{COMPLEXITY}}</p>
  </header>

  <section>
    <h2>Task Description</h2>
    {{TASK_DESCRIPTION_HTML}}
  </section>

  <section>
    <h2>Objective</h2>
    {{OBJECTIVE_HTML}}
  </section>

  <!-- include if task_type is feature OR complexity is medium/complex -->
  <section>
    <h2>Problem Statement</h2>
    {{PROBLEM_STATEMENT_HTML}}
  </section>

  <section>
    <h2>Solution Approach</h2>
    {{SOLUTION_APPROACH_HTML}}
  </section>
  <!-- /conditional -->

  <section>
    <h2>Relevant Files</h2>
    {{RELEVANT_FILES_HTML}}  <!-- include an h3 'New Files' list if needed -->
  </section>

  <!-- include if complexity is medium/complex -->
  <section>
    <h2>Implementation Phases</h2>
    {{PHASES_HTML}}  <!-- Phase 1: Foundation / Phase 2: Core / Phase 3: Integration & Polish -->
  </section>
  <!-- /conditional -->

  <section>
    <h2>Step by Step Tasks</h2>
    {{STEPS_HTML}}  <!-- ordered list; foundational first; last step validates the work -->
  </section>

  <!-- include if task_type is feature OR complexity is medium/complex -->
  <section>
    <h2>Testing Strategy</h2>
    {{TESTING_HTML}}
  </section>
  <!-- /conditional -->

  <section>
    <h2>Acceptance Criteria</h2>
    {{ACCEPTANCE_HTML}}  <!-- specific, measurable -->
  </section>

  <section>
    <h2>Validation Commands</h2>
    <pre><code>{{VALIDATION_COMMANDS}}</code></pre>
  </section>

  <!-- FREEFORM ZONE: author ANY self-contained, on-theme HTML/CSS/SVG/JS that aids the plan -->
  <section class="freeform">
    <h2>Freeform</h2>
    {{FREEFORM_HTML}}
  </section>

  <section>
    <h2>Notes</h2>
    {{NOTES_HTML}}  <!-- dependencies (uv add ...), external assets used by freeform, caveats -->
  </section>

</div>
</body>
</html>
```

## Report Format

```markdown
✅ HTML Implementation Plan Created (text-only)

File: specs/htmlspec-<PLAN_SLUG>.html  (open in a browser)
Topic: <brief description of what the plan covers>
Freeform: <one line on what custom HTML you added, if any>

Key Components:
- <main component 1>
- <main component 2>
- <main component 3>

Open with: open specs/htmlspec-<PLAN_SLUG>.html
```

## Validation

```bash
# file exists and is non-trivial HTML
test -s specs/htmlspec-<PLAN_SLUG>.html && head -1 specs/htmlspec-<PLAN_SLUG>.html | grep -qi '<!DOCTYPE html>' && echo "HTML ok"
# text-only: no <img> tags should be present
! grep -q '<img ' specs/htmlspec-<PLAN_SLUG>.html && echo "text-only ok"
```
