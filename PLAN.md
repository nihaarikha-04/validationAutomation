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
- *Extended 2026-09-01 — non-ecommerce events are driven too.* Detection no longer works from a fixed
  list of five ecommerce actions; it takes a **target**, which is either a curated intent or keywords
  derived from the event's own name. `newsletter_signup` searches the page for "newsletter signup",
  "newsletter sign up", "newsletter", "signup" through the same strategies, so no hand-mapping is
  needed for a sheet full of client-specific events.
  - Words that describe the *event* rather than an action (`completed`, `viewed`, `success`) are
    dropped — no button is ever labelled "completed". An event name made only of those, such as
    `page_viewed`, is still listed as skipped, since nothing on a page can be clicked to cause it.
  - Compound labels are handled: `signup` also searches for "sign up", `login` for "log in".
  - **The safety gate no longer depends on the ecommerce list.** Destructiveness is decided when the
    run is planned, from the intent *and* the event name, so `subscription_payment` is gated even
    though it is not one of the five known actions. `RunContext` carries a `destructive` flag rather
    than re-deriving it from an intent.
  - *Bug caught by the new tests:* the name was lowercased before the camelCase split, so `wishlistAdd`
    never split into "wishlist add".
- *Three defects found on the first real client sheet (2026-09-01), all fixed:*
  1. **Keyword matching ignored word boundaries.** Punctuation was stripped before a substring test,
     so the token `zolo` from `Zolo_Searched` matched `class="zolostays-social-insta-feeds"` — the
     brand name, present on nearly every element. Labels now reduce to space-separated words and
     compare whole words.
  2. **A batch stopped at the first dialog.** One low-confidence element left the run waiting for a
     human, so every later event in the sheet reported a timeout. Runs that stop for a person are now
     recorded **NEEDS REVIEW** with the reason and the batch continues; they stay runnable
     individually.
  3. **Commands could hang.** `chrome.tabs.sendMessage` never called back when the page was
     mid-navigation, so the stage timed out with a misleading "timed out looking for the element".
     The driver now bounds every reply and retries once when the failure looks like navigation.
- *Known limitation confirmed live:* events needing input before the click — `Searched`, `Sign in` —
  cannot be driven by clicking alone. The click lands but produces no event, reported honestly as "the
  action ran but no matching event was captured". Driving these needs a recorded step sequence
  (navigate, type, then click), which is not in the plan.
- *Each run now keeps its own debug log.* A result used to be a verdict with no evidence — you could
  see FAIL but not what was captured. Every run records the payload it was associated with and the
  per-field verdict alongside the outcome, expandable in place. Single runs are recorded the same way
  as batched ones, so the results list is the record either way. A run that captured nothing says so
  explicitly rather than showing an empty box.
- *Matching reworked after a second real sheet (2026-09-01).* Three separate faults, all from the
  same place:
  - **Any one word was enough to match.** `Zolo_Searched` matched a link labelled "ZOLO SCHOLAR" —
    the brand name, on nearly every element. A name-derived target now requires **every** word.
  - **Words had to be adjacent.** The sheet said `Schedule_visit`; the page says "Schedule a visit".
    Words are matched independently rather than as a phrase.
  - **No allowance for word endings.** `Searched` could not find a button labelled "Search", nor
    `Registration` a "Register" link. Both sides are now stemmed, with prefix matching only where the
    shared start is at least six characters — long enough for `regist`/`register`, short enough to
    keep excluding `zolo`/`zolostays`.
  - When nothing matches every word, detection falls back to the single most distinctive word (five
    characters or more) at 0.6× confidence, so it asks rather than clicking on a partial match.
- *Two reporting fixes from the same run:* "Nothing on the page matched" was read as an event-name
  failure when it meant no *element* was found, so it now says so plainly; and a run that captured no
  matching event now lists the events that **did** fire in its window — the single most useful thing
  to know when a sheet name and a live event name disagree.
- *Added "Click best match even when unsure" (2026-09-01), off by default.* A NEEDS REVIEW run never
  clicks, so it produces no event and therefore no debug log — which read as the capture being broken
  when it was the safety gate working. The toggle lets a batch click the best candidate regardless of
  confidence, so a log exists to inspect. **Destructive actions still always confirm**, whatever the
  toggle says. The NEEDS REVIEW message now explains that nothing was clicked and points at both ways
  forward.
- **Added "Sweep the page" (2026-09-01) — a second, inverted mode, at the user's request.**
  Rather than deciding which control produces a given event and clicking that, it clicks *every*
  control and reads whatever fires. The element→event guess is the step that failed repeatedly on
  real sites (`zolo` matching a brand name, "no element matched", low-confidence stalls); this mode
  removes that step entirely, so what a control is *called* stops mattering.
  - `src/automation/sweep.ts` enumerates clickables and classifies each **safe / navigates /
    destructive**. Only safe ones are clicked by default: a blind sweep would otherwise place
    orders, delete items or sign the tester out.
  - `navigates` is excluded by default because a click that leaves the page ends the sweep — every
    remaining candidate belongs to a document that no longer exists. Three consecutive click
    failures are treated as exactly that and stop the run with an explanation.
  - The report is **coverage-shaped, not action-shaped**: every sheet event is PASS, FAIL or NOT
    SEEN, with the per-field verdict where one exists. Events the site fires that the sheet does not
    describe are listed separately — a finding in their own right.
  - *Caught while testing:* the visibility check used `getClientRects`, which is empty in any
    headless DOM, so it silently excluded everything and could not be tested. Replaced with computed
    style, which behaves the same in both.
