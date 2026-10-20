# Local embedding resolver — Phase 0 design

Status: **design for review. Nothing implemented.** Branch `trigger-automation`, from
`fix: Formatting Report`.

---

## 0. Why Gemini Nano did not work

The `LanguageModel` global was **absent entirely** on Chrome 156 — `availability()` was never
reachable, because the API object it lives on did not exist. That distinction is the whole answer:
had the API been present and returned `"unavailable"`, Chrome would have assessed the machine and
declined, which is a hardware verdict. An absent global means Chrome never exposed the API in that
context at all.

Two causes remain and both say stop. The documented gate is >4 GB VRAM, 16 GB RAM with 4+ cores,
22 GB free disk, desktop-only — and on Apple Silicon "VRAM" is unified memory, which Chrome
assesses by rules we do not control. Separately, the call was made from a **DevTools panel**, which
is an unusual extension context and may not be offered the API even where a popup would be. Neither
is fixable in our software, and both sit behind a multi-gigabyte separate download that was never
confirmed to have landed. **Not pursued further.** Proceeding to the embedding approach.

---

## 1. A premise in the brief that this branch does not meet

The brief says the resolver "does not replace the Event Sheet pipeline, the validator, the debug
interceptor, the finite test-executor, or the safety gate — those stay as they are", and asks to
"reuse whatever synonym handling already exists for the structured trigger syntax".

**On this branch, three of those do not exist.** Verified:

| Assumed to exist | Reality here |
|---|---|
| Trigger Condition column | **Not read at all.** No mention of a trigger in `event-sheet/types.ts` or `detect-columns.ts`. |
| Structured `click:`/`fill:`/`select:`/`wait:`/`navigate:` syntax | **Does not exist.** No parser, no synonym set to reuse. |
| Finite test-**executor** | `test-run.ts` is a state machine for **one action** — detect → confirm → execute → wait-for-event → validate. It cannot run a sequence of steps. |
| Target resolution (a named target → an element) | Does not exist. Only `detect-action.ts` keyword scoring. |

What genuinely is here and will be reused: the Event Sheet pipeline, the validator, the debug
interceptor, `findClickables` / `riskOf` / `groupOf` / `documentsIn` / `findAcrossFrames`,
`isDestructive`, `isPaymentEvent`, the single-action `test-run.ts`, and the panel.

**Consequence:** the embedding matcher cannot be dropped in to replace "prose-as-keywords", because
there is nothing downstream to act on a resolved target. A resolved element is only useful once a
*step representation* and a *step executor* exist. Sequencing in §9 reflects this — the embedding
model is the third phase, not the first.

## 2. One known issue, answered now

> *"A manual single-test run showed Action `add-to-cart` paired with Expected event 'Add to
> wishlist' — unresolved whether this was a UI display bug or a real internal mismatch."*

**It is a real internal mismatch, not a display bug.** `TestRunner.tsx:78`:

```ts
const [intent, setIntent] = useState<ActionIntent>('add-to-cart');
const [expectedEvent, setExpectedEvent] = useState('');
...
const runTarget: ActionTarget = active?.target ?? { kind: 'intent', intent };   // line 94
const runEvent = active?.eventName ?? expectedEvent;                            // line 95
```

Two independent form fields with nothing tying them, and the Action box defaults to `add-to-cart`.
Choose `wishlist_added` without also changing Action and the run clicks an **add-to-cart** control
while waiting for a wishlist event that cannot arrive — then reports the wishlist event as *not
triggered*, when nothing ever tried to trigger it.

**So an unknown share of the "10 not triggered" baseline may be this panel rather than the site.**
The baseline is not trustworthy until a re-run. Fix: derive the action from the chosen event and
delete the second dropdown. Small, and it should land before any measurement is taken.

## 3. Where the model runs

**The DevTools panel page.** Not the service worker: MV3 terminates it on idle and reloading a
model per wake is unaffordable. Not the content script: it would ship a model into every frame of
every site and runs under the page's own CSP. The panel already owns the page driver and lives
exactly as long as the tester is working.

## 4. Bundling and Manifest V3 CSP

**Shipped with the extension, not downloaded.** The stated requirement is no runtime network call;
bundling also pins the version, works offline, and survives a client's proxy. Files: the quantized
ONNX model, its tokenizer JSON, and `onnxruntime-web`'s `.wasm` binaries, all as local resources.

transformers.js must be told not to reach the Hugging Face CDN — otherwise it silently falls back
to a network fetch, which would defeat the entire point:

```ts
env.allowRemoteModels = false;          // a miss must fail loudly, not fetch
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = '/wasm/';
```

**CSP — confirmed, this is what is actually required.** WebAssembly needs dynamic code execution,
which MV3 forbids by default; `wasm-unsafe-eval` is the one documented exception
([Chrome docs](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)):

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

