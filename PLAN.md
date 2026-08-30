# Smartech Event Validator — Build Plan (Chrome Extension, TypeScript)

Confirmed direction: Chrome Extension (Manifest V3), TypeScript/React/Vite, no Python, no Playwright. This is the right call given the actual use case — testing on whatever site you're already logged into and browsing, with live in-browser feedback, rather than re-entering a URL into a separate script each time.

Work through phases in order. Don't start a phase until the previous one's exit criteria are met and verified (build clean, tests pass, no extension errors in `chrome://extensions`).

---

## Terminology

The Event Sheet describes each field of an event **twice**, across four columns: **Payload** +
**Payload Data Type**, and **Attribute** + **Attribute Data Type**. They are paired per row — one row
is one logical field, named once per channel (docs/decisions.md D4).

- **Payload** — the name and type the field carries in the **Smartech debug log**: what the SDK
  reports it is sending. Captured in Phase 2, validated in Phase 3.
- **Attribute** — the name and type the field carries in the **form-encoded network call**: what
  actually left the browser. Captured and validated in Phase 7.
- **Field** — the pair. `required`, `description` and `example` belong to the field, not to a channel.

Example: `product_id` in the payload is `prid` in the network call — one field, two names.

The debug payload is convenient and arrives already structured; the network call is ground truth. The
two do not always agree, which is why each channel carries its own datatype — a number in the payload
can arrive as a string once form-encoded. Until Phase 7 exists, "validated" means validated against the
debug payload only; that limitation must be stated in reports, never implied.

Either channel may be absent from a sheet. Detection therefore requires an event-name column plus **at
least one** of the two name columns, not both.

**Open question, to settle before Phase 7 is built:** when both channels are available, does a
payload/network mismatch make the event FAIL, or is it a separate discrepancy class reported alongside
the schema verdict? Decide first, build second.

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

- [x] XLSX parser (SheetJS or equivalent)
- [x] CSV parser
- [x] Column auto-detection (event name, payload + payload type, attribute + attribute type, mandatory, description, example value) using flexible name matching, not hardcoded headers
- [x] Manual column-mapping UI, shown only when auto-detection is ambiguous
- [x] Normalizer: raw sheet → internal schema (`events.{name}.fields[]` with `payloadName/payloadType/attributeName/attributeType/required/description/example`)
- [x] SDK detect + debug enable implemented as the single retryable call from Phase 0, with configurable timeout and diagnostic messages on failure
- [x] Dashboard shell: site name, SDK status, debug status, parsed event/field tree
- [x] Unit tests: XLSX parsing, CSV parsing, column mapping (auto + manual), required/optional detection

**Exit criteria:** Upload a sample sheet, see the normalized event tree render correctly; on a page with Smartech, see SDK 🟢 and Debug 🟢. No automation yet — this phase is upload + detect only.

**Phase 1 record — 2026-08-30**

- *Status:* code complete, 61/61 unit tests passing. Exit criteria pending manual verification in Chrome.
- *Domain layer* (`src/event-sheet/`): `types.ts`, `errors.ts`, `grid.ts`, `parse-csv.ts`, `parse-xlsx.ts`,
  `detect-columns.ts`, `normalize.ts`. All pure and browser-free except `parse-xlsx.ts`, which takes a `Blob`.
- *SDK layer:* `src/shared/sdk.ts` holds the retry logic with `PageEvaluator` and `wait` injected;
  `src/devtools/panel/chrome-page-evaluator.ts` is the only file touching `chrome.*`.
- *Panel:* `App.tsx` plus `components/{SdkStatusBar,SheetUpload,ColumnMappingForm,EventTree}.tsx`;
  `main.tsx` is the composition root that builds the evaluator and timer.
- *Verified:* `pnpm build` clean (80 modules, 254 kB panel bundle); `pnpm test` 61/61 across 7 files;
  manifest still declares **zero permissions** — `chrome.devtools.inspectedWindow.eval` needs none, so
  Phase 1 required no new host access.
- *Test fixture:* `tests/fixtures/sample-event-sheet.xlsx`, generated by the committed
  `make-sample-xlsx.sh` so it is reproducible rather than an opaque binary. It deliberately contains a
  junk title row, a blank row and blank event-name cells.
- *Decision added:* `docs/decisions.md` D3 — `read-excel-file` over SheetJS, because the npm build of
  `xlsx` is pinned at 0.18.5 with an open prototype-pollution advisory and Event Sheets are untrusted input.
- *Deviation from D2, deliberate:* the probe is `typeof smartech === 'function' ? (smartech('debug','1'),
  'enabled') : 'missing'` rather than a bare call in try/catch, so "absent" and "threw" produce different
  diagnostics. Still one action, still one round trip.
- *Known gap:* a column headed "Optional" is **not** auto-detected as the mandatory column, because its
  Yes/No values invert the meaning. Such sheets fall through to the manual mapping UI by design.
- *Deferred:* multi-worksheet workbooks use the first sheet only; no sheet picker yet.
- *Not verified by me:* the two exit criteria — rendering a real uploaded sheet in the panel, and seeing
  SDK/Debug green on a live Smartech page. Both need a human at a browser.

**Phase 1 amendment — 2026-08-30 (reopened after Phase 1 closed)**

Phase 1 originally shipped a single field list per event with one type column, because the Event Sheet
was understood to have one field-name column. It has four: payload + type and attribute + type, paired
per row. The checkbox wording above was corrected in place; this note records that the phase was
reopened rather than built that way first time.

