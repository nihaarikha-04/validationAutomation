# Architecture decisions

Confirmed findings that constrain later phases. Each entry states what was checked and what it
forces us to do.

---

## D1 — DevTools cannot be opened by any script; the panel is user-opened only

**Confirmed.** Chrome exposes no API to open DevTools. The `chrome.devtools.*` namespace only exists
inside a page loaded from `devtools_page`, and that page is loaded by Chrome *at the moment DevTools
opens* and torn down when it closes. A panel created with `chrome.devtools.panels.create()` returns an
`ExtensionPanel` with `onShown`/`onHidden` events but **no** `show()` — the extension cannot even
select its own tab once DevTools is open, let alone launch DevTools.

**Consequences, binding on later phases:**
- The panel is the primary UI (PLAN Phase 0) but it is not a reliable *runtime*. It may not exist when
  the events we care about fire.
- Anything that must observe the page from first paint — the `window.smartech` interceptor in Phase 2
  — has to live in the content script at `document_start`, never in the panel. The panel is a viewer.
- Captured events must be buffered outside the panel (service worker / storage) and replayed when the
  panel opens, or events fired before the user opened DevTools are lost.
- The panel must tolerate being created and destroyed repeatedly within one page session.

---

## D2 — SDK detection and debug enable are a single action

**Confirmed as the approach.** There is no separate "is Smartech present" check worth making. Calling
`smartech('debug', '1')` inside a `try`/`catch`, under a retry loop with a configurable timeout, is
both the detection and the enable:

- **No throw** → `smartech` is defined and callable, and debug mode is now on.
- **Throws** (`TypeError` when `window.smartech` is undefined, or an SDK-thrown error) → not detected;
  retry until the timeout, then report with a diagnostic message.

The retry loop is required because the Smartech snippet loads asynchronously — absence at
`document_start` says nothing about absence at `t+2s`.

**Known limitation, carried into Phase 2:** if the site's snippet uses the common queuing-stub pattern
(a stub function defined synchronously that buffers calls until the real SDK loads), the call will not
throw even though the SDK has not initialised. *Not throwing therefore proves a callable exists, not
that the SDK is live.* Real initialisation is confirmed only by observing the first genuine debug
event. Phase 1 reports this as "detected"; Phase 2 must upgrade that to "confirmed" on first event.

---

## D3 — `read-excel-file` for reading workbooks, not SheetJS

**Chosen:** `read-excel-file@9`, imported from its `/browser` subpath.

SheetJS (`xlsx`) is the obvious default, but the version published to npm is stuck at **0.18.5**,
which predates the fix for the prototype-pollution advisory affecting `<0.19.3`; newer SheetJS builds
are distributed only from the vendor's own registry. An Event Sheet is untrusted input by our own
coding rules, so shipping a parser with a known advisory to parse it is the wrong trade.

`exceljs` was the other candidate. It is maintained, but it is a read *and write* library built around
Node streams and Buffers, which needs polyfilling to work in a browser bundle. We only read here.

**Consequences:**
- The library is imported as `read-excel-file/browser`; the package publishes no bare entry point, only
  subpaths (`/browser`, `/node`, `/web-worker`, `/universal`).
- Its published types disagree with its runtime shape: it returns `[{ sheet, data }, ...]` for the whole
  workbook even when a `sheet` option is passed. `parse-xlsx.ts` validates that shape at runtime rather
  than asserting it, so a library upgrade that changes it fails loudly.
- **Phase 5 still needs an XLSX writer** for report export. This decision does not cover it. Choose the
  writer then — the reader sits behind `readWorkbook()` and can be swapped without touching callers.

---

## D4 — An Event Sheet row is one field seen through two channels

**Confirmed with the client-side owner.** The Event Sheet carries four field columns, not two:
**Payload** and **Payload Data Type**, then **Attribute** and **Attribute Data Type**.

They are **paired per row**. One row is one logical field of the event, recorded under the name it
carries in each channel — `product_id` in the debug payload is `prid` in the network call. The
datatypes are recorded separately because the two channels do not always agree (a number in the
payload can arrive as a string once form-encoded).

**Model:**

```
FieldSchema { payloadName, payloadType, attributeName, attributeType, required, description, example }
EventSchema { name, fields: FieldSchema[] }
```

`required`, `description` and `example` belong to the pair, not to one channel.