This is the first thing to change the manifest from its current state. Note it adds **no
permissions and no host permissions** — the manifest still declares none of either.

## 5. Candidate extraction

Extend `findClickables`, with one change that matters: it currently **excludes disabled controls**,
on the correct reasoning that clicking them tells you nothing. A resolver needs the opposite — a
disabled control is the page stating a precondition out loud, and on the live site the Add to Cart
button is disabled until a size is chosen in a modal.

Per candidate, the text to embed, in priority order: own text nodes (not `textContent` — a card
wrapping a button reads as everything inside it), `aria-label`, associated or wrapping `<label>`,
`placeholder`, `title`, `name`, `value`; and where the control has no name of its own, the nearest
preceding heading or `<legend>`.

Carried alongside but **not embedded**, because they are facts rather than semantics: tag, ARIA
role, disabled state, `frameId`, bounding box, and `riskOf`.

## 6. Matching

Cosine similarity between the sub-intent's target phrase and each candidate's text, then structural
filtering. **Similarity alone is not the ranking**, and this is the most important part of the
design:

- **Embeddings give recall.** "the search icon" → a button named Search; "Start Verification" → an
  event called `kyc_initiated`; "basket" → "cart". This is exactly the cross-vertical case keyword
  matching fails, and it is real value.
- **Structure gives precision**, and it does what embeddings cannot:
  - a control beats a wrapper or label that merely *describes* one
  - the innermost of two nested matches is what a person would press
  - it must occupy space — a responsive site carries a mobile and a desktop header in the same
    document and shows one; `display`/`visibility` cannot see this, `getBoundingClientRect` can
  - the role must suit the verb — `fill` wants a field, `click` wants something pressable

**Threshold.** Act only when the top score exceeds τ **and** beats the runner-up by a margin δ.
Starting points **to be tuned, not asserted**: τ = 0.55 cosine, δ = 0.08. Below τ → fall back to
the existing heuristic matcher; above τ but within δ → ambiguous → NEEDS REVIEW. Never act on a
tie: on the live site `label=search` matched five elements, and picking one silently is how a run
clicks the wrong thing.

**Tuning method.** A fixture set of (sentence fragment, saved page HTML, correct element) built
from real sheets and real pages, then sweep τ and δ. Optimise for **precision over recall** — a
wrong click costs the client, a NEEDS REVIEW costs a tester ten seconds.

## 7. What embeddings do not solve — stated now, not discovered later

1. **Negation.** *"click on a random item (not on the cart symbol)"*. "cart symbol" and "not the
   cart symbol" embed almost identically; the matcher will rank the cart icon top. This is not a
   tuning problem. It needs a rule-based prohibition extractor, checked in code before acting.
   On the live site the first step clicked exactly that cart symbol.
2. **Conditionals.** *"select size and color if one is required"*. No embedding resolves "if
   required". It needs the page's own answer — is the target disabled? — or a person.
3. **Identical text.** Five controls all named "search" embed identically. Only structure separates
   them.
4. **Preconditions.** An embedding cannot know Add to Cart is inert until a size is chosen. The
   page says so with `disabled` / `aria-disabled`; read it rather than infer it.

**So the honest claim:** embeddings replace *keyword matching*, and materially improve
cross-vertical recall. They do not by themselves deliver "understand the trigger condition and
perform it unattended". The gap in §7.1 and §7.2 is where a tester still has to intervene.

## 8. Multi-step prose, without an LLM

**Segmentation.** Split on sentence ends, `;`, `then`, `and then`, `after that`, numbered-list
markers, and a comma that precedes a verb. Two guards learned from the real sheet: never split
inside parentheses, and never on the full stop inside `e.g.` / `i.e.` — doing so turned
`(e.g. 'jacket')` into two fragments and lost the value the client had already supplied.

**Scene-setters are dropped, not run.** "On a product detail page", "While logged in", "From the
home page" describe circumstances; executed as steps they click things that are not controls.

**Verb synonym sets** (vertical-neutral, and there is no existing set to reuse — see §1):

| Kind | Words |
|---|---|
| click | click, tap, press, hit, open, go to, visit, navigate, select, choose, pick |
| fill | type, enter, fill, input |
| select | select/choose **an option**, pick from |
| navigate | go to / open / visit **a path** (no spaces — a URL, not a sentence) |
| ask | implied when the object is personal — see §8.1 |

`press` and `enter` are genuinely ambiguous ("press Submit" vs "press Enter"; "Enter OTP" vs the
Enter key) and are resolved by whether an object follows.

**Object cleanup**, each rule from an observed failure:

