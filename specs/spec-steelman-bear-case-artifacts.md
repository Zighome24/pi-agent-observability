# Plan: Steelman Bear-Case Artifacts Expansion

## Task Description
Expand the Investment Steelman Agent's visual vocabulary by introducing a family of three new typography-forward and highly-visual artifact types:
1. **Quote Artifact (`quote`)**: A typography-forward callout rendering exact lines from earnings calls, short-seller reports, or regulatory filings, with a large quote mark, italicized quote, metadata, and an inline clickable source link.
2. **Catalyst Timeline Artifact (`catalyst-timeline`)**: A left-to-right chronological event plot that maps dated drivers (e.g. covenant breaches, earnings misses) and color-codes each event by severity (`bull`, `neutral`, `bear`) to visualize domino-style business pacing.
3. **Valuation Gauge Artifact (`valuation-gauge`)**: A single horizontal range bar mapping target pricing boundaries (`bear`, `base`, `bull`) against a prominent indicator showing "where it trades today" to instantly reveal whether an asset is priced for perfection or pricing in a bear case.

## Objective
When the Investment Steelman agent runs, it can emit and reference three new artifact types (`quote`, `catalyst-timeline`, `valuation-gauge`) to render rich, interactive data on the left panel that coordinates seamlessly with the text analysis on the right panel.

## Problem Statement
While the current Steelman agent provides high-quality charts and matrices (e.g., bar charts, pie charts, trend lines, scorecards, and risk maps), the bear case often turns on specific corporate admissions (exact quotes), a sequence of dated trigger events (a timeline of catalysts), or a stock's current price position relative to valuation boundaries. Explaining these concepts in prose in the chat pane forces the user to reconstruct data mentally, which dilutes the impact of the bear thesis. Adding these three native visual primitives will make the bear case land faster, harder, and with indisputable proof.

## Solution Approach
1. **Tool Definition (`steelman-product.ts`)**: Expand the registered `steelman_emit_artifact` tool's schema to include `"quote"`, `"catalyst-timeline"`, and `"valuation-gauge"` as valid `ArtifactKind` options.
2. **System Prompt (`STEELMAN_AGENT_SYSTEM_PROMPT.md`)**: Instruct the model on when and how to leverage these new artifacts, detailing the exact JSON payloads required for `data` so the agent consistently formats them.
3. **App Schema & Types (`server.ts`, `App.vue`)**: Update backend and frontend TypeScript union definitions of `ArtifactKind` to accommodate the new types.
4. **Interactive UI Components (`App.vue`)**: Write custom Vue renderers inside the tab-viewer layout for each new type, ensuring they leverage existing dark-theme design tokens, compute exact timeline coordinate positions, and render valuation gradients.
5. **Theme-native Styling (`style.css`)**: Write elegant, fully-responsive CSS selectors for quote bubbles, timeline tracks, node badges, horizontal gauges, and glowing pins.

---

## Relevant Files

### Existing Files
* **`apps/steelman/extension/steelman-product.ts`**: The Pi product extension registering the `steelman_emit_artifact` tool. Needs schema updates.
* **`apps/steelman/extension/STEELMAN_AGENT_SYSTEM_PROMPT.md`**: The system prompt injected into the Investment Steelman Agent. Needs instructions for emitting the new artifacts.
* **`apps/steelman/server/src/server.ts`**: Bun backend server for managing SSE streams, runs, and artifacts. Needs `ArtifactKind` type definition updates.
* **`apps/steelman/web/src/App.vue`**: Frontend Vite Vue-TS UI. Needs type definition updates, reactive data parsing computation, and template rendering logic.
* **`apps/steelman/web/src/style.css`**: App style definition. Needs layout styling rules for the three new components.
* **`apps/steelman/scripts/validate-steelman.ts`**: The smoke-test validation script. Needs schema updates so assertions accept the new artifact kinds.

---

## Implementation Phases

