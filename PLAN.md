# Smartech Event Validator — Build Plan (Chrome Extension, TypeScript)

Confirmed direction: Chrome Extension (Manifest V3), TypeScript/React/Vite, no Python, no Playwright. This is the right call given the actual use case — testing on whatever site you're already logged into and browsing, with live in-browser feedback, rather than re-entering a URL into a separate script each time.

Work through phases in order. Don't start a phase until the previous one's exit criteria are met and verified (build clean, tests pass, no extension errors in `chrome://extensions`).

---

## Phase 0 — Architecture & Scaffold

**Goal:** Lock decisions, get an empty extension loading with zero errors.

- [x] Repo structure created (`background/`, `content/`, `devtools/`, `popup/`, `event-sheet/`, `validation/`, `platforms/`, `reports/`, `storage/`, `shared/`)
- [x] pnpm + TypeScript + Vite + React + Vitest configured and building
- [x] Manifest V3 skeleton (`manifest.json`) — permissions scoped minimally, no unnecessary host permissions
- [x] DevTools integration files created (`devtools.html`, `devtools.ts`, `panel/index.html`, `panel/App.tsx`)
- [x] Empty "Smartech Validator" panel registers and opens inside Chrome DevTools on any tab
- [x] Confirm and document: DevTools cannot be force-opened by any script — this panel is the primary UI, not an auto-launched one
- [x] Confirm and document: SDK detection + debug enable will be a single action — attempt `smartech('debug','1')` in a try/catch under a retry loop; no error = detected + enabled, error = not detected

**Exit criteria:** `pnpm build` succeeds, extension loads unpacked with no console errors, empty panel renders on any site.

**Phase 0 record — 2026-08-30**

- *Status:* COMPLETE. All exit criteria met and verified.
- *Files added:* `package.json` (pnpm 11.24.0 pinned via `packageManager`), `tsconfig.json`,
  `vite.config.ts`, `.gitignore`, `public/manifest.json`, `src/devtools/{devtools.html,devtools.ts}`,
  `src/devtools/panel/{index.html,main.tsx,App.tsx,App.test.tsx,panel.css}`,
  `tests/{setup.ts,manifest.test.ts}`, `docs/decisions.md`. Empty `src/*` package dirs hold `.gitkeep`.
- *Verified:* `pnpm build` clean (`tsc --noEmit` + `vite build`, 18 modules); `pnpm test` 5/5 passing;
  `dist/manifest.json` emitted; built HTML contains no inline scripts, so MV3 CSP is satisfied;
  absolute `/assets/*` refs resolve against the extension root, which is correct for `chrome-extension://`.
- *Decisions documented:* `docs/decisions.md` D1 (DevTools cannot be script-opened — the interceptor must
  live in the content script, not the panel) and D2 (detection + debug enable are one try/catch call,
  with the queuing-stub caveat carried into Phase 2).
- *Deferred to Phase 2:* no `content_scripts` entry in the manifest. Content scripts cannot be ES
  modules, so they need a separate IIFE Rollup input; adding it now would be unused config.
- *Deferred to Phase 5:* no `background` service worker or popup registered — only empty dirs. Nothing
  needs them yet, and MV3 listeners must register synchronously on every worker start, which is a real
  design point better made when there is something to listen for.
- *Manual verification:* confirmed by the user on 2026-08-30 — extension loads unpacked from `dist/` with
  no errors in `chrome://extensions`, and the "Smartech Validator" panel renders in DevTools.

---

## Phase 1 — Foundation

**Goal:** Upload and understand an Event Sheet; confirm the SDK handshake works.

- [ ] XLSX parser (SheetJS or equivalent)
- [ ] CSV parser
- [ ] Column auto-detection (event name column, attribute column, type column, mandatory column, description, example value) using flexible name matching, not hardcoded headers
- [ ] Manual column-mapping UI, shown only when auto-detection is ambiguous
- [ ] Normalizer: raw sheet → internal schema (`events.{name}.attributes[]` with `name/type/required/description/example`)
- [ ] SDK detect + debug enable implemented as the single retryable call from Phase 0, with configurable timeout and diagnostic messages on failure
- [ ] Dashboard shell: site name, SDK status, debug status, parsed event/attribute tree
- [ ] Unit tests: XLSX parsing, CSV parsing, column mapping (auto + manual), required/optional detection

**Exit criteria:** Upload a sample sheet, see the normalized event tree render correctly; on a page with Smartech, see SDK 🟢 and Debug 🟢. No automation yet — this phase is upload + detect only.

---

## Phase 2 — Debug Capture

**Goal:** Reliably capture real Smartech debug events without breaking the site's own tracking.

- [ ] Page-context interception of `window.smartech`, injected as early as the content-script APIs allow (document_start / MAIN world) — wrap, never replace, so original site behavior is preserved
- [ ] Investigate and document whether the client's actual Smartech snippet uses a queuing-stub pattern (stub defined immediately, real SDK loads later) — if so, "call didn't throw" is not sufficient proof of real initialization; capture must confirm via the first genuine debug event instead
- [ ] Resilience check: does the SDK ever reinitialize/redefine `window.smartech` after page load? If so, the interceptor needs to detect and re-wrap it
- [ ] Live event viewer: timestamped stream, click to expand full payload
- [ ] Manual debug-object paste UI as fallback — safe parser (no `eval`), accepts JSON and JS-object-like text, ideally multiple objects at once
- [ ] Raw, unmodified event storage alongside any parsed view
- [ ] Unit tests: interceptor wrapping behavior, safe parser edge cases (malformed input, multiple objects, non-JSON JS-object syntax)