**Consequences:**
- Either side may be blank. Sheets documenting only the debug channel are common, and attribute-only
  sheets are legal, so detection requires an event-name column plus **at least one** of the two name
  columns — not both.
- `AttributeType` was renamed `DataType`: it now types either channel, so a channel-specific name
  would have been misleading.
- Detection carries eight roles. A header naming its channel ("Payload Data Type") resolves directly;
  a bare "Data Type" scores equally for both type roles and is broken by **adjacency** — it belongs to
  the name column it immediately follows. Following neither, it stays ambiguous and goes to the user.
- Field identity follows the payload name where present, attribute name otherwise, because the payload
  is the channel the MVP validates.
- Phase 3 validates the payload side. Phase 7 validates the attribute side and reuses the same engine,
  which is why the validator must take a plain object rather than "a debug event".

---

## D5 — Capture runs from two content scripts, and that ends the zero-permission manifest

D1 established that the panel is a viewer, not a runtime: it cannot be opened by script and may
not exist when events fire. Interception therefore has to run in the page at `document_start`,
which means content scripts.

**Two of them, because they need different worlds:**

| Script | World | Why |
|---|---|---|
| `content/interceptor.js` | `MAIN` | Must see the page's real `window.smartech`. An isolated-world script sees a different global object entirely. |
| `content/bridge.js` | `ISOLATED` | `chrome.*` does not exist in the MAIN world, so the interceptor cannot message the extension itself. |

They communicate by `window.postMessage`, marked with `smartech-validator/payload` so page traffic
is ignored. The bridge imports nothing at all: the content bundle is built without code splitting,
and any shared import would emit a chunk that a classic content script cannot load.

**The honest cost:** the `permissions` and `host_permissions` keys are still absent, but
`"matches": ["<all_urls>"]` grants host access on its own. Chrome will show "Read and change all your
data on all websites". **The extension is no longer unprivileged, and claiming otherwise because the
permissions array is empty would be false.**

`<all_urls>` was chosen because the tool exists to test whichever client site the QA engineer is on;
an allowlist would need editing before every engagement. The tighter alternative — `optional_host_permissions`
plus `chrome.scripting.registerContentScripts` once the user grants a specific origin — is a real
option if this is ever distributed more widely. Revisit at Phase 6's security pass.

**Panel delivery:** content script → `chrome.runtime.sendMessage` → the panel's `onMessage` listener,
filtered on `sender.tab.id === chrome.devtools.inspectedWindow.tabId`. No service worker: runtime
messages already reach every listening extension context, and a relay would be unused indirection.

**Known gap, deliberate:** payloads fired while the panel is closed are lost. D1 anticipates buffering
and replay; nothing in Phase 2 needs it, and Phase 4 drives the actions from the panel itself, so the
panel is open by construction. Build it when a phase actually requires it.

---

## D6 — Interception wraps with a Proxy behind an accessor

Two problems shaped this.

**The SDK may not exist yet.** At `document_start` `window.smartech` is usually undefined, and the
snippet defines it later. So the wrapper is installed as an accessor: the getter always returns our
wrapper, and the setter captures whatever the site assigns. That also covers the second open
question — if the SDK redefines `window.smartech` after load, the setter simply re-targets, and
interception survives. There is a test for exactly that.

**A plain wrapper function would break the queuing stub.** The common snippet pattern stores buffered
calls on the callable itself (`smartech.q`). A wrapper function has no such property, so the real SDK
would later drain an empty queue and the site would silently lose its own early events. The wrapper is
therefore a `Proxy` forwarding `get`/`set`/`has`/`apply` to the real SDK. Its shell is an arrow
function, which has no `prototype` — a normal function's non-configurable `prototype` would violate a
Proxy invariant when traps forward elsewhere.

**Capture must never break the site.** If reporting throws, the call still forwards to the real SDK;
the error is rethrown on a clean stack via `setTimeout` so it surfaces in the console rather than being
swallowed. Site behaviour wins; the failure is still loud.

**Still open, and not answerable from here:** whether *this client's* snippet actually uses a queuing
stub, and whether it reinitialises. `docs/smartech-snippet-probe.js` answers both against the live
site. The interceptor is written to be correct either way, so the answer refines D2's "detected"
wording — it does not change the design.


---

## D7 — Payload serialisation is bounded, not just cycle-safe