### Phase 1: Foundation (Type & Tool Expansion)
Enable the tool and servers to recognize and validate the new artifact kinds (`quote`, `catalyst-timeline`, `valuation-gauge`). Specify exact structures the agent is expected to output.

### Phase 2: Core Implementation (Frontend Renderers & Layout)
Develop the custom Vue templates inside `App.vue` for each artifact. Build mathematics/computations to scale price points inside the valuation gauge and correctly space out timeline markers.

### Phase 3: Integration & Polish (CSS & Prompt Tuning)
Apply high-grade CSS in `style.css` matching the dark-theme aesthetic, with hovering/focus animations. Update the system prompt so the Steelman Agent actively generates these visual tools during new analysis runs.

---

## Step by Step Tasks

### 1. Extend Core Schemas and Backend Types
- Edit `apps/steelman/extension/steelman-product.ts` to add `"quote"`, `"catalyst-timeline"`, and `"valuation-gauge"` to the `ArtifactKind` typebox definition:
  ```typescript
  const ArtifactKind = Type.Union([
    Type.Literal("text"),
    Type.Literal("table"),
    Type.Literal("bar-chart"),
    Type.Literal("pie-chart"),
    Type.Literal("html"),
    Type.Literal("trend"),
    Type.Literal("scorecard"),
    Type.Literal("risk-map"),
    Type.Literal("quote"),
    Type.Literal("catalyst-timeline"),
    Type.Literal("valuation-gauge"),
  ]);
  ```
- Edit `apps/steelman/server/src/server.ts` to include the three new strings in the `ArtifactKind` TypeScript union:
  ```typescript
  type ArtifactKind = "text" | "table" | "bar-chart" | "pie-chart" | "html" | "trend" | "scorecard" | "risk-map" | "quote" | "catalyst-timeline" | "valuation-gauge";
  ```
- Edit `apps/steelman/web/src/App.vue` to update its local `ArtifactKind` type helper definition matching the backend.

### 2. Instruct the LLM in System Prompt
- Edit `apps/steelman/extension/STEELMAN_AGENT_SYSTEM_PROMPT.md` under the visual communication bullet to add specifications and structural contracts for the new kinds:
  - **`quote`**: Large typography-forward callout.
    - `data` shape: `{ quote: string, speaker: string, role: string, date: string, url: string, sourceName: string, commentary: string }`
  - **`catalyst-timeline`**: Horizontal timeline representing chains of triggers.
    - `data` shape: `Array<{ label: string, date: string, severity: "bull" | "neutral" | "bear", description?: string }>`
  - **`valuation-gauge`**: Price comparison range bar.
    - `data` shape: `{ current: number, bear: number, base: number, bull: number, currency?: string }`

### 3. Build Quote Artifact UI Component
- Add custom HTML template layout inside the main `selectedArtifact` switch block of `apps/steelman/web/src/App.vue`:
  - Render a large absolute styled quotation mark `“` as a background layer.
  - Render the quote block in italic with a prominent font.
  - Render the small attribution block beneath showing the speaker, role, date, and a clickable inline link `<a>` with target `_blank`.
  - Render a secondary `quote-commentary` block for the analytical bear explanation if provided.

### 4. Build Catalyst Timeline UI Component
- Add custom HTML template layout inside the `selectedArtifact` switch block of `apps/steelman/web/src/App.vue`:
  - Render a container `.timeline-container` that supports horizontal overflow scrolling.
  - Draw a relative horizontal line `.timeline-track` in the background.
  - Map each node in `selectedArtifact.data` into `.timeline-node`.
  - Color-code the circle markers `.node-marker` based on `node.severity` (`bull` -> green, `neutral` -> blue/yellow, `bear` -> red).
  - Print the date, label, and description vertically stacked centered beneath the marker.

### 5. Build Valuation Gauge UI Component
- Add helper method `valuationGaugeData` in `apps/steelman/web/src/App.vue` to dynamically compute price percentages:
  - Find `minVal` (lowest price in the set * 0.9) and `maxVal` (highest price * 1.1).
  - Calculate `pctBear`, `pctBase`, `pctBull`, and `pctCurrent` mapped on a scale from 0 to 100.
