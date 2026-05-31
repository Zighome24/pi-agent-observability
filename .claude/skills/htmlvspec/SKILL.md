---
name: htmlvspec
description: Creates a visual engineering implementation plan as a single self-contained HTML page saved to specs/<name>.html — the plan authored directly in styled HTML, with one AI-generated diagram image per section (hero + per major H2) generated in parallel and embedded inline, plus a freeform HTML zone for custom HTML/CSS/SVG/JS that aids comprehension. Images are always generated. Use when the user says "htmlvspec", wants a visual/illustrated HTML implementation plan, a browser-openable spec with per-section diagrams, or any HTML plan where images are required.
argument-hint: "[user prompt]"
---

# htmlvspec

## Purpose

Produce a **visual** engineering implementation plan as **one self-contained HTML page** —
`specs/<plan-name>.html` — that you can open directly in a browser. The plan is authored
**directly in HTML** using the template below, with **one AI-generated diagram image per
section** (hero + per major H2) generated in parallel and embedded inline, and a dedicated
**Freeform** zone that lets you author any HTML you want (interactive toggles, animated SVG
flows, comparison matrices, decision trees, etc.) to make the plan clearer and richer than
prose could.

Phases, in order:

1. **Plan phase** — analyze, explore, design (same thinking as a normal spec).
2. **HTML authoring phase** — write the plan into the **HTML Plan Template**.
3. **Image phase** — generate one diagram per section in **parallel** and embed them inline.
4. **Freeform phase** — enrich the page with custom HTML per the **Freeform Instruction Set**.

## Variables

USER_PROMPT: $1
ALL_ARGUMENTS: $ARGUMENTS
PLAN_OUTPUT_DIRECTORY: `specs/`
PLAN_SLUG: kebab-case name derived from the plan topic (e.g. `in-memory-ttl-lru-cache`)
HTML_OUTPUT: `specs/htmlvspec-<PLAN_SLUG>.html`  — **the filename MUST always begin with the `htmlvspec-` prefix**
IMAGE_DIR: `specs/htmlvspec-<PLAN_SLUG>/`  — sibling directory matching the HTML filename (same `htmlvspec-` prefix)
IMAGE_GENERATOR: `~/.claude/skills/htmlvspec/scripts/generate_image.py`
IMAGE_SIZE: `2048x1152` (wide 16:9 by default)
IMAGE_QUALITY: `high`
HERO_IMAGE_NAME: `00-hero.png`
MAX_TEXT_LABELS_PER_IMAGE: 10
MAX_TOTAL_IMAGES: 10

## Instructions

### Plan phase

- IMPORTANT: If no `USER_PROMPT` is provided, stop and ask the user to provide it.
- Carefully analyze the USER_PROMPT. Determine task type (chore|feature|refactor|fix|enhancement) and complexity (simple|medium|complex).
- Think deeply (ultrathink) about the best implementation approach.
- Explore the codebase to understand existing patterns and architecture.
- Decide which sections from the HTML Plan Template apply (include the conditional sections only when task type/complexity warrants them, exactly like a normal spec).
- Generate a descriptive kebab-case PLAN_SLUG from the topic.

### HTML authoring phase

- Author the plan **directly in HTML** using the **HTML Plan Template** below — do not write a markdown file. The output is a single `specs/htmlvspec-<PLAN_SLUG>.html`.
- Keep the page **self-contained**: all CSS inline in `<style>`, any JS inline in `<script>`, no external network/CDN dependencies unless genuinely required (and if so, note it in Notes).
- Fill every applicable section with real, detailed content — the plan must be implementable by another developer. Use semantic HTML: `<ul>`/`<ol>` for lists, `<table>` for comparisons, `<pre><code>` for code/commands.
- Preserve the dark visual theme defined by the template's CSS tokens so the page and the generated diagrams read as one body of work.
- Include the template's `<figure>`/`<img>` slots for the hero and every section that benefits from a diagram.

### Image phase