**Found on a live site**, not in tests: `postMessage` threw
`RangeError: Maximum call stack size exceeded` and the capture was lost.

Cycle detection alone was not enough. `toTransferable` guarded against an object appearing twice on
one path, but nothing stopped it walking something merely *enormous* — and the per-key `try/catch`
turned the eventual stack overflow into tags, so serialisation "succeeded" and handed `postMessage` a
structure it could not clone.

**Bounds now applied:** depth 12, 200 keys per object, 500 array items, each truncation recorded as a
tag rather than silently dropped. DOM nodes and the global object are tagged by name and never walked
— they are never the payload and are the main source of explosive graphs.

**Belt and braces:** if `postMessage` still refuses a payload, the interceptor posts a degraded record
carrying the error instead of nothing, so a capture failure shows up in the stream as a visible gap.

**What this confirmed about D6:** the site's own `smartech()` call still forwarded correctly throughout.
Routing capture failures through `setTimeout` kept the failure loud while leaving the site's tracking
intact — which is the behaviour that mattered most.


---

## D8 — The wrapper must be falsy until the site installs its SDK

**Found on a live site**, as an infinite recursion inside the Proxy's `get` trap.

The near-universal Smartech snippet idiom is:

```js
window.smartech = window.smartech || function () { (window.smartech.q = window.smartech.q || []).push(arguments) };
```

D6's getter returned the wrapper unconditionally, and a Proxy is **truthy**. So `window.smartech || …`
took the *left* branch and assigned our own wrapper straight back to us. Two failures at once:

1. `target` became the Proxy itself, so every property read re-entered the `get` trap until the stack
   gave out.
2. **The site never installed its SDK at all.** The `||` never reached its right-hand side — we broke
   the tracking we exist to observe, which is the one thing D6 set out to guarantee.

**The corrected contract:**

- The getter returns `undefined` while `target` is undefined, so the `||` idiom takes its right branch
  and the site installs its own stub or SDK exactly as it would with no extension present.
- The setter ignores an assignment of the wrapper itself, so `window.smartech = window.smartech` can
  never make the wrapper its own target.
- Traps no longer forward `receiver`. Passing the proxy through would run the SDK's own getters with
  `this` bound to the proxy, routing their internal reads back through the traps — a recursion source
  capture does not need.

**Lesson worth keeping:** "wrap, never replace" is not only about forwarding calls. A wrapper that is
merely *present* changes behaviour when the page tests for presence. Both live bugs in this phase (D7
and D8) came from the page doing something the fixtures never did.


---

## D9 — A delegation bounce is identified by its arguments, not by counting

**Confirmed live.** The client's SDK captures `window.smartech` and delegates back into it, so
wrapper → SDK → wrapper cycles. The first attempt at containing this capped forward depth at 4 — and
the symptom that produced was one click on Add to Cart recording `add_to_cart` **four times**. Exactly
the cap. The guard stopped the crash and turned it into silent data corruption instead: four identical
payloads, which Phase 3 would have validated as four separate events.

**Depth was the wrong signal.** A bounce always re-enters with the *same argument values* as a frame
that is still open, whereas a site genuinely calling smartech from inside a smartech callback carries
different arguments and must still be captured. Comparing argument identity against the open call
stack separates the two exactly, with no counting and no arbitrary limit.

On a bounce the wrapper returns `undefined` without forwarding or reporting. That is also the correct
value: the delegation expects to reach the queuing stub, which returns nothing.

The depth cap survives as a backstop for a cycle that mutates its arguments between hops, and reports
a visible diagnostic if it ever fires.

**Lesson:** the guard that stops a crash is not automatically the guard that keeps the data correct. A
depth limit converted a loud failure into a quiet one, and only the "4 times" observation revealed it.


---

## D10 — Capture the debug log, not the `smartech` function

**Supersedes D6, D8 and D9.** Those three describe successive attempts to wrap `window.smartech`
safely. All three failed on the live site, each in a different way, and the third failure was the
decisive one: `smartech('create', …)` and `smartech('register', …)` stopped executing, so the SDK
never initialised and its versioning request never fired.

**Why wrapping could not be made safe.** The snippet's queuing stub buffers calls on the function
object itself (`smartech.q`). Our Proxy forwarded property reads to whatever `target` currently was,
so when the real SDK assigned itself, `target` flipped and the queue — which lived on the *stub* —
became unreachable. The buffered `create`/`register` calls were dropped silently.

