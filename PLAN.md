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

- *Status:* COMPLETE. All exit criteria met and verified. (Build/test counts in this record are from the
  original Phase 1 build; superseded by the amendment below.)
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
- *Manual verification:* confirmed by the user on 2026-08-31 — an uploaded Event Sheet renders as a
  normalised event/field tree in the panel, and SDK/Debug report green on a live Smartech page.

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
  manifest. Exit criteria re-verified by the user on 2026-08-31 against the regenerated eight-column
  fixture, with both payload and attribute columns populated in the tree.

---

## Phase 2 — Debug Payload Capture

**Goal:** Reliably capture real Smartech debug **payloads** without breaking the site's own tracking.

*Scope:* the debug-log channel only. Network form calls are Phase 7 — do not start decoding requests here.

- [x] Page-context interception of `window.smartech`, injected as early as the content-script APIs allow (document_start / MAIN world) — wrap, never replace, so original site behavior is preserved
- [x] Investigate and document whether the client's actual Smartech snippet uses a queuing-stub pattern (stub defined immediately, real SDK loads later) — if so, "call didn't throw" is not sufficient proof of real initialization; capture must confirm via the first genuine debug event instead
- [x] Resilience check: does the SDK ever reinitialize/redefine `window.smartech` after page load? If so, the interceptor needs to detect and re-wrap it
- [x] Live payload viewer: timestamped stream, click to expand the full payload
- [x] Manual debug-object paste UI as fallback — safe parser (no `eval`), accepts JSON and JS-object-like text, ideally multiple objects at once
- [x] Raw, unmodified payload storage alongside any parsed view
- [x] Unit tests: interceptor wrapping behavior, safe parser edge cases (malformed input, multiple objects, non-JSON JS-object syntax)

**Exit criteria:** Trigger a real `smartech()` call on a test page and see its payload appear live in the panel with the untouched raw object preserved; site's own tracking still fires normally; manual paste path works independently.

**Phase 2 record — 2026-08-31**

- *Status:* COMPLETE. All 7 checklist items done; exit criteria verified live on 2026-08-31 (one
  part covered by tests rather than manual exercise — see the closing note).
- *Capture path:* `src/content/interceptor.ts` (MAIN world, document_start) → `window.postMessage` →
  `src/content/bridge.ts` (ISOLATED world) → `chrome.runtime.sendMessage` →
  `src/devtools/panel/chrome-payload-source.ts`, filtered on the inspected tab id. No service worker.
- *Contract:* `src/shared/payload.ts` — `CapturedPayload`, and `toTransferable` which tags `undefined`,
  functions, symbols, cycles and throwing getters rather than dropping them. Phase 3 must tell `null`,
  `undefined` and "key absent" apart, and plain JSON collapses two of those into nothing.
- *Paste fallback:* `src/shared/parse-debug-text.ts`, a hand-written recursive-descent reader. No
  `eval`, no `new Function` — pasted text is untrusted and the panel runs with extension privileges.
  Accepts JSON plus the console dialect (unquoted keys, single quotes, trailing commas) and several
  objects per paste. A test asserts nothing is ever evaluated.
- *Build:* content scripts cannot be ES modules, so `vite.content.config.ts` is a second pass emitting
  standalone files. Verified: `dist/content/*.js` contain zero import/export statements.
- *Verified:* `pnpm build` clean (both passes); `pnpm test` 121/121 across 10 files.
- *Decisions added:* D5 (two content scripts, and the honest permissions cost) and D6 (Proxy behind an
  accessor, and why a plain wrapper would break a queuing stub).
- **Permissions changed — the "zero permissions" property is gone.** `permissions` and
  `host_permissions` are still absent, but `"matches": ["<all_urls>"]` grants host access in its own
  right and Chrome will warn accordingly. See D5 for the tighter alternative to revisit at Phase 6.
- *Still open, cannot be answered from here:* whether the client's snippet uses a queuing stub, and
  whether it reinitialises `window.smartech`. `docs/smartech-snippet-probe.js` answers both against the
  live site. The interceptor is written to be correct under either answer — re-wrapping on assignment
  and forwarding properties — so the answers refine D2's wording rather than changing the design. Those
  two checkboxes stay unticked until someone runs the probe on the client site.