- **Always generate images** — this is the defining feature of this skill; skipping the image phase is a defect. At minimum generate the hero **plus** one image for every major section in the template that survives (Solution Approach, Implementation Phases, plus any section whose ideas are inherently spatial — architecture, data model, sequence, state).
- **Be liberal, not stingy.** A section benefits from a generated image whenever the underlying concept is spatial, structural, temporal, or topological — architecture views, data/control flow, request lifecycles, state machines, queue/worker topology, deployment layout, module boundaries, fan-out/fan-in, before/after system shapes. When in doubt, generate one. The only hard ceiling is **MAX_TOTAL_IMAGES (10)**; the soft floor is "hero + every major section".
- Generate **at most one** image per section header (no duplicates within a section). Cap total images at **MAX_TOTAL_IMAGES (10) or fewer**.
- Each image is a **picture, not a document**: emphasize architecture, nodes, components, communication/data flow, state transitions — the structure and meaning. **No more than MAX_TEXT_LABELS_PER_IMAGE (10) text labels** per image; list the exact labels in the prompt and state they are the complete set. Fine-grained detail (field types, function signatures, code) belongs in freeform HTML, not in the generated picture.
- All images share **one visual language**: write a shared style brief once (palette hex codes matching the page's CSS tokens, background, line weight, node/arrow conventions, recurring-element color/shape mapping, full negation list) and prepend it **verbatim** to every prompt.
- Use the bundled generator at IMAGE_GENERATOR. **Do not call, reference, or depend on any other image skill** — this skill is fully self-contained.
- **Generate every image in parallel — this is mandatory, not a suggestion.** Each `generate_image.py` call takes many seconds (often 20–60s). Running N images sequentially costs N × that latency; running them in parallel costs ~1× that latency. There is **no reason to wait for one image to finish before starting the next** — the calls are independent. Fire them all at once as background bash jobs in a single shell (`uv run "$GEN" ... &` per image, then a single `wait`), or as multiple Bash tool calls in the same turn. **Never** generate them one after another. Sequential generation is the single biggest thing that makes this skill slow and is treated as a defect.
- Embed each image inline in its section with `<figure><img src="htmlvspec-<PLAN_SLUG>/NN-section.png" alt="..."><figcaption>…</figcaption></figure>` using a **relative** path (the `.html` file and its image folder travel together, both carrying the `htmlvspec-` prefix).

### Freeform Instruction Set

The HTML Plan Template includes a **Freeform** zone (`<section class="freeform">`). Here — and
anywhere else a visual would help more than prose — you have **full creative latitude to author
any HTML you want**. Freeform is additive on top of the generated images; it uses inline
HTML/SVG, not generated images. **Lean into freeform** — even with per-section images, the
fine-grained implementation detail lives here.

- **Communicate concrete implementation work.** Freeform is not decoration — it is where another developer learns *exactly* what to build. The generated images convey the **shape** of the system; freeform conveys the **specifics**: file paths to touch, function signatures with full type info, data shapes (request/response/DB rows), the precise sequence of operations, decision points with the chosen branch, edge cases and what happens at each, error/timeout/retry behavior, ordering and concurrency constraints, before/after diffs, migration steps, and any invariants the implementation must preserve. Always prefer specific over abstract — names, types, numbers, paths.
- **Use a wide variety of HTML tags to convey meaning.** Different ideas deserve different shapes. Reach for:
  - `<details>`/`<summary>` for expandable deep-dives, alternative-considered-and-rejected, and FAQ-style "why not X".
  - `<table>` for comparison matrices (option A vs B vs C), API contracts (field · type · required · description), decision matrices (criterion × option), and before/after columns.
  - `<dl>`/`<dt>`/`<dd>` for definitions, glossaries, and field-by-field schema docs.
  - Inline **SVG** for fine-grained diagrams that complement (not duplicate) the section's generated image — sequence diagrams, state machines, ER diagrams, decision trees, mini-timelines, callout overlays.
  - `<pre><code>` blocks (with a language hint) for code snippets, shell sessions, JSON/YAML payloads, SQL, and diffs. Use `<samp>` for expected output and `<kbd>` for keystrokes/commands.
  - `<aside>` (styled as a callout) for warnings, "gotchas", and side notes that would interrupt the main flow.
  - `<mark>` to highlight the critical word/line a reader must not miss.
  - Nested `<ol>` for ordered, branching procedures; nested `<ul>` for grouped checklists.
  - `<figure>` wrapping inline SVG with a `<figcaption>` so the diagram has a citable label.
  - Animated SVG / CSS transitions and tabbed views only where they genuinely make the plan faster to absorb.
- **Don't duplicate the section image.** If the generated `<figure>` already shows the architecture, the freeform SVG/table should drill *deeper* (e.g. the image shows services and arrows; freeform shows the wire format on each arrow).
- **Self-contained only.** Inline all CSS and JS. Do not pull external scripts/styles/fonts over the network unless truly necessary; if you must, declare it under Notes.
- **Stay on-theme.** Reuse the template's CSS custom properties (`--bg`, `--cyan`, `--amber`, `--red`, `--line`, etc.) so freeform content matches the rest of the page **and** the generated images. SVG strokes/fills should use the same palette as both.
- **Don't break the core plan.** The standard sections must remain present and complete; freeform is additive enrichment, not a replacement.
- **Earn its place.** No decorative filler — every freeform element should make the spec clearer or faster to act on. If an SVG diagram or table would not change what the developer types next, don't include it.

## Workflow

### Phase 1 — Plan
1. THINK HARD: parse the USER_PROMPT; settle task type, complexity, and the architecture.
2. Explore the codebase for patterns and relevant files.
3. Decide the section set and the PLAN_SLUG.

### Phase 2 — Author the HTML
4. Create `specs/` if missing. Write `specs/htmlvspec-<PLAN_SLUG>.html` from the **HTML Plan Template**, filling every applicable section with detailed content. Leave the section `<figure>` slots pointing at `htmlvspec-<PLAN_SLUG>/NN-*.png` — those files are generated in the next phase.

### Phase 3 — Generate images in parallel
5. **Prerequisite key check**:
   ```bash
   ( [ -n "$OPENAI_API_KEY" ] || grep -q OPENAI_API_KEY .env 2>/dev/null ) && echo "OPENAI_API_KEY found" || echo "OPENAI_API_KEY missing"
   ```
   The generator reads `OPENAI_API_KEY` from the environment or a `.env` in the current working directory. If missing, stop and ask the user to set it.
6. Write the **shared style brief** once. Draft a per-image prompt for the hero + each section image (style is global, composition is local; ≤10 labels each).
7. **Fire every image at once — in parallel.** Each call takes many seconds; running them sequentially wastes minutes for no reason. There are two acceptable parallel patterns; **pick one and execute it in a single tool call/turn**.

   **Pattern A — one Bash call, every image as a background job, then `wait`:**
   ```bash
   GEN=~/.claude/skills/htmlvspec/scripts/generate_image.py
   DIR=specs/htmlvspec-<PLAN_SLUG>     # matches the htmlvspec- prefix of the .html file
   uv run "$GEN" "<brief + hero composition>"      "$DIR/00-hero.png" &
   uv run "$GEN" "<brief + section-1 composition>" "$DIR/01-solution-approach.png" &
   uv run "$GEN" "<brief + section-2 composition>" "$DIR/02-architecture.png" &
   uv run "$GEN" "<brief + section-3 composition>" "$DIR/03-data-model.png" --size 1024x1024 &
   wait
   echo "all images done"
   ```
   The trailing `&` puts each job in the background so they all start immediately; `wait` blocks until they're all done. The generator creates parent dirs itself, so every job can start simultaneously.

   **Pattern B — N parallel Bash tool calls in a single message.** If you can issue multiple tool calls in one turn, dispatch each `generate_image.py` as its own Bash call in the same message. The tool harness runs them concurrently — same effect as Pattern A.

   **Anti-pattern (do not do this):** issuing one Bash call, waiting for it to return, then issuing the next. That is sequential and forbidden here. If you find yourself about to do that, stop and switch to Pattern A or B.

   `wide` (2048x1152) is the default; pass `--size 1024x1024`/`1152x2048` only when a section needs square/tall.
8. After `wait`, verify each PNG exists and is non-empty. Regenerate any failed section image (a single background job is fine). If the **hero** failed, stop and report.

### Phase 4 — Freeform enrichment
9. Author the **Freeform** section and any in-section enrichments per the **Freeform Instruction Set** above — inline SVG/CSS/JS, self-contained, on-theme, additive.

### Phase 5 — Finish
10. Confirm the `<img>` `src` paths are **relative** and match the generated filenames. Validate the HTML is well-formed (see Validation).
11. Follow the **Report Format**.

## HTML Plan Template

Author the page from this skeleton. Keep the `<head>`/`<style>` block intact (it defines the
shared theme); fill the `{{…}}` slots; drop the conditional sections that don't apply. Every
`<figure>` block stays — each section gets its diagram.

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
  figure{margin:18px 0 0}
  figure img{width:100%;display:block;border:1px solid var(--line);border-radius:10px}
  figcaption{color:var(--muted);font-size:.8rem;margin-top:6px;text-align:center}
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
    <figure>
      <img src="htmlvspec-{{PLAN_SLUG}}/00-hero.png" alt="Visual overview — {{TASK_NAME}}">
      <figcaption>System overview</figcaption>
    </figure>
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
    <figure><img src="htmlvspec-{{PLAN_SLUG}}/01-solution-approach.png" alt="Solution approach"></figure>
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
    <figure><img src="htmlvspec-{{PLAN_SLUG}}/02-phases.png" alt="Implementation phases"></figure>
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
✅ Visual HTML Implementation Plan Created

File: specs/htmlvspec-<PLAN_SLUG>.html  (open in a browser)
Topic: <brief description of what the plan covers>
Images: <count succeeded> / <count attempted> in specs/htmlvspec-<PLAN_SLUG>/
Freeform: <one line on what custom HTML you added, if any>

Key Components:
- <main component 1>
- <main component 2>
- <main component 3>

Open with: open specs/htmlvspec-<PLAN_SLUG>.html
```

## Validation

```bash
# file exists and is non-trivial HTML
test -s specs/htmlvspec-<PLAN_SLUG>.html && head -1 specs/htmlvspec-<PLAN_SLUG>.html | grep -qi '<!DOCTYPE html>' && echo "HTML ok"
# every <img src> file exists; paths relative; no prompt used more than 10 labels
```
