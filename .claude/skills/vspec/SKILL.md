---
name: vspec
description: Creates a concise engineering implementation plan saved to specs/, then generates one information-rich, thematically-consistent diagram image per section (hero + per-H2) to aid planning of the engineering work. Use when the user says "vspec", asks for a visual/illustrated implementation plan, a spec with diagrams, or wants an engineering plan whose sections are each backed by an architecture/flow/data-model image.
argument-hint: "[user prompt]"
---

# vspec

## Purpose

Produce a written engineering implementation plan, then add a
visual layer: a hero image plus one diagram per section. Each image is an
information-rich, compressed, *visual* artifact — architecture, nodes, communication
flow, data models, lifecycles — not a rendered wall of text. The images are
thematically consistent across the whole spec and are linked back into the markdown so
the plan reads like an illustrated blueprint.

Two phases, in order:

1. **Plan phase** — build and save the raw markdown plan.
2. **Image phase** — after the plan exists, generate and embed one image per section.

The image phase **always runs after** the raw plan is written.

## Variables

USER_PROMPT: $1
ALL_ARGUMENTS: $ARGUMENTS
PLAN_OUTPUT_DIRECTORY: `specs/`
IMAGE_GENERATOR: `~/.claude/skills/vspec/scripts/generate_image.py`
IMAGE_SIZE: `2048x1152` (wide 16:9 by default)
IMAGE_QUALITY: `high`
OUTPUT_IMAGE_FORMAT: `png`
HERO_IMAGE_NAME: `00-hero.png`
MAX_TEXT_LABELS_PER_IMAGE: 10
IMAGE_MARKER_PREFIX: `vspec`

## Instructions

### Plan phase

- IMPORTANT: If no `USER_PROMPT` is provided, stop and ask the user to provide it.
- Carefully analyze the user's requirements provided in the USER_PROMPT variable.
- Determine the task type (chore|feature|refactor|fix|enhancement) and complexity (simple|medium|complex).
- Think deeply (ultrathink) about the best approach to implement the requested functionality or solve the problem.
- Explore the codebase to understand existing patterns and architecture.
- Follow the **Plan Format** below to create a comprehensive implementation plan.
- Include all required sections and conditional sections based on task type and complexity.
- Generate a descriptive, kebab-case filename based on the main topic of the plan.
- Save the complete implementation plan to `PLAN_OUTPUT_DIRECTORY/<descriptive-name>.md`.
- Ensure the plan is detailed enough that another developer could follow it to implement the solution.
- Include code examples or pseudo-code where appropriate to clarify complex concepts.
- Consider edge cases, error handling, and scalability concerns.

### Image phase (the vspec addition)

- Run the image phase **only after** the markdown plan is fully written and saved.
- Generate exactly one **hero** image for the whole plan, plus one image **per `## ` (H2) section** that materially benefits from a visual. Skip purely administrative sections (e.g. "Notes", "Validation Commands") unless a visual genuinely aids comprehension.
- Keep the total image count to **10 or fewer** image targets. If there are more than ~9 H2 sections, merge or pick the sections where a diagram adds the most planning value.
- Each image is a **picture, not a document**. Visually emphasize the architecture, the nodes, the components, the communication/data flow, the state transitions — the *structure and meaning*, not prose.
- Each image prompt must contain **no more than MAX_TEXT_LABELS_PER_IMAGE (10) text labels**. Treat each label as one "set of words". List the exact label strings explicitly in the prompt and tell the model these are the complete set with no other words. Never ask the model to render paragraphs, captions, code blocks, or lorem ipsum.
- All images in one spec must share **one visual language**: same palette (with hex codes), background, line weight, typography, node/arrow style, and the same negation list. Write the shared style brief once and prepend it **verbatim** to every image prompt — do not paraphrase between images, or the set will drift.
- Assign recurring elements (e.g. "client", "cache", "store", "queue") a fixed color + shape across all images so the same concept looks the same in every diagram.
- Use the bundled generator at IMAGE_GENERATOR for every image. **Do not call, reference, or depend on any other image skill** — this skill is fully self-contained.
- **Generate the images in parallel, never one at a time.** Each image is an independent gpt-image-2 call that takes many seconds; firing them sequentially is the single biggest thing that makes this skill slow. Launch them all concurrently — background bash jobs in one shell with `wait`, or parallel Bash tool calls in a single turn.
- Default to wide `2048x1152`; use `1024x1024` (square) or `1152x2048` (tall) only when a section's diagram clearly needs it (e.g. a tall lifecycle, a square matrix).
- Save images beside the plan in a same-named subdirectory and insert idempotent markdown references back into the plan.