- **Root cause of "no debug logs", found 2026-09-01: the prefix matcher was too narrow.** A probe run
  on the live site showed 7 console lines, 0 matching — and the one match was the probe's own
  synthetic line. Capture, transport and panel delivery were all working; the site simply logs
  `console.info('Smartech debug', payload)` with no brackets, and the matcher required them. See D13.
  Event names are now also read from the payload when the message does not carry one.
  - *Process note:* three modes and a dozen fixes were built on top of this without verifying capture
    after the transport change (D12). The eight-line probe that found it should have been written the
    first time "no debug logs" was reported.
- *Sweep made resilient to a changing page (2026-09-01).* It enumerated every control up front, so
  the first click that opened a menu or re-rendered invalidated every remaining selector — three
  failures later the sweep gave up, having clicked once. Observed live. Now:
  - the page is **re-listed every round**, so controls that appear after a click are included and
    stale selectors never accumulate;
  - a selector that no longer matches returns `not-found` and is skipped, distinct from the page
    being unreachable — only the latter counts toward stopping;
  - **Escape is sent after each click**, closing modals and menus so the next control is not sitting
    under an overlay;
  - the loop is wrapped, so a thrown error is reported instead of freezing the progress line.
- **Added site crawling (2026-09-01).** Sweeping one page only ever covers the events that page can
  fire. `src/automation/crawl.ts` extracts `sweepPage` from the panel and adds `crawlSite`, which
  sweeps the current page, collects the site's own links, and repeats on each up to a page limit.
  - **Navigation is deliberate, never incidental.** Outbound-link clicking stays off during a sweep,
    so the crawler leaves a page only by choosing to — which is what makes the click loop and the
    page loop able to coexist.
  - Same-origin links only, fragments and trailing slashes normalised so a site linking to itself
    does not crawl forever.
  - After navigating it polls until the content script on the new page answers, and gives up with a
    reason rather than hanging.
  - The sweep loop is now a plain async function with its dependencies injected, so the crawler and
    the panel share it and both are testable against a scripted page rather than a browser.
- **The end-to-end flow the user described is now the primary mode (2026-09-01):** crawl every page →
  click everything → collect the debug logs → match each captured event to the sheet, exactly *or*
  closely → validate the payload of whatever matched.
  - *Close matching added, deliberately scoped.* `matchEvent` gains an opt-in fourth argument. Names
    are compared as word sets (Dice coefficient, threshold 0.6), so `add_to_cart` credits a sheet
    saying `Add to Cart` and `productViewed` credits `product_viewed`. **Exact matching remains the
    default everywhere else**, and a close match is reported as `close`, never as `matched` — the row
    reads "fired as `add_to_cart` — names differ", so the payload gets validated *and* the naming
    disagreement stays a visible finding rather than being smoothed away. This is the loosening that
    D-era notes warned against, made safe by never hiding it.
  - *A visible pointer, on by default.* Every click animates a labelled cursor to the element,
    outlines it, and pulses on contact. Automation that clicks invisibly cannot be trusted or
    debugged — a wrong click and no click look identical. The overlay is inert and excluded from the
    sweep's own enumeration so it can never click itself. Costs roughly half a second per click;
    switchable off.
- *Crawl fixed after it stayed on one page (2026-09-01), two causes:*
  1. **Links were collected after the sweep.** A click that navigated or broke the page killed the
     link fetch too, so the queue was never filled and the crawl ended at page one. Links are now
     read *before* anything is clicked, so a page that dies mid-sweep still contributes its onward
     links. Test asserts the ordering directly.
  2. **No click budget per page.** Sixty clicks at over a second each meant two minutes on the home
     page before the crawler would ever navigate — indistinguishable from not navigating at all.
     Each page now gets a budget (default 20, adjustable).
  - Each visited page reports how many links it offered, so "zero links found" — the other reason a
    crawl legitimately ends early — is visible rather than guessed at.
- *Limits removed (2026-09-01), at the user's request.* Pages and clicks-per-page both default to
  unlimited (`0`), and the enumeration cap of 60 controls per page is gone — a sweep now offers every
  clickable the page has.
  - **A Stop button was added in the same change, not as a nicety.** With no limits, an unbounded
    crawl of a real site has no natural end, and cancellation is the only way to end a run. It is
    checked at every click and every page, so stopping is prompt rather than at the next boundary.
  - The limits remain available for anyone who wants them; `0` simply means "no limit" rather than
    the fields being removed.
- *Sweep stuck on the navbar, fixed (2026-09-01).* Controls were identified by a structural selector
  (`body > div > div:nth-of-type(3)`), which changes whenever a click re-renders the page. The sweep
  therefore could not recognise controls it had already clicked, kept picking the first unvisited one
  in document order, and never got past the navigation bar — which also explains why it never scrolled.
  - Each control is now tagged with a `data-sv-id` attribute on first sight and addressed by that. The
    tag travels with the element through re-renders, so "already clicked" means what it says. Tests
    pin both properties: identity survives a re-render, and re-enumerating yields the same selector.
  - A **scroll pass** now runs before enumerating each page, stepping down a viewport at a time so
    content that loads on scroll is in the DOM before the sweep takes stock. Without it a sweep only
    ever saw what rendered above the fold.
  - *Cost, accepted:* the page is mutated with an inert attribute per control. It is the only thing
    that survives a re-render, and it is reversible by reloading.
- *Run-time limit added (2026-09-01):* 5 / 10 / 15 / 30 minutes, or "as long as it takes". Checked at
  every click and page alongside the Stop button, so a long crawl can be time-boxed rather than
  babysat.