- *Model change:* `AttributeSchema` → `FieldSchema` carrying both channel names and both types;
  `EventSchema.attributes` → `.fields`; `AttributeType` → `DataType` (it now types either channel).
- *Detection:* six column roles → eight. A bare "Data Type" header scores equally for both type roles
  and is resolved by adjacency to the name column it follows; failing that it stays ambiguous.
- *Requirement rule relaxed:* an event-name column plus **at least one** of payload/attribute name,
  rather than both — sheets documenting a single channel are valid.
- *Bug found and fixed by the new tests:* ambiguity was only checked as "one role, many columns". One
  column claimed by **two** roles resolved silently, so an unbroken "Data Type" tie was assigned to
  both type roles at once. Detection now inverts the mapping and treats that collision as ambiguous.
- *Fixture regenerated:* `sample-event-sheet.xlsx` now carries all eight columns, via the same
  committed generator script.
- *Verified:* `pnpm build` clean; `pnpm test` 70/70 across 7 files (was 61).
- *Decision added:* docs/decisions.md D4.
- *Unchanged:* Phase 0 in full; the CSV and XLSX readers; the SDK detection layer; the zero-permission
  manifest. Exit criteria still await the same manual browser check.

---

## Phase 2 — Debug Payload Capture

**Goal:** Reliably capture real Smartech debug **payloads** without breaking the site's own tracking.

*Scope:* the debug-log channel only. Network form calls are Phase 7 — do not start decoding requests here.

- [ ] Page-context interception of `window.smartech`, injected as early as the content-script APIs allow (document_start / MAIN world) — wrap, never replace, so original site behavior is preserved
- [ ] Investigate and document whether the client's actual Smartech snippet uses a queuing-stub pattern (stub defined immediately, real SDK loads later) — if so, "call didn't throw" is not sufficient proof of real initialization; capture must confirm via the first genuine debug event instead
- [ ] Resilience check: does the SDK ever reinitialize/redefine `window.smartech` after page load? If so, the interceptor needs to detect and re-wrap it
- [ ] Live payload viewer: timestamped stream, click to expand the full payload
- [ ] Manual debug-object paste UI as fallback — safe parser (no `eval`), accepts JSON and JS-object-like text, ideally multiple objects at once
- [ ] Raw, unmodified payload storage alongside any parsed view
- [ ] Unit tests: interceptor wrapping behavior, safe parser edge cases (malformed input, multiple objects, non-JSON JS-object syntax)

**Exit criteria:** Trigger a real `smartech()` call on a test page and see its payload appear live in the panel with the untouched raw object preserved; site's own tracking still fires normally; manual paste path works independently.

---

## Phase 3 — Validation Engine

**Goal:** Compare captured **debug payloads** against the Event Sheet schema and produce a verdict.

*Scope:* the verdict covers the debug-payload channel only. The network channel reuses this same engine in Phase 7, so keep the validator input-shape agnostic — it takes a plain object, not "a debug event".

- [ ] Event matcher — exact name match only, no auto-aliasing (aliases are user-configurable, not automatic)
- [ ] Payload validator — compares payload fields against the Event Sheet's expected attributes: presence, missing, null, empty, type mismatch, required vs optional
- [ ] Nested path support (`product.category.id`)
- [ ] Array path support (`items[0].price`)
- [ ] Extra-field handling (present in the payload, absent from the Event Sheet) — configurable Ignore / Warning / Fail, default Warning
- [ ] `ValidationResult` type implemented exactly per spec (status, missing, extra, nullValues, emptyValues, typeMismatches, attributes, raw object, timestamp)
- [ ] Unit tests: missing fields, extra fields, null, empty, correct type, incorrect type, nested objects, arrays, event-name mismatch, exact match

**Exit criteria:** Feed a captured payload + normalized schema into the validator and get a correct PASS/FAIL/WARNING with itemized per-attribute results, all covered by passing tests.

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

## Phase 7 — Network Attribute Capture (post-MVP)

**Goal:** Validate what actually left the browser, not only what the SDK said it was sending.

- [ ] Confirm and document the shape of Smartech's outbound calls — endpoint(s), method, and whether the data rides in a form-encoded body, the query string, or both
- [ ] Capture requests with `chrome.devtools.network.onRequestFinished` from the panel — verify first whether devtools network access needs any manifest permission; if it does not, the zero-permission manifest survives
- [ ] Decoder: form-encoded / query-string request data → the same plain-object shape the Phase 3 validator already consumes, so the engine is reused rather than duplicated
- [ ] Associate each network call with the debug payload for the same event, using the test ID + timestamp window Phase 4 already establishes
- [ ] Settle the open question in Terminology: payload/network mismatch as FAIL, or as its own discrepancy class
- [ ] Report the two channels distinctly — a report must never imply the network call was checked when only the debug payload was
- [ ] Unit tests: decoder against real captured request bodies, association logic, mismatch detection

**Exit criteria:** On the mock ecommerce site, trigger one event and see both its debug payload and its network attributes captured, validated, and shown side by side with any discrepancy called out.

---

### Working note for whoever runs this in Claude Code

Feed one phase at a time. After each phase: build it, run the tests, check for TypeScript and extension errors in `chrome://extensions`, verify the exit criteria manually, and only then move to the next phase. Don't let it generate multiple phases' worth of code in one pass.