- strip trailing kind-nouns — icon, button, link, field, page, panel. Nothing is *called* "search
  icon"; it is called Search and has a picture on it
- stop at an alternative — "press Enter **or click the search button**" was targeting a control
  named "Enter or click the search"
- stop at a condition — "if one is required"
- drop a location tail — "in the header" says where, not what
- a quoted phrase after a **click** verb is the control's name; after a **fill** verb it is the
  value. `(e.g. 'jacket')` is a value

**Loop.** observe → next sub-intent → embed and rank → gate → act → **re-observe**. Re-extracting
after every step is mandatory, not an optimisation: the quick-view modal does not exist until
something is clicked.

### 8.1 Human-supplied values

A step may pause for a value only a person can give: `email | phone | password | otp | code | name
| address | file`. A closed set, which is the safety property — a run that can ask for anything can
ask for something nobody can answer and then wait for ever. Never fabricated; an invented email
burns the attempt and sometimes the account. Reused within a run **except** `otp` and `code`, which
are single-use by definition. A pause that times out reports as a pause, not a failure.

**`file` is not free**: a `File` cannot travel as a fill value, so it needs an upload command in
the content script building a `DataTransfer`. Flagged so BFSI KYC is not claimed before it exists.

## 9. The safety gate, independent of the matcher

Three layers, **none of which consults the embedder** — so it holds whatever sits underneath:

1. **Event name**, before anything is resolved: `isPaymentEvent`, widened beyond ecommerce with
   irreversible-commitment phrases — `submit application`, `confirm booking`, `confirm
   reservation`, `accept offer`, `sign agreement`, `e-sign`, `place bid`, `disburse`,
   `apply for a loan`. Phrases, not bare words: `submit` alone is every search box on the internet.
2. **The resolved element's own wording**, via `riskOf` — a safe event name never made the *route*
   safe, and reaching `add_to_cart` by way of "Place order" costs a real transaction.
3. **Re-checked on every step.** A multi-step loop can reach a commitment on turn nine, and a check
   that passed before turn one has nothing to say about it.

A gated step is **handed to a person**, not dropped: refusing to automate it is not refusing to
test it.

## 10. Realistic cost

| | |
|---|---|
| Model | `all-MiniLM-L6-v2`, int8 ONNX ≈ **23 MB** (fp32 ≈ 90 MB — use int8) |
| Tokenizer | < 1 MB |
| `onnxruntime-web` WASM | ~10–20 MB across variants; ship only the builds actually used |
| **Package increase** | **~35–45 MB** — verify against Chrome Web Store limits before committing |
| One-time load | ~1–3 s, once per panel open. Load lazily on first resolve and show it happening |
| Per step | ~60 candidates × short strings. Order **0.3–1.0 s per step** single-threaded, less batched. The intent phrase is embedded once per step |
| A 12-step flow | adds roughly 5–10 s |

Against the existing per-event timeout budget that is acceptable — an event wait is already seconds
and the embedding cost is incurred between steps, not during the wait. **All of these are
estimates. Phase D reports measured numbers.**

## 11. Proposed sequencing

Because §1's prerequisites are missing, the embedding model cannot be Phase 1.

| Phase | Content | Exit |
|---|---|---|
| **A** | Trigger Condition column read; prose → ordered sub-intents. Pure, no DOM, no model | Real sheet sentences parsed correctly in tests |
| **B** | Step representation, target resolution, step executor, per-step safety gate | A hand-written step list runs on the mock site |
| **C** | Embedding matcher behind an injected interface, heuristic matcher as the fallback; manifest CSP; bundling | A sub-intent resolves to the right control offline, with NEEDS REVIEW below threshold |
| **D** | **Live Levison's run**, all 15 non-payment events | Every reachable event PASSES or reports a genuine payload WARNING — no detection/trigger failures. Measured latency per event. The §2 mismatch and the add-to-cart modal case both re-verified |

A and B are prerequisites, not padding: without B, a correctly resolved element cannot be acted on.

**BFSI / hotel booking** stay at design review until a real site exists. Structurally they are
supported by §8.1 (OTP pause, file upload — modulo the `file` gap) and by re-observing after each
step (a date-range widget or a wizard page that only appears mid-flow). That is a claim about
architecture, not about working software, and must not be reported as the latter.

---

## 12. What I would want agreed before implementing

1. **§1** — that A and B have to be built first, so the embedding matcher is Phase C.
2. **§7** — that embeddings do not solve negation, conditionals, or identical text, so the
   acceptance bar in Phase D must allow for events a tester still has to intervene on.
3. **§10** — that ~35–45 MB added to the extension package is acceptable.
4. **§2** — that the Action/Expected mismatch is fixed before any baseline is measured, since the
   current 10-not-triggered figure may partly be that bug.