- *Synonymous event names are now recognised and explained, rather than reported as unknown.*
  `matchEvent`'s close matching gained a synonym layer: industry-interchangeable words reduce to one
  spelling (`login`/`Sign in`, `registration`/`Sign up`, `order_placed`/`Purchase`, `add_to_bag`/
  `Add to Cart`, `searched`/`Search`).
  - The match carries a **reason** — `formatting` when the words are the same and only the
    punctuation differs, `synonym` when different words mean the same thing — and the report says
    which: "fired as `login` — synonymous name". A payload that would previously have been dismissed
    as UNKNOWN is now validated *and* the naming disagreement is stated.
  - **`sign in` and `sign out` are deliberately kept apart**, with a test pinning it. Synonyms map to
    phrases rather than single tokens precisely so those two cannot collapse into each other —
    silently equating them would be worse than never matching at all.
- *Console wrapper made less detectable (2026-09-01).* `console.log.toString()` now reports the
  original source and keeps the original `name`, because analytics libraries check for tampering and
  some go quiet when they think they are being watched — which would defeat observing them behaving
  normally. See D14, which also records why our file appears atop unrelated libraries' stack traces
  (Appcues, Freshdesk, Meta Pixel) and why that cannot be removed while we read console output.
- **`smartech('debug','1')` now runs from the page, on every load (2026-09-01).** It was called once
  from the panel when it opened, so a page reload — or any navigation during a crawl — silently
  turned debug output back off and every page after the first captured nothing. The capture content
  script now polls for the SDK (~12s, since the snippet loads asynchronously) and enables debug
  itself. Running at `document_start` on every page means every page gets it, panel open or not.
- **Capture now reports what it is seeing.** A periodic line in the panel says how many console lines
  were watched, how many looked like Smartech, and — when none did — the start of the most recent
  unmatched lines. This is the diagnostic whose absence cost days on the previous site: an empty list
  meant either "no Smartech output" or "output we do not recognise", and nothing distinguished them
  without pasting a probe into a console. See D13.
- **Repeated controls are no longer clicked repeatedly (2026-09-01).** A grid of forty product tiles
  that all fire `product_view` was costing forty clicks to learn one thing. Controls are now grouped
  by what they are — tag plus class list, falling back to the parent for context when an element has
  no classes of its own, so unadorned buttons in different regions are not lumped together.
  - Once one member of a group produces an event, the rest are skipped: the payload has already been
    captured and validated, and the thirty-nine others add nothing.
  - A group that produces nothing gets three tries before being written off, so a silent grid costs
    three clicks rather than forty.
  - The count of skipped repeats is reported per page and in total, so the saving is visible and a
    group wrongly collapsed would be noticeable rather than silent.
- *Two bugs that stopped a click's destination being explored (2026-09-01):*
  1. **Element ids collided across pages.** The counter restarted at 1 on every load, so after a
     click navigated, the new page's controls were already in the sweep's "clicked" set and nearly
     all were skipped. Ids now carry a per-load stamp.
  2. **A sweep that navigated abandoned where it landed.** Clicking a product tile opened the product
     page and the sweep simply ended, so its Add to Cart was never reached. `sweepPage` now reports
     where a click took it, and the crawler sweeps that page next — without re-navigating, since it
     is already there. That is what makes tile → product page → Add to Cart work as one chain.
- *Overlays are now explored rather than closed (2026-09-01).* Escape was sent after **every** click
  to stop a modal blocking the controls beneath it — which meant a modal opened by a click was closed
  before its own buttons were ever enumerated, so nothing inside an overlay was ever tested. Dismissal
  is now lazy: a click that opens a modal leaves it open, the next round enumerates and clicks its
  contents, and Escape is sent only once nothing clickable remains — revealing the page underneath and
  continuing there. Two tests pin the ordering in both directions.
- *Clicks that open a **new tab** are now followed (2026-09-01).* DevTools is bound to one tab, so a
  product that opened in a second tab was invisible: the inspected tab had nothing new, the sweep
  found nothing and exited — which read as "it just exits". Two changes keep navigation where we can
  see it:
  - `target="_blank"` is stripped from the link for the duration of the click and put back after;
  - `window.open` is redirected into the inspected tab while a sweep runs, via a control event, and
    restored to the exact original reference afterwards. Rewriting a page's navigation is a real
    change to its behaviour and has no business being on when nobody is testing.
  - The crawler's existing follow-the-click logic then treats it as ordinary navigation and sweeps
    where it landed.
- *An overlay that changes the URL no longer ends the sweep (2026-09-01).* The "a click navigated,
  stop here" check compared URLs, and a single-page quick-view pushes a route without loading a
  page — so the sweep returned the instant any overlay opened, which in plain sweep mode ended the
  whole run. A **document stamp** now distinguishes the two: it changes only on a real page load, so
  a route change within the same document leaves the sweep running and the overlay's controls get
  clicked, while a genuine navigation still hands off to the crawler.
- *The crawler no longer ignores overlays (2026-09-01).* Their controls were being clicked, but the
  crawl treated a page as something it had navigated to, so overlays were invisible to it in two
  ways:
  - **Links revealed by an overlay were never collected.** Link-gathering had been moved to *before*
    the sweep so a page-breaking click could not lose the queue; that also meant anything a click
    opened was never looked at. Links are now gathered both before and after, and merged.
  - **An overlay's route was never recorded.** Routes pushed without a page load are now reported per
    page ("overlays: /product/1") **and queued for a proper visit** — the same URL loaded as a page
    can fire different events than it does as a panel, so sweeping it in place is not a substitute.