- Add custom HTML template layout inside the `selectedArtifact` switch of `apps/steelman/web/src/App.vue`:
  - Render a relative container with a background gradient bar `.gauge-track` shifting from `var(--red)` to `var(--yellow)` to `var(--green)`.
  - Render vertical tick indicators `.gauge-marker` for Bear, Base, and Bull at their computed percentages.
  - Render a distinct glowing downward indicator pin `.gauge-current-indicator` showing "Trades Today".
  - Add text interpreting whether the asset is currently priced for perfection or pricing in substantial bear risk.

### 6. Create Theme-native Styles
- Edit `apps/steelman/web/src/style.css` to add clean styling rules matching the dark-theme aesthetic:
  - **Quote layout**: typography-forward spacing, high contrast quote texts, subtle borders for commentary boxes.
  - **Timeline layout**: horizontal overflow handling (`-webkit-overflow-scrolling: touch`), subtle pulse/glow on node severity colors.
  - **Gauge layout**: absolute positioning markers, vertical labels that do not collide, glowing triangles for the "current price" marker, custom tooltips/boxes.

### 7. Update Smoke-Test Validator
- Edit `apps/steelman/scripts/validate-steelman.ts` to include `"quote"`, `"catalyst-timeline"`, and `"valuation-gauge"` inside the assertion list for valid artifacts:
  ```typescript
  assert(snapshot.artifacts.every((a: any) => ["table", "bar-chart", "pie-chart", "text", "html", "trend", "scorecard", "risk-map", "quote", "catalyst-timeline", "valuation-gauge"].includes(a.kind)), "valid artifact kinds emitted");
  ```

---

## Testing Strategy
1. **Mock Test Verification**: Run the local Bun server with `STEELMAN_MOCK=1` and run the validation script `bun ../scripts/validate-steelman.ts` to ensure everything compiles and passes schema checks.
2. **Visual Layout Verification**: Open the web app on `http://127.0.0.1:5173` and trigger mock or live runs. Manually review visual balance of the new elements:
   - Check horizontal scrolling behaviour of timelines with 4-6 nodes.
   - Verify that quote links open correct URLs in target `_blank` windows.
   - Ensure the valuation gauge handles arbitrary numeric boundaries without exceeding 0% or 100%.
3. **Model Emission Success**: Run a live session asking the Investment Steelman Agent specifically to analyze Apple, TSMC, or Tesla, and ensure the agent correctly formats and publishes `@quote`, `@catalyst-timeline`, and `@valuation-gauge` structures to the left-side view.

---

## Acceptance Criteria
- All TypeScript compiler checks (`tsc`) pass across the server, extension, and web folders.
- The `steelman_emit_artifact` tool successfully registers with 11 total available artifact kinds.
- A user can view a beautifully-typeset Quote artifact showing citation links, speakers, roles, and dates.
- A user can view a left-to-right Catalyst Timeline where events are correctly color-coded (red, yellow/blue, green) according to their severity.
- A user can view a horizontal range bar representing valuation boundaries (Bear, Base, Bull) with an overlay marker showing the current market price.
- Clicking on a markdown `@ref` to one of these artifacts successfully reveals and activates it in the left pane.
- The validation smoke script (`validate-steelman.ts`) runs to completion without errors.

---

## Validation Commands
- `cd apps/steelman/web && bun run build` — Validates TypeScript compilation and builds the frontend production bundle.
- `cd apps/steelman/server && bun src/server.ts` — Launches the product server.
- `cd apps/steelman/scripts && bun validate-steelman.ts` — Runs the validation smoke-test suite.

---

## Notes
No external chart or timeline libraries are required; custom SVG and lightweight HTML/CSS layouts will achieve the desired outcome with optimal performance and minimum bundle size.