- *Known gap, deliberate:* payloads fired while the panel is closed are lost; no buffering or replay.
  D1 anticipates it, no phase needs it yet.
- *Bounded:* the panel keeps at most 500 payloads, newest first.
- *Fixed after first live run (2026-08-31):* `postMessage` threw `RangeError: Maximum call stack size
  exceeded` on a real site — the serialiser guarded cycles but not depth or breadth. Now bounded to
  depth 12 / 200 keys / 500 items, with DOM nodes and the global object tagged rather than walked, and
  a degraded record posted if a payload still cannot be cloned. See D7. Tests 121 → 127.
- *Confirmed live:* content scripts inject and the interceptor attaches (`__smartechValidatorInstalled`
  is true on the page). Requires reloading the extension **and** hard-reloading the page, because
  Phase 1's manifest declared no content scripts at all.
- *Second live fix (2026-08-31):* infinite recursion in the Proxy `get` trap. The snippet idiom
  `window.smartech = window.smartech || stub` assigned our own truthy wrapper back to us, so the
  wrapper targeted itself **and** the site never installed its SDK. The getter is now falsy until the
  site installs something, the setter ignores being handed the wrapper, and traps no longer forward
  `receiver`. See D8. Tests 127 → 129, including the snippet idiom verbatim.
- *Third live fix (2026-08-31):* the client's SDK delegates back into `window.smartech`. A depth cap
  contained the recursion but recorded one click as **four identical payloads** — silent data
  corruption that Phase 3 would have read as four events. Bounces are now identified by argument
  identity against the open call stack, so a delegated call is captured exactly once while genuine
  nested calls (different arguments) are still captured. See D9. Tests 129 → 133.
- *Both investigative items answered — by live failures, not by the probe:*
  - **Queuing stub: yes.** The snippet uses `window.smartech = window.smartech || stub`. This is not
    inference; a truthy wrapper made the site skip installing its own SDK entirely (D8). D2's caveat is
    therefore confirmed: "a callable exists" does not prove the SDK initialised, because the stub
    satisfies that check. Phase 3 must treat SDK-ready as provisional until a real payload arrives.
  - **Redefines/delegates: yes.** The SDK captures `window.smartech` and calls back into it (D9). The
    accessor-based install re-targets on assignment, which is what makes this survivable.
  - `docs/smartech-snippet-probe.js` is kept for the next client site; it was not needed for this one.
- *Live capture confirmed by the user on 2026-08-31:* performing an action on the page lists the event
  in the panel automatically.