- *Same-origin iframes are now swept (2026-09-01).* Content scripts run in the top frame only, so
  anything inside an iframe was invisible — never enumerated, never clicked, unreachable by the
  pointer. Enumeration now walks into same-origin frames, the click command searches them, and the
  pointer adds the frame's own offset so it lands on the right element rather than somewhere in the
  top document.
  - **Cross-origin frames remain out of reach** and are now *counted and reported* per page rather
    than silently reducing coverage. Reaching into them needs `all_frames: true` plus frame-targeted
    messaging, which widens injection to every third-party frame on every site — squarely against
    the scope concern already raised.
  - *Decision taken 2026-09-01:* `all_frames: true` was adopted, so cross-origin frames are reachable
    too. Frames announce themselves on load so the panel learns their ids from `sender.frameId`;
    `sendAll` merges every frame's controls and `sendTo` routes each click back to the frame it came
    from. Control identity became `frameId:selector`, since per-document ids can collide across
    frames. See D15 — including the cost: we now run inside every third-party frame on every page,
    which makes the Phase 6 permissions work more pressing rather than less.
  - *Frame discovery fixed (2026-09-01):* frames announced themselves at page load, but the panel's
    listener only starts when the panel opens — so on any page that loaded first, every announcement
    was missed and the driver knew only the top frame. The panel now **asks** every frame to report
    itself before enumerating, and each answers with its own message (a broadcast `sendResponse`
    delivers only one reply, so answering that way would have lost all but one).
  - Each page reports how many frames answered ("3 frames" / "top frame only"), so a discovery
    failure is visible rather than showing up as quietly reduced coverage.
- *Three fixes from the first working click log (2026-09-01):*
  1. **Links are now clicked while crawling.** Most controls on a storefront are `<a href>` — tiles,
     categories — classified `navigates` and skipped. That default predates the crawler being able to
     follow navigation; it now means the crawl barely touched the page. Links are included
     automatically in crawl mode, and the checkbox says so.
  2. **Wrapper labels were unreadable** — a card reported as "Mary JaneView CartFree Shipping
     unlocked 🎉2", the concatenated text of everything inside it. A control is now named by its own
     text nodes, falling back to inner text only when it has none of its own.
  3. **"(unnamed)" told us nothing** about a payload with no recognisable name. The log now lists the
     payload's own fields instead, which shows whether a name is hiding under a key we do not know.
- *Sweeping now carries on by itself when the page changes (2026-09-01), on by default.* Landing on a
  new page previously meant pressing the button again. The panel listens to DevTools' own navigation
  events — no extra permission — and starts a sweep of wherever browsing went. It only fires when
  nothing is already running, since a crawl navigates constantly by design and would otherwise tear
  itself down and restart on every page it visited.
- *Open, and probably not a code problem: iframes still not clicked.* The most likely cause is
  Chrome's per-extension **site access** being set to "On specific sites" — a cross-origin iframe is a
  *different* origin from the page, so its content script never runs and the frame never answers. The
  per-page frame count ("3 frames" / "top frame only") is the diagnostic. If it reads "top frame only"
  with site access on all sites, the remaining candidates are sandboxed frames (which block scripts
  outright and cannot be worked around) or frames added after enumeration.
- *Site access was confirmed as "on all sites", so the cause is elsewhere.* Rather than guess a fourth
  time, the panel now **lists the frames that answered** — id and URL — per visited page. Guessing why
  iframes are missed is not diagnosis; the list distinguishes "no frame answered" (injection or
  discovery failing) from "frames answered but held no controls" (enumeration), which need different
  fixes.
- **Forms can now be filled before clicking (2026-09-01), at the user's request.** Events that need
  input — `Searched`, `Sign in` — were unreachable however thorough the sweep was: an empty search
  box produces no search event. The panel takes `field: value` rules (search, email, phone, pincode,
  name and so on, editable), and the sweep types them into matching fields before enumerating, and
  again after each click, since a click can reveal a form that was not there a moment ago.
  - Fields are matched on name, id, placeholder, aria-label or wrapping label text.
  - Values are set through the native property setter followed by input/change events — a plain
    assignment is ignored by frameworks that track their own value, so the field would look filled
    and submit empty.
  - **Passwords are never filled**, and fields the user already filled are left alone. Filling a
    password and clicking submit is how an unattended sweep signs itself into a real account.
  - Fields inside frames are filled too.
- **The sweep now stops and hands unknown forms to the tester (2026-09-01).** Pre-written values only
  cover fields we can guess at, and no list ever covers what an arbitrary site asks for. When a
  control would submit a form that still has blank fields, the sweep pauses and the panel names them
  — "Phone number", "OTP" — as the page itself labels them. The tester fills the form in the browser
  and chooses **continue**, **skip this one**, or **stop**.
  - Detection is by intent, not guesswork: a `type="submit"`, anything inside a `<form>`, or wording
    like Search / Verify / Continue / Sign in. An ordinary Close button never triggers it.
  - Fields already filled — by the tester or by the value rules — are not counted, so a form that is
    ready to go is simply clicked.
  - **Time spent waiting is added back to the run limit**, so a 10-minute crawl is not consumed by
    someone typing an OTP.
  - The `field: value` rules remain for the fields that *are* predictable, mostly search boxes; they
    reduce how often the sweep has to stop rather than replacing the pause.