## Workflow

### Phase 1 — Build the plan

1. **Analyze Requirements** — THINK HARD and parse the USER_PROMPT to understand the core problem and desired outcome.
2. **Explore Codebase** — Understand existing patterns, architecture, and relevant files.
3. **Design Solution** — Develop the technical approach including architecture decisions and implementation strategy.
4. **Document Plan** — Structure a comprehensive markdown document following the Plan Format.
5. **Generate Filename** — Create a descriptive kebab-case filename based on the plan's main topic (e.g. `in-memory-ttl-lru-cache`).
6. **Save Plan** — Write the plan to `PLAN_OUTPUT_DIRECTORY/<filename>.md`.

### Phase 2 — Generate the visual layer

7. **Prerequisite key check** — Verify the OpenAI key is available before generating anything:
   ```bash
   ( [ -n "$OPENAI_API_KEY" ] || grep -q OPENAI_API_KEY .env 2>/dev/null ) && echo "OPENAI_API_KEY found" || echo "OPENAI_API_KEY missing"
   ```
   The generator reads `OPENAI_API_KEY` from the environment or a `.env` in the current working directory. If the key is missing, stop and ask the user to set it.

8. **Create the image directory** — Beside the plan, using the plan basename without extension:
   - `specs/in-memory-ttl-lru-cache.md` → `specs/in-memory-ttl-lru-cache/`
   - Create it if missing.

9. **Re-read the saved plan** and extract: the H1 title, every `## ` H2 section and its content, and any architecture/protocol/flow/state/data-model details that suggest a diagram type.

10. **Select image targets** (≤ 10 total):
    - One hero target for the whole plan.
    - One target per H2 section that benefits from a visual. Prefer sections describing architecture, solution approach, data flow, lifecycle, phases, data model, testing strategy, or acceptance criteria.
    - Choose the diagram type per target: architecture map, dataflow, sequence, lifecycle timeline, swimlane, state machine, matrix, dependency map, or data model.

11. **Write the shared style brief once.** One paragraph that locks: visual register (clean vector technical diagram, dark documentation aesthetic), exact palette hex codes, background, line weight, typography feel, node/arrow conventions, the recurring-element color/shape mapping, and the full negation list (NO 3D, NO photoreal, NO decorative filler, NO icons except as labeled, NO paragraphs/captions). This paragraph is prepended **verbatim** to every prompt.

12. **Draft per-image prompts** using the brief + this pattern (style is global, composition is local):
    ```text
    [SHARED STYLE BRIEF — identical in every prompt]

    Purpose: [what this one image communicates].
    Composition: [specific spatial layout — left/right, top/bottom, central hub, layers, timeline, arrows].
    Visual elements: [nodes, arrows, containers, badges, lanes] and how they connect.
    Exact text labels, complete set, no other words: "Label 1", "Label 2", ... (max 10).
    Output role: technical spec illustration embedded in markdown.
    ```

13. **Generate ALL images in parallel** with the bundled generator, using deterministic filenames (`00-hero.png`, `01-<section-slug>.png`, `02-<section-slug>.png`, …). The image calls are independent and each takes many seconds — do **not** run them one after another.

    **Primary method — parallel bash calls.** Fire every `generate_image.py` call at once as background jobs in a single shell invocation, then `wait` for all of them:
    ```bash
    GEN=~/.claude/skills/vspec/scripts/generate_image.py
    DIR=specs/<plan-name>
    uv run "$GEN" "<shared brief + hero composition>"      "$DIR/00-hero.png" &
    uv run "$GEN" "<shared brief + section-1 composition>" "$DIR/01-architecture.png" &
    uv run "$GEN" "<shared brief + section-2 composition>" "$DIR/02-lifecycle.png" &
    uv run "$GEN" "<shared brief + section-3 composition>" "$DIR/03-data-model.png" --size 1024x1024 &
    wait   # block until every image finishes
    echo "all images done"
    ```
    The bundled generator creates parent directories itself, so every job can start simultaneously. `wide` (2048x1152) is the default; append `--size 1024x1024` (or `1152x2048`) only for a section that needs square/tall.

    Equivalently, if you can issue multiple tool calls in one turn, run each `generate_image.py` as a **separate Bash tool call in the same message** so they execute concurrently. For very large sets you may also split the batch across subagents — but the default and simplest path is parallel background jobs in one shell.

    - After `wait`, verify every file exists and is non-empty. If a section image failed, regenerate just that one (a single background job is fine). If the **hero** image failed, stop and report.