That is not a bug with a fix so much as a category error. Any accessor or proxy over `window.smartech`
changes object identity that the snippet depends on, and the dependency lives in SDK internals we
cannot see. Three live failures in one phase is enough evidence.

**The replacement.** The SDK already prints what we want:

```
[Smartech Debugger] Firing EVT: 'Add to Cart' with payload:  {…}
```

So capture wraps `console.log/info/debug/warn` in the page's world, forwards every call untouched, and
records those lines whose first argument carries the Smartech prefix. `window.smartech` is not touched
at all.

**Why this is better, not merely safer:**

- It cannot break SDK initialisation. Nothing Smartech does depends on `console`'s identity.
- It captures the object the Event Sheet actually describes. Per the project's own terminology, a
  *payload* is "what you get in the debug logs" — the wrapper was capturing the call *arguments*, one
  step upstream, before the SDK's own enrichment. This resolves that open question by construction.
- The event name comes from the log line itself, so it no longer has to be inferred from argument
  positions.

**What it costs.** Capture now depends on debug mode being enabled — which is what the D2 detection
call is for — and on the log's prefix format. If Smartech changes that prefix, capture goes quiet
rather than wrong; a phase that needs certainty should assert on the first captured line.


---

## D11 — Validation engine shape

**Input is a plain object.** `validateEvent(payload, schema, timestamp, options)` takes a value, not a
`CapturedPayload`, and the timestamp is passed in rather than read from a clock. Phase 7 can feed it
decoded network attributes without the engine knowing where they came from.

**`ValidationResult.fields`, not `attributes`.** The plan specified the key as `attributes`, but that
predates the terminology fix: *attribute* now means the network-channel name specifically, so an
`attributes` array holding payload results would reintroduce the ambiguity we removed. Everything else
matches the specified shape — status, missing, extra, nullValues, emptyValues, typeMismatches, raw,
timestamp. A rename is one line if the export format needs the literal spec key.

**A sixth field status: `unverifiable`.** Phase 2's serialiser bounds (D7) replace clipped or cyclic
values with tags. Treating those as type mismatches would manufacture defects the site does not have,
so they warn instead of failing. The site may well be correct there; we simply cannot see.

**Verdict rules:**

| Condition | Verdict |
|---|---|
| Required field missing, undefined, null or empty | FAIL |
| Any type mismatch, required or optional | FAIL |
| Extra fields, policy `fail` | FAIL |
| Optional field present but null or empty | WARNING |
| A value we could not verify | WARNING |
| Extra fields, policy `warn` (default) | WARNING |
| Everything else, including a missing *optional* field | PASS |

A missing optional field is silent by design — it is normal, and warning about it would bury the
warnings that matter. A type mismatch fails regardless of whether the field was required: the site sent
something, and it sent the wrong shape.

**`extra` is always populated; the policy governs only the verdict.** `ignore` means "do not fail or
warn", not "do not tell me".

**Extra detection.** A payload leaf counts as covered when the sheet names it *or any ancestor* — a
sheet declaring `product` as an object vouches for everything inside it. Array indices are erased
before comparison, so `items[0].price` in the sheet covers `items[3].price` in the payload.

**Open question — array paths.** A sheet path of `items[0].price` is read literally: element 0 only.
If real sheets mean "every element", index 0 passing while index 3 is malformed would be a false PASS.
Deciding this needs a real sheet that uses array notation; wildcard support (`items[].price`) is a
small change once we know. Flagged rather than guessed.


---

## D12 — Page → extension handoff runs over a private DOM event

**Found on an unrelated site.** `netcore.freshdesk.com` threw `Invalid Origin` from inside our capture
wrapper. That page overrides `window.postMessage` — or rejects unexpected messages — and because we
inject on `<all_urls>` and it logged a `[Smartech…]`-prefixed line, we posted into its message channel.

`window.postMessage` is a **shared** channel: every listener on the page receives what we send, and the
page can replace the function itself. Using it made our internal handoff visible to, and breakable by,
sites we have no business affecting.

Capture now dispatches a `CustomEvent` named `smartech-validator:payload` on `document`, and the bridge
listens for exactly that. No page listens for it, and nothing we do reaches a page's message handlers.

**The detail is a JSON string, not an object.** The page and the extension run in separate JavaScript
heaps, and an object `detail` is not reliably readable from the isolated world.