- **Hovering and dwelling were added alongside clicking (2026-09-01).** A whole class of events is
  produced by the pointer arriving and resting, or by a region coming into view and staying there,
  and no amount of clicking will ever fire one — they were unreachable however thorough a sweep
  was. Two triggers now run as part of every sweep, both on by default:
  - **Hover with dwell before each click.** The pointer is moved onto the control, left there for
    700ms, then moved off — over/out *and* enter/leave, with coordinates, since a page may listen
    for either pair and handlers commonly read the position. 700ms clears the 300–500ms
    hover-intent thresholds sites use, so a deliberate hover is not read as the pointer passing
    over on its way somewhere else. This is also what a visitor does on the way to clicking, so a
    sheet's `Banner` event — `hover_time` plus `banner_click` — is produced by one gesture.
  - **A dwell at each step of the scroll pass.** The pass already existed but rested 180ms per
    step, purely to load lazy content. It now rests 1.2s when observing, because anything driven
    by an IntersectionObserver with a time threshold needs the page to actually stop where it is.
  - *Cost:* one hover per control **group**, not per control, so the existing repeat-collapsing
    caps it. Switching the toggle off restores the previous timings exactly.
  - **The capture window opens before the hover, not after.** A `hover_time` fires on the way out
    of the hover — before the click — so a window opened after hovering would have lost it and the
    control would have looked silent. A test pins this.
- *Deliberately not built: faking page lifecycle.* `Session Engagement Summary` and the idle/active
  timers flush on `visibilitychange`/`pagehide`. A synthetic event can be dispatched, but
  `document.visibilityState` cannot be changed from the isolated world, so any handler that reads
  the property — which is most of them — would see `visible` and ignore the event. Spoofing it
  would mean patching the property from the MAIN-world capture script, which is a real and risky
  mutation of the page for an unverified gain. Left alone until there is evidence it is needed.
- *Still to be measured:* how far this moves real coverage. The estimate that gating rather than
  detection is the main gap is read off the event sheet, not observed — the next run on a
  logged-in session is what settles it.

---

## Phase 5 — Reporting & Persistence

**Goal:** Turn results into something reviewable and reusable across sessions.

- [x] Full dashboard (site, SDK status, event sheet name, event count, tests passed/failed/not-tested) — debug status still lives in the status bar, not the dashboard
- [x] Event details view per event (expected vs actual, per-attribute status table, raw object viewer)
- [ ] Test history stored in IndexedDB — open / delete / export past runs
- [ ] Client profiles (client name, website, event sheet, platform, notes) for repeat testing without reconfiguring
- [x] Export: JSON
- [x] Export: CSV
- [ ] Export: XLSX (summary sheet + detailed per-attribute sheet + raw debug objects sheet) — written as a **new** report file, never back into the uploaded Event Sheet

**Exit criteria:** Complete the full MVP acceptance flow end to end (spec section 45) and export a report in all three formats without modifying the original Event Sheet.

**Phase 5 record — 2026-09-01 (in progress)**

- *Status:* PARTIAL. Dashboard, per-event detail, JSON and CSV export are done and verified. History,
  client profiles and XLSX export are **not started** — see below.
- *New pure module* (`src/reports/`): `types.ts` (`RunReport`, `EventOutcome`, `RunTotals`),
  `build.ts` (`buildReport`, `reportFileName`), `export-csv.ts`. No DOM, no `chrome.*`, no clock —
  the run's moment is passed in.
- *Verdict logic moved out of the component.* `PageSweep.tsx` had been matching events and calling
  `validateEvent` inside a React component, against the project's own rule that components render
  state rather than compute verdicts. That logic is now `buildReport`, which is what the dashboard,
  the detail view and both exports all read from — previously nothing but the component could see it.
- *`NOT SEEN` is deliberately not a failure*, and the dashboard says so in words. An event that never
  fired may be unimplemented or may sit behind a flow the run never reached; the run has no evidence
  which, and reporting it as FAIL would manufacture defects. Two tests pin it.
- *An event that fired without a readable payload counts as untested, not passed* — nothing was
  checked, so counting it as a pass would inflate the passing total.
- *Every report states its channel.* `channel: 'debug-payload'` is a field on the report and a line
  on the dashboard, so no reader can assume the network call was verified when it was not. Required
  by the Terminology section above; tested at both the builder and the component.
- *CSV is one flat row per checked field*, repeating the event name, because a spreadsheet user's
  first move is to filter a column. Values beginning `=`, `+`, `-` or `@` are prefixed with a tab:
  an Event Sheet is untrusted input and must never arrive as something Excel offers to evaluate.
  Tested.
- *Downloading happens at the composition root.* `browser-download.ts` is the only new file touching
  the DOM; `App` takes a `download` prop from `main.tsx` and passes it down. No `downloads`
  permission was needed — the manifest is unchanged.
- *Verified:* `pnpm build` clean, `pnpm test` 414/414 across 27 files (18 new in `src/reports/`,
  6 in `Dashboard.test.tsx`). Not yet exercised against a live site.
- *Deliberately deferred, with reasons:*
  - **XLSX export.** `read-excel-file` cannot write, so this needs a new dependency, and the project
    requires a stated reason for one. The realistic options — SheetJS, or a minimal writer over a zip
    library — differ enough in weight and supply-chain risk that the choice should be made
    deliberately rather than folded into this pass.
  - **Test history in IndexedDB** and **client profiles.** Both are storage concerns rather than
    reporting ones, and both need `RunReport` to be stable first. It now is, and it was designed to be
    serialisable for exactly this reason.