- **Approach changed after a fourth live failure (2026-08-31).** Wrapping `window.smartech` broke the
  SDK's own initialisation: `create`/`register` were buffered on the stub's `.q`, and our proxy's
  target-following made that queue unreachable once the real SDK assigned itself, so those calls were
  dropped and the JS versioning request never fired. Capture now reads Smartech's own debug output by
  wrapping `console.*` and never touches `window.smartech`. `src/content/interceptor.ts` is replaced by
  `src/content/debug-capture.ts`. See D10, which supersedes D6, D8 and D9. Tests 132 → 127 (the
  wrapper's cycle/idiom tests no longer describe anything that exists).
- *Resolved as a side effect:* capture now records the debug-log payload itself rather than the call
  arguments one step upstream, which was the open fidelity question blocking Phase 3.
- *Fifth live fix (2026-08-31), on an unrelated site:* `netcore.freshdesk.com` threw `Invalid Origin`
  from our capture wrapper — that page overrides `window.postMessage`, and our page→extension handoff
  was broadcasting on it. The handoff is now a private `CustomEvent` on `document` that no page listens
  for. See D12. Tests 175 → 177, including a regression test that we put nothing on the page's message
  channel and one that capture survives a page with a broken `postMessage`.

**Phase 2 exit criteria — verified by the user, 2026-08-31**

- *Payload appears live with the raw object preserved:* yes. One entry per action, labelled with the
  event name parsed from the debug line.
- *Site's own tracking still fires:* yes. `create`/`register` execute and the JS versioning request
  appears in the Network tab. This is the check that caught D10, and it is the one to repeat after any
  future change to capture — the panel looks identical whether or not the site is broken.
- *Manual paste path works independently:* covered by 20 unit tests on the parser plus panel tests, but
  not manually exercised on a live page. Low risk, and it shares no code with live capture. Worth 20
  seconds before this is handed to anyone else.

Final tally: 127 tests across 10 files; both build passes clean; 10 decisions recorded (D6, D8 and D9
superseded by D10).

---

## Phase 3 — Validation Engine

**Goal:** Compare captured **debug payloads** against the Event Sheet schema and produce a verdict.

*Scope:* the verdict covers the debug-payload channel only. The network channel reuses this same engine in Phase 7, so keep the validator input-shape agnostic — it takes a plain object, not "a debug event".

- [x] Event matcher — exact name match only, no auto-aliasing (aliases are user-configurable, not automatic)
- [x] Payload validator — compares payload fields against the Event Sheet's expected attributes: presence, missing, null, empty, type mismatch, required vs optional
- [x] Nested path support (`product.category.id`)
- [x] Array path support (`items[0].price`)
- [x] Extra-field handling (present in the payload, absent from the Event Sheet) — configurable Ignore / Warning / Fail, default Warning
- [x] `ValidationResult` type implemented exactly per spec (status, missing, extra, nullValues, emptyValues, typeMismatches, attributes, raw object, timestamp)
- [x] Unit tests: missing fields, extra fields, null, empty, correct type, incorrect type, nested objects, arrays, event-name mismatch, exact match

**Exit criteria:** Feed a captured payload + normalized schema into the validator and get a correct PASS/FAIL/WARNING with itemized per-attribute results, all covered by passing tests.

**Phase 3 record — 2026-08-31**

- *Status:* COMPLETE. Exit criteria are test-based and met — 175 tests across 13 files, build clean.
  No browser check needed: this phase ships no UI.
- *Files:* `src/validation/{types,path,match-event,validate}.ts` plus a test file each.
- *Engine is channel-agnostic:* `validateEvent` takes a plain object and an injected timestamp, so
  Phase 7 reuses it for network attributes unchanged. Rows naming only a network attribute are skipped
  here rather than reported as missing.
- *Matcher is strict:* exact name only — no case folding, no separator normalisation. Tests pin
  `Add to Cart` ≠ `add_to_cart`. User-supplied aliases are honoured; nothing is inferred.
- *Deviation from the plan's wording:* `ValidationResult.fields`, not `attributes`. Under the corrected
  terminology *attribute* means the network-channel name, so `attributes` holding payload results would
  reintroduce the ambiguity Phase 1 removed. Every other key matches the specified shape. See D11.
- *Added a sixth field status, `unverifiable`:* values our own serialiser clipped or tagged (D7) warn
  instead of failing, because we cannot tell whether the site was correct. Failing them would
  manufacture defects.
- *Verdict rules recorded in D11.* Notably a missing **optional** field is silent, and a type mismatch
  fails whether or not the field was required.
- *Open question, flagged not guessed:* a sheet path of `items[0].price` is read literally as element 0.
  If real sheets mean "every element", a malformed element 3 would pass. Needs a real sheet using array
  notation before deciding; wildcard support is small once we know.
- *Verdicts wired into the panel — display pulled forward from Phase 5, deliberately.* Phase 3 as
  planned left the engine unreachable from the UI, which meant the sheet parser, live capture and the
  validator had each been tested alone and never connected. `src/validation/from-capture.ts` joins them
  (event name → schema, logged arguments → payload object), and the stream now shows a PASS / FAIL /
  WARNING / UNKNOWN badge per captured payload, expandable to a per-field table. Four end-to-end panel
  tests cover upload → capture → verdict. Phase 5 still owns reports, history and export.
- *Tests:* 190 across 14 files.

---

## Phase 4 — Ecommerce Automation

**Goal:** Trigger the events that need testing instead of requiring the user to manually reproduce every action.

- [x] Test state machine implemented (IDLE → SDK/DEBUG → EVENT_SHEET_LOADED → ACTION_DETECTION → ACTION_EXECUTION → WAITING_FOR_EVENT → EVENT_CAPTURED → VALIDATING → PASS/FAIL) with configurable per-stage timeout
- [x] Multi-strategy action detection in priority order (dataLayer → semantic HTML → aria-label → button/text → data-* attrs → platform patterns → JSON-LD → manual), each with a confidence score
- [x] Confirmation UI before executing any low-confidence action — no blind auto-clicking
- [x] Manual element selector fallback (user clicks the target element themselves)
- [x] Test-ID + timestamp-based event association, so a co-occurring event (e.g. `page_view` firing alongside `add_to_cart`) isn't misattributed to the wrong test
- [x] Platform adapter interface (`detect/findProduct/findAddToCart/findCart/findRemoveFromCart/findCheckout`) decoupled from the core engine
- [x] Generic adapter (works on any site via the strategies above)
- [x] Shopify adapter
- [x] Magento adapter
- [x] Purchase safety gate — explicit confirmation dialog, default Cancel, never auto-triggered
- [x] Unit tests: timeout handling, event received, event not received, duplicate event handling

**Exit criteria:** On the mock ecommerce site, run an automated `add_to_cart` test end to end without manual intervention; on a site where detection fails, complete the same flow via manual element selection.

**Phase 4 record — 2026-08-31**

- *Status:* code complete, 246 tests across 19 files, build clean. Exit criteria await a manual run
  against the mock store.
- *Pure core* (`src/automation/`): `types.ts` (strategy confidence, thresholds), `selector.ts`,
  `detect-action.ts`, `platforms/adapters.ts`, `test-run.ts` (the state machine), `associate.ts`,
  `commands.ts` (the panel↔page protocol). All decisions live in `advance`; the UI only carries them out.
- *Execution* runs in the existing isolated-world content script — detect, click, and a manual element
  picker — so Phase 4 needed **no new permissions**. The picker swallows the selecting click so pointing
  at an element does not also run the test.
- *Mock store built here, not in Phase 6.* The exit criteria depend on it, so `mock-site/` ships now
  with `index.html`, a matching `event-sheet.csv`, and `pnpm mock` to serve it over http. It
  deliberately includes a confident target, a weak text-only target, a money-spending action, and an
  unlabelled control that forces the manual picker.
- *Deviation from the plan's adapter shape:* the interface exposes `detect` plus a selector map rather
  than five `findX` methods. Each of those would have been a one-line forward to the same lookup — a
  wrapper, which the project's own rules forbid. Same capability.
- *Interpretation recorded:* the plan lists `dataLayer` and `JSON-LD` as element-detection strategies,
  but neither identifies an element. `dataLayer` is read as "an inline handler that pushes this action",
  and JSON-LD as corroboration that a page is a product page. Both are implemented and scored low.
- *Two bugs the tests caught:* `semantic` was matching anchors, so text-only links scored as high as
  real controls and could never fall below the confirmation threshold; and the JSON-LD check compared
  punctuation against an already-normalised string, so it never matched.
- *One UX bug the tests caught:* with no Event Sheet the event dropdown is empty, which left Run
  permanently disabled and the "upload a sheet first" state unreachable. Run is now always enabled and
  explains what is missing.
- *Safety:* `checkout` always confirms, however confident detection was, and confirmation defaults to
  no action — the run only proceeds on an explicit click. Covered by tests.
- *Added beyond the checklist — "Run all from sheet".* Selecting an action and an event by hand for
  every row does not scale to a real Event Sheet, so `src/automation/event-plan.ts` derives a run plan
  from the sheet itself and the runner works through it unattended, reporting a per-event table.
  - The sheet says *what should fire*, not *what to click*, so the action is inferred from the event
    name (`add_to_cart` → add-to-cart, `product_viewed` → product, and so on).
  - **This fuzziness is deliberate and is not a reversal of `matchEvent`'s strictness.** Matching a
    captured event to a schema decides whether the site is correct, so a loose match there would hide
    defects. Inferring an action decides what to click, and a wrong guess is caught downstream: it
    finds no element, or a weak one that asks before doing anything.
  - Money-spending events are excluded from an unattended batch and listed as skipped with the reason;
    they stay runnable individually behind the same confirmation.
  - Events that map to no action are **listed as skipped, not dropped** — a shorter list would read as
    "all tested" when several were never attempted.
  - Runs are ordered the way a shopper would do them, so a cart is filled before anything is removed
    from it.

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