**Wider point this exposed:** `<all_urls>` (D5) means every design choice in the content scripts is a
choice we impose on every site the user visits. The failure here was noisy rather than harmful — the
error was already routed through `setTimeout`, so the page kept working — but "we only act on Smartech
lines" was not as narrow as it sounded, because deciding whether a line is ours already required running
our code on every log statement everywhere. Worth weighing at Phase 6's security pass, alongside the
`optional_host_permissions` alternative.


---

## D13 — Smartech's debug prefix varies by integration

**The bug under everything else.** Capture matched `/^\s*\[\s*smartech\b/i` — a line *starting with
a bracket*. The mock site and one client site print `[Smartech Debugger] Firing EVT: 'x' with payload:`,
so it worked there. A real client site prints:

```js
console.info('Smartech debug', { …payload… })
```

No brackets. Every line was rejected, silently, and the panel faithfully reported nothing captured —
which read as the automation failing, and sent four rounds of fixes at the wrong layer.

**Fixed two ways:**

- The bracket is optional: `/^\s*\[?\s*smartech\b/i`.
- The event name is no longer assumed to be in the message. It is read from the message when present,
  otherwise from a name-ish key on the logged payload (`eventName`, `event_name`, `evtName`, `event`,
  `name`), including one nested level. Keys are compared with case and punctuation stripped, so one
  entry covers every spelling.

**The lesson worth keeping:** a matcher that silently rejects everything is indistinguishable from a
feature that does not work. Both look like an empty list. Capture should have said "7 console lines
seen, 0 matched the Smartech prefix" from the start — the diagnostic that finally found this took two
minutes and could have existed on day one.


---

## D14 — Wrapping console makes us the apparent source of every library's warnings

Three times now a library's own console warning has been reported as ours — Appcues, Freshdesk, Meta
Pixel — because Chrome prints a stack trace for console output and our wrapper is the innermost frame.

**This is unavoidable while we read console output.** Any wrapper adds a frame; there is no way to
observe a call and not be on its stack. The messages are not errors we cause, and the pages keep
working — but a developer clicking the source link lands in our extension instead of their code, which
is a real cost of the capture approach and worth stating rather than explaining away each time.

**What was worth fixing:** the wrapper now reports the original function's source from
`console.log.toString()` and keeps the original `name`. Analytics libraries do check whether console
has been tampered with, and some go quiet when they believe they are being watched — which would
defeat the entire point of observing them behave normally.

This covers `console.log.toString()`. It deliberately does **not** cover
`Function.prototype.toString.call(console.log)`, which ignores an own property: defeating that means
patching `Function.prototype` for the whole page, which is far more invasive than the problem warrants.

**The real mitigation for unrelated sites remains scope**, not stack traces — restricting site access
so we are not on pages nobody is testing. See D5 and D12.


---

## D15 — Injecting into every frame, to reach controls inside iframes

Controls inside iframes were invisible: content scripts run in the top frame only, so nothing in a
frame was enumerated, clicked, or reachable by the pointer. Same-origin frames were handled first by
walking into `contentDocument`, but cross-origin frames — which is what payment and widget iframes
usually are — stayed out of reach.

**`all_frames: true`** now injects both content scripts into every frame.

**The problem that creates, and the fix.** `chrome.tabs.sendMessage` without a frame id goes to every
frame and only one reply survives, so enumeration would describe a single arbitrary document. Frames
must be addressed individually, which means knowing their ids — and a content script cannot read its
own. So **each frame announces itself on load**, and the panel reads the id off `sender.frameId`. No
`webNavigation` permission needed.

- `sendAll` asks every known frame and merges the replies.
- `sendTo` routes a click back to the frame the control came from.
- A control's identity is now `frameId:selector`, because `data-sv-id` counters are per-document and
  two frames can produce the same id.
- Both methods are optional on `PageDriver`; a driver that knows nothing about frames still works and
  simply sees the top document. That keeps the sweep testable without simulating frames.

**The cost, stated plainly.** We now run inside every third-party frame on every page — ad frames,
chat widgets, embedded players. This widens the blast radius that D5 and D12 already flagged, on a
`<all_urls>` extension. It was chosen deliberately because a checkout flow that lives in an iframe is
exactly what this tool exists to validate, but it makes the Phase 6 permissions work more pressing,
not less.