- **Two defects the first live report exposed, both fixed (2026-09-01).** A run against ethniq.com
  reported 5 passed / 0 failed / 75 not seen. All five passes were false.
  1. **The wrong object was being validated.** Smartech logs a session *envelope* — `user_key`,
     `sid`, `url`, `eventname` — with the event's own fields nested one level down under `payload`.
     `payloadSubject` returned the envelope, so the sheet's fields were compared against session
     bookkeeping: every expected field read `missing` and every real field read `extra` as
     `payload.*`. `unwrapEnvelope` now descends one level, and only when the outer object also
     names the event — a payload that merely has a `data` key of its own is a payload, not an
     envelope, and descending into it would validate a fragment. `activity_params` and
     `activity_name` are recognised too, since that is the shape Netcore's own activity API uses.
  2. **A payload with none of the expected fields passed.** The sheet had no mandatory column, so
     every field was optional; nothing was required, nothing mismatched, and the event went green
     with all five fields missing. `decideStatus` now fails an event where every expected field is
     absent. Absence of evidence is not a pass — that verdict is the one thing a validator must
     never get wrong. An event the sheet gives no fields is unaffected.
- *Confirmed by the same report: merged sub-events are being fired inside their parent, as the
  sheet's PayloadTab specifies.* `cart viewed` arrived carrying `product_id`, `variant`,
  `new_quantity`, `removed_product_ids` and `removed_count` — the fields belonging to Cart Drawer
  Opened, Cart Item Quantity Changed (Drawer) and Cart Items Removed (Drawer). Those three are
  listed NOT SEEN and always will be; they have no event names of their own. The denominator work
  noted below is what makes that legible rather than misleading.
- *Also visible in that report, still open:* event names carry the sheet's own inline notes —
  `"Subscription Payment Failed\nneed to pass in checkour event"` — because the note sits in the
  event-name column. They match nothing and inflate the sheet's event count.
- **Two guards were skipping most of the cart drawer, both narrowed (2026-09-01).** A run on the
  cart overlay showed the sweep paused on a discount box, with the drawer's own controls untouched.
  The overlay was being enumerated correctly; the controls inside it were being filtered out before
  they were ever clicked.
  1. **The destructive guard matched bare words.** `order`, `remove`, `delete`, `cancel` and
     `subscribe` on their own classified a large part of every site as money-spending: "Order
     Details", "Order Tracking", "Reorder" and "My Orders" all contain `order`; a cart line's remove
     button contains `remove`; "Newsletter Subscribe" contains `subscribe`; every dialog's Cancel
     button contains `cancel`. Several of those produce events the sheet asks for — `Remove from
     Cart`, `Order Details Viewed`, `Order Tracking Clicked`, `Reorder Clicked`,
     `Newsletter Subscribed`, `Address Deleted` — so the guard was hiding exactly what the run
     existed to find. It now matches phrases: `place order`, `delete my account`,
     `cancel subscription`, `proceed to pay`. Bare `order`, `remove`, `delete` and `cancel` are
     safe. Same reasoning as the `sign in`/`sign out` split — the distinction lives in the phrase.
     Tests pin both directions, including the previous behaviour that changed.
  2. **The form pause stopped for optional fields.** A cart drawer's Apply button sits beside a
     DISCOUNT CODE box, so `formNeeds` reported a blank field and the sweep stopped to ask a human
     — on every cart, before any drawer control had been clicked. One pause blocked the whole
     overlay. Where a page marks fields required, only those now count; where it marks nothing,
     every blank field still counts except names that are optional by definition (discount, coupon,
     promo, voucher, gift card, referral). An OTP or address form still stops the run.
- *Worth noting for whoever reads the earlier overlay work:* none of the overlay handling was wrong.
  Enumeration, lazy dismissal and route capture all did their job. The controls were found and then
  discarded by a filter, which is why it read as "overlays are not tracked".
- **The crawl is now depth-first, and finishes a page it left (2026-09-01).** It was abandoning
  almost every page after a single click, which is why it looked like it was barely moving.
  - *What was wrong:* `sweepPage` returns the moment a click causes a real page load, and the
    crawler put the new page at the front of the queue. The page it came from was already in
    `seen`, so it was never opened again — every control after the one that navigated was dropped.
    On a storefront the first link click navigates, so most pages contributed exactly one click.
  - *What it does now:* a page that navigates goes on a **stack**. The page it landed on is swept
    to exhaustion, then popped, and the page underneath is reopened and resumes from the control
    after the one that took it away. Clicking a tile now reaches the product page, sweeps all of
    it, and comes back for the next tile.
  - *What made resumption possible:* control identity that survives a reload. `data-sv-id` is
    stamped per page load, so returning to a page renamed every control — the sweep would have
    restarted at the top, clicked the same link, and navigated away again forever. `withStableKeys`
    names a control by frame, kind and label plus an ordinal for repeats, which the same DOM
    reproduces on every load. **Both identities are used together**: the element id stays the exact
    check while a document lives, and the stable key is asked only to survive a reload, since a
    re-render that reorders the list would drift the ordinals.
  - *Cycles terminate.* Clicks spent are held per page URL rather than per stack entry, so A → B → A
    resumes A rather than restarting it. A page already on the stack is not pushed again; the crawl
    simply navigates back to it on the next round.
  - *A page swept over several visits is reported once*, with its observations merged. Reporting it
    once per visit would make a thorough crawl look like it was going in circles.
  - *A page that dies mid-sweep is no longer fatal* — it is recorded and popped, and the crawl
    carries on with its queue. Only cancellation stops everything. A test that had pinned the old
    "already there, so do not navigate" rule was updated: not re-navigating to the page a click
    landed on still holds, but navigating *back* is now expected and is the point of the change.