14. **Insert markdown references** into the plan using idempotent HTML markers, so re-running vspec replaces rather than duplicates. Use relative paths from the plan file. Preserve all existing prose and heading order.

    Hero (after frontmatter and the first H1/title):
    ```markdown
    <!-- vspec:hero -->
    ![Visual overview — <PLAN_TITLE>](<plan-name>/00-hero.png)
    <!-- /vspec:hero -->
    ```
    Section (immediately after its H2 heading, before the section prose):
    ```markdown
    <!-- vspec:image <section-slug> -->
    ![Visual — <SECTION_TITLE>](<plan-name>/01-section.png)
    <!-- /vspec:image <section-slug> -->
    ```

15. **Write a manifest** at `specs/<plan-name>/vspec-manifest.md` containing: source plan path, timestamp, each target's section/filename/labels/full prompt, and success/failure status — so the set is repeatable.

16. **Verify**: every referenced image exists, all references are relative and point inside the image dir, no prompt used more than 10 labels, and the manifest exists. Then follow the **Report Format**.

## Plan Format

Follow this format when creating implementation plans:

```md
# Plan: <task name>

## Task Description
<describe the task in detail based on the prompt>

## Objective
<clearly state what will be accomplished when this plan is complete>

<if task_type is feature or complexity is medium/complex, include these sections:>
## Problem Statement
<clearly define the specific problem or opportunity this task addresses>

## Solution Approach
<describe the proposed solution approach and how it addresses the objective>
</if>

## Relevant Files
Use these files to complete the task:

<list files relevant to the task with bullet points explaining why. Include new files to be created under an h3 'New Files' section if needed>

<if complexity is medium/complex, include this section:>
## Implementation Phases
### Phase 1: Foundation
<describe any foundational work needed>

### Phase 2: Core Implementation
<describe the main implementation work>

### Phase 3: Integration & Polish
<describe integration, testing, and final touches>
</if>

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

<list step by step tasks as h3 headers with bullet points. Start with foundational changes then move to specific changes. Last step should validate the work>

### 1. <First Task Name>
- <specific action>
- <specific action>

### 2. <Second Task Name>
- <specific action>
- <specific action>

<continue with additional tasks as needed>

<if task_type is feature or complexity is medium/complex, include this section:>
## Testing Strategy
<describe testing approach, including unit tests and edge cases as applicable>
</if>

## Acceptance Criteria
<list specific, measurable criteria that must be met for the task to be considered complete>

## Validation Commands
Execute these commands to validate the task is complete:

<list specific commands to validate the work. Be precise about what to run>
- Example: `uv run python -m py_compile apps/*.py` - Test to ensure the code compiles

## Notes
<optional additional context, considerations, or dependencies. If new libraries are needed, specify using `uv add`>
```

## Report Format

```markdown
✅ Visual Implementation Plan Created

Plan: specs/<filename>.md
Topic: <brief description of what the plan covers>
Images: <count succeeded> / <count attempted> in specs/<plan-name>/
Manifest: specs/<plan-name>/vspec-manifest.md

Key Components:
- <main component 1>
- <main component 2>
- <main component 3>

Images
| Type    | Section        | File                                   | Labels |
| ------- | -------------- | -------------------------------------- | ------ |
| Hero    | Whole plan     | `<plan-name>/00-hero.png`              | <n>    |
| Section | <heading>      | `<plan-name>/01-section.png`           | <n>    |

Notes
- <any skipped sections and why>
- <any failed images and the error>
```