**Exit criteria:** Trigger a real `smartech()` call on a test page and see it appear live in the panel with the untouched raw object preserved; site's own tracking still fires normally; manual paste path works independently.

---

## Phase 3 — Validation Engine

**Goal:** Compare captured events against the Event Sheet schema and produce a verdict.

- [ ] Event matcher — exact name match only, no auto-aliasing (aliases are user-configurable, not automatic)
- [ ] Attribute validator: presence, missing, null, empty, type mismatch, required vs optional
- [ ] Nested path support (`product.category.id`)
- [ ] Array path support (`items[0].price`)
- [ ] Extra-attribute handling — configurable Ignore / Warning / Fail, default Warning
- [ ] `ValidationResult` type implemented exactly per spec (status, missing, extra, nullValues, emptyValues, typeMismatches, attributes, raw object, timestamp)
- [ ] Unit tests: missing fields, extra fields, null, empty, correct type, incorrect type, nested objects, arrays, event-name mismatch, exact match

**Exit criteria:** Feed a captured event + normalized schema into the validator and get a correct PASS/FAIL/WARNING with itemized per-attribute results, all covered by passing tests.

---

## Phase 4 — Ecommerce Automation

**Goal:** Trigger the events that need testing instead of requiring the user to manually reproduce every action.

- [ ] Test state machine implemented (IDLE → SDK/DEBUG → EVENT_SHEET_LOADED → ACTION_DETECTION → ACTION_EXECUTION → WAITING_FOR_EVENT → EVENT_CAPTURED → VALIDATING → PASS/FAIL) with configurable per-stage timeout
- [ ] Multi-strategy action detection in priority order (dataLayer → semantic HTML → aria-label → button/text → data-* attrs → platform patterns → JSON-LD → manual), each with a confidence score
- [ ] Confirmation UI before executing any low-confidence action — no blind auto-clicking
- [ ] Manual element selector fallback (user clicks the target element themselves)
- [ ] Test-ID + timestamp-based event association, so a co-occurring event (e.g. `page_view` firing alongside `add_to_cart`) isn't misattributed to the wrong test
- [ ] Platform adapter interface (`detect/findProduct/findAddToCart/findCart/findRemoveFromCart/findCheckout`) decoupled from the core engine
- [ ] Generic adapter (works on any site via the strategies above)
- [ ] Shopify adapter
- [ ] Magento adapter
- [ ] Purchase safety gate — explicit confirmation dialog, default Cancel, never auto-triggered
- [ ] Unit tests: timeout handling, event received, event not received, duplicate event handling

**Exit criteria:** On the mock ecommerce site, run an automated `add_to_cart` test end to end without manual intervention; on a site where detection fails, complete the same flow via manual element selection.

---

## Phase 5 — Reporting & Persistence

**Goal:** Turn results into something reviewable and reusable across sessions.

- [ ] Full dashboard (site, SDK/debug status, event sheet name, event count, tests completed/passed/failed/not-tested)
- [ ] Event details view per event (expected vs actual, per-attribute status table, raw object viewer)
- [ ] Test history stored in IndexedDB — open / delete / export past runs
- [ ] Client profiles (client name, website, event sheet, platform, notes) for repeat testing without reconfiguring
- [ ] Export: JSON
- [ ] Export: CSV
- [ ] Export: XLSX (summary sheet + detailed per-attribute sheet + raw debug objects sheet) — written as a **new** report file, never back into the uploaded Event Sheet

**Exit criteria:** Complete the full MVP acceptance flow end to end (spec section 45) and export a report in all three formats without modifying the original Event Sheet.

---

## Phase 6 — Hardening & Deliverables

**Goal:** Ship-ready.

- [ ] Full test suite passing across parser, validator, matcher, test engine
- [ ] Performance pass — confirm no unbounded MutationObservers, DOM scans are throttled, log/memory retention is bounded
- [ ] Security pass — confirm no `eval`, no external network calls with client data, Event Sheet always treated as untrusted input
- [ ] Sample Event Sheet (XLSX)
- [ ] Mock ecommerce test site (for safe automation testing without touching real client sites)
- [ ] Sample debug payloads
- [ ] README (what it is, how it works)
- [ ] Architecture doc
- [ ] Dev instructions, production build instructions, unpacked-install instructions
- [ ] Packaged extension build

**Exit criteria:** Fresh install of the packaged extension + sample Event Sheet + mock site reproduces the full MVP acceptance flow from spec section 45, unassisted.

---

### Working note for whoever runs this in Claude Code

Feed one phase at a time. After each phase: build it, run the tests, check for TypeScript and extension errors in `chrome://extensions`, verify the exit criteria manually, and only then move to the next phase. Don't let it generate multiple phases' worth of code in one pass.