- **The crawl circled the navbar and never reached a page's own buttons. Two causes, both fixed
  (2026-09-02).**
  1. **Controls were picked in document order, and the navbar is always first.** A navbar link is
     classified `navigates`, and a navigating click ends the sweep — so every page spent its clicks
     walking the header away to somewhere else and never got to its own body. No Add to Cart, no
     quantity control, no tab, no accordion, none of the controls the sheet's events actually hang
     off. The sweep now takes **everything that stays on the page before anything that leaves it**:
     the page's own buttons first, links last, which is also what makes the depth-first descent
     meaningful — a page is finished before the crawl follows it anywhere.
  2. **Group memory was rebuilt on every sweep.** `produced`, `barren` and `tried` were locals of
     `sweepPage`, so they reset on every page *and* on every resumed visit to a page. The navbar is
     the same component sitewide, so its links were clicked in full again and again, each costing a
     navigation away and a navigation back — which is what the circling looked like. That state is
     now a `GroupMemory` the crawl owns for its whole life and passes in, so a group that stops
     producing new events retires once and stays retired.
  - *Consequence worth stating:* a group is retired on evidence, not on a name. Nothing in here
     knows what a navbar is — it is `BARREN_TRIES` clicks with no new event, applied to any kind of
     control. A header whose links each fire a distinct `Sidebar Nav Clicked` payload keeps being
     clicked, which is the desired behaviour.
  - *A fixture that fired no events had to be corrected rather than the code:* it clicked three
    controls of one group and expected all three to be tried, which the barren rule now correctly
    refuses. Firing a distinct event per click — what a real page does — restored it.
- *Not yet done from this phase's checklist:* the dashboard shows the run's own totals but is not
  wired to the SDK/debug status bar as a single view; the two still render separately.


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

## Field Defects — ethniq.com, 2026-09-01

Found in the first live session against a real client site, testing by hand (log in, browse the
profile area) rather than by sweep. All three are fixed; none belong to a phase.

- [x] **Run summary ignored everything not triggered by the sweep.** `PageSweep` built the report
  from `outcome.captured`, i.e. `payloadsSince(runStart)`. A manual session reported "5 passed,
  0 failed" while the payload stream held seven passing events and a **failing `banner`** fired
  ~64s before the run started. The report now reads the whole stream; clearing the stream is what
  scopes a run. Files: `src/devtools/panel/components/PageSweep.tsx`.
- [x] **Capture stats were meaningless on any page with iframes.** The manifest injects with
  `all_frames: true` and every frame reports every 2s, but `subscribeStats` forwarded each message
  straight to `setStats` — so the panel showed whichever frame reported last. ethniq.com displayed
  "Watched 0 console lines" while capture was working and 22 payloads were on screen. Stats are now
  summed per frame, and the "nothing matched" explanation only draws on frames that matched
  nothing. Files: `src/devtools/panel/chrome-payload-source.ts`.
- [x] **`Product Viewed (Front End)` could never pass.** A sheet qualifier in parentheses diluted
  the Dice score: `product viewed` scored 0.67 against it but 0.80 against `Product List Viewed`,
  so PDP views were validated against the list schema and the correct event reported NOT SEEN
  forever. `closest()` now also scores each sheet name with a trailing parenthetical removed.
  Verified against all 84 names in the client sheet: fixes the mis-route, introduces no new one,
  and stripping produces no name collisions. Files: `src/validation/match-event.ts`.

- [x] **Column detection gave up on the client sheet, and the manual mapping it fell back to was
  set one column off.** `collectCandidates` files a column under whichever role *that column*
  scores highest for, so `payloadName` collected `Payload Key`, `Array Payload Key`,
  `Payload Description` and `Field Type (Contact Attribute / Payload)` — four claimants, therefore
  ambiguous, therefore the manual mapping form. Mapped to `Payload Data Type` instead of
  `Payload Key`, every event's schema had fields named `string` and `array`; nothing in any payload
  matched, and `validate.ts:102` (every expected field missing → FAIL) failed all eight events that
  fired. Detection now resolves a role to the column that outscores every other claimant, deferring
  only on a genuine tie at the top. The real sheet resolves to eventName=1, payloadName=6,
  payloadType=8, attributeName=3, attributeType=4. Files: `src/event-sheet/detect-columns.ts`.

**Verified:** `pnpm typecheck`, `pnpm test` (441 passing, 27 files), `pnpm build`. Each fix has a
regression test; the report-scope test was confirmed to fail against the old scoping before being
kept.

## Validation Policy — set with the tester, 2026-09-01

The verdict rules, as decided while testing ethniq.com live:

| Observation | Verdict | Why |
|---|---|---|
| Payload carries keys the sheet does not describe | PASS | Analytics payloads always carry SDK and site-specific extras. Recorded as `extra`, never scored. |
| Sheet's key absent, payload has an equivalent key (`product_id` / `prid`) | WARNING | The data arrived in the right shape. What is wrong is that the sheet and the implementation disagree on the name. |
| Value is the wrong data type | FAIL | A data defect, and it outranks a naming one — a renamed key holding the wrong type fails. |
| Mandatory key genuinely absent, no equivalent | FAIL | Unchanged. |
| Optional key present but null or empty | WARNING | Unchanged. |

- [x] Renamed fields no longer read as missing. `findRename` compares payload keys the way event
  names are compared, over a Smartech abbreviation table (`prid` → product id, `prqt` → quantity)
  because token overlap alone scores those at zero. A rename warns however mandatory the field is;
  the key it consumed is no longer double-reported as an `extra`. An ancestor path is never taken
  as a rename of the key inside it. New: `src/validation/match-field.ts`,
  `src/validation/name-similarity.ts` (the tokenise/Dice pair, now shared with `match-event`).
  Changed: `src/validation/validate.ts`, `src/validation/types.ts`, `VerdictDetail.tsx`.
- [x] Removed the sweep's "Values to type into forms" box and the auto-fill behind it. Form values
  differ per site, so a canned rule list was never going to fit one; the sweep already pauses and
  hands the form over, which is what the tester wanted. `formNeeds` — the pause detector — stays.
  Deleted: `fillFields`, `FieldRule`, `DEFAULT_FIELD_RULES`, `parseFieldRules`,
  `formatFieldRules`, the `fill`/`filled` command pair, and their tests and CSS.

**Verified:** `pnpm typecheck`, `pnpm test` (438 passing, 28 files), `pnpm build`.

---

- [x] **API-source events are no longer reported as "never fired".** The sheet's
  `Source (Frontend / API)` column is now a mapped column role, carried onto `EventSchema` as
  `source`, and an unseen `api` event reports **API ONLY** with "It's an API event — check the
  Smartech panel" instead of NOT SEEN. They are excluded from `notTested` and from the new
  `reachable` denominator, so the summary counts against what the browser could actually produce.
  An API event that *does* turn up in the browser is still validated normally — the sheet can be
  wrong about the source, and something that fired is real evidence. Verified end to end against
  the client sheet: source column detected at index 12, 11 events classified `api`, totals
  `reachable 73 / apiOnly 11` before any browsing. Files: `src/event-sheet/types.ts`,
  `detect-columns.ts`, `normalize.ts`, `src/reports/types.ts`, `build.ts`, `Dashboard.tsx`,
  `PageSweep.tsx`.
- [x] The resolved column mapping is now stated on screen ("Reading `Event Name` as the event and
  `Payload Key` as the payload key") with a **Change columns** button that reopens the mapping
  form on the columns in use. Detection resolving is not a reason to hide its choice — the wrong
  mapping is silent, and previously the form only ever appeared when detection gave up.

**Verified:** `pnpm typecheck`, `pnpm test` (442 passing, 28 files), `pnpm build`.

- [x] **Merged events are validated inside their parent's payload.** A sheet row saying
  `\U0001F500 Merge into "Product Viewed" event \u2014 do not fire separately` means the child's fields
  are expected *inside* the parent's payload, so that is where they are now checked \u2014 PASS / FAIL /
  WARNING like any other event, with "checked inside `<parent>`" on the row. Previously all 23
  reported NOT SEEN, which read 23 correct implementations as 23 gaps.
  - The directive is read from *any* cell on the event's naming row, because sheets put it in
    Status, Implementation Status or Notes. The quoted name is required \u2014 it is what bounds the
    name \u2014 and a directive naming something that is not an event in this sheet is discarded, which
    is the guard against reading a stray sentence as a merge.
  - The parent is resolved with `matchEvent`'s close matching: the sheet writes `"Product Viewed"`
    where the event is called `Product Viewed (Front End)`. 15 of the 23 need this, and it only
    works because of the qualifier fix recorded above.
  - The parent's other keys are stripped from the child's `extra` list \u2014 they belong to the parent
    and its other merged children, not to this one.
  - A merged event that fires on its own is flagged `firedSeparately` and still validated: the
    sheet and the site disagree, but the payload it carried is real evidence.
  - Verified against the real captured `page view front end` payload: `Page Idle Time` and
    `Page Active Time` both PASS inside `Page View (Front End)`. That also settles an earlier
    finding \u2014 the six keys reported as "not in sheet" on Page View were these two children's
    fields, correctly implemented. The sheet is not stale after all; the tool could not see the
    relationship.
  Files: `src/event-sheet/types.ts`, `normalize.ts`, `src/reports/types.ts`, `build.ts`,
  `PageSweep.tsx`.

**Verified:** `pnpm typecheck`, `pnpm test` (450 passing, 28 files), `pnpm build`.

- [x] **The sweep retired a whole kind of control after its first success.** `exhausted()` treated
  a group as finished once any member produced an event \u2014 right for a product grid, wrong for the
  controls coverage depends on. A row of profile tabs is one component, so clicking
  `Order History` retired `My Subscriptions`, `My Cards` and `Recently Viewed` before they were
  ever tried, and the tester was told to click them by hand. A group is now exhausted when it
  stops producing *new* event names: `BARREN_TRIES = 2` fruitless clicks, with
  `MAX_TRIES_PER_GROUP = 12` as a hard ceiling. A grid costs three clicks instead of one; a row of
  five distinct tabs now gets all five. Files: `src/automation/crawl.ts`.

**Verified:** `pnpm typecheck`, `pnpm test` (451 passing, 28 files), `pnpm build`.

**Deferred:
- `WhatsApp Opt-in` does not match a site-fired `whatsapp_opt_in` (0.571, below the 0.6 threshold):
  the camelCase splitter reads `WhatsApp` as `whats app`. The event is 🚫 Blocked in the sheet, so
  it cannot fire yet. Fixing it means touching the splitter, which is load-bearing for every other
  name — not worth it until the event exists.
- The report still cannot distinguish "unimplemented" from "this session never reached the flow".
  Of the client sheet's 84 events, only 48 can fire in a browser at all — 23 are merged into a
  parent, 11 are API-source, 2 are blocked — so "79 not tested" overstates the gap badly. The
  summary should count against what is reachable, not against the raw sheet total.

---

### Working note for whoever runs this in Claude Code

Feed one phase at a time. After each phase: build it, run the tests, check for TypeScript and extension errors in `chrome://extensions`, verify the exit criteria manually, and only then move to the next phase. Don't let it generate multiple phases' worth of code in one pass.