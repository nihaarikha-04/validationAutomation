# Trigger-condition automation — what is known before starting

Written 2026-10-20, starting `trigger-automation` fresh from `fix: Formatting Report`.

An earlier attempt at this lives on the `watch-mode` branch (6 commits) and in a `git stash`.
Nothing there was deleted. It is not being continued because the direction was wrong, not because
the code was bad — and the things it learned are below so they are not learned twice.

---

## 1. What the tool is for

A tester is given a client's **Event Sheet** — a spreadsheet naming each analytics event, the
fields it should carry, their datatypes, and a **Trigger Condition** written in plain English. They
open the client's website and have to answer one question per event:

> Does this event fire, and does its payload match what the sheet says?

Every client is a different website. A hotel booking site, a lender, a storefront, an edtech
platform. The tester sees each one for the first time.

## 2. What already works and must not be broken

This half is done, on `main`, and is genuinely good:

- reading the sheet (CSV and XLSX), including detecting which columns mean what
- capturing the Smartech debug payload from the page
- validating a captured payload against the sheet: missing fields, renamed keys, datatype
  mismatches, nulls, extras
- reports and exports

**It needs no setup and works on any site from the first second.** It caught two real payload bugs
on a live client site. Nothing in this brief should put it at risk.

## 3. The problem to solve

Making the events **fire**, so a tester does not click through fifteen flows by hand.

### What the client gives us

The Trigger Condition column, in the client's own words. Real examples from a live sheet:

> "Click the search icon in the header, type a keyword (e.g. 'jacket'), then press Enter or click
> the search button."

> "On a product listing page, click on a random item (not on the cart symbol) and select size and
> color if one is required, then click 'Add to Cart' button."

> "Click the Account/Login icon. Enter the registered Email or Mobile number, request the OTP (or
> enter the password), then click 'Login' / 'Verify'."

> "BACKEND / SHOPIFY WEBHOOK — does not fire from any storefront click. To reproduce, cancel a test
> order from the Shopify admin panel, not from the website itself."

These are instructions, not notes. They are also the **only** description of the action anyone has
written down.

---

## 4. What was tried, and what actually happened

### 4a. Keyword matching on the event's name — does not generalise

Search the page for controls whose words match the event name (`add_to_cart` → "add", "cart"),
click the best one. Works on a storefront, matches nothing on a lender where the event is
`kyc_initiated` and the button says "Start Verification".

**Live result:** 15 events, 3 fired, 12 not triggered.

### 4b. A crawler that clicks everything — cannot work, structurally

Click every control, see what fires. The fatal flaw is not speed, it is **signal**: choosing a size
fires no event, so a crawler cannot tell a correct intermediate step from a random div. It has no
way to know it is making progress, so it cannot build a multi-step flow.

### 4c. A recorder — right tool, wrong claim

Drive the flow once by hand, keep the steps. This works, and it is worth having. It is **not**
first-visit automation: it only pays off the second time you validate the same client.

### 4d. Reading the English sentence into steps — works, with a long tail

Parse "Click the search icon, type a keyword (e.g. 'jacket'), then press Enter" into
`click … / fill … / click …`. This is deterministic, free, needs no model, and generalises across
verticals because every sheet has prose.

It got a real flow running. Then each live attempt failed on a different detail:

1. `click text=search icon` — nothing is *called* "search icon"; the button is called Search and
   "icon" says it has a picture on it. **Strip kind-nouns** (icon, button, link, page, panel…).
2. `text=` only matches visible words, and a picture button has none. **`label=` is strictly
   broader** — it matches aria-label, an associated `<label>`, placeholder, title *and* own text.
3. "press Enter **or click the search button**" targeted a control called "Enter or click the
   search". **Stop the name at an alternative.**
4. `label=search` then matched **five** elements: a wrapper `<div aria-label="search">`, a form,
   an input, and two buttons. Narrowing that is general and worth keeping:
   - a **control** beats a wrapper that merely describes one
   - the **innermost** of two nested matches is what a person would press
   - it has to **occupy space** — a responsive site carries a mobile and a desktop header in the
     same document and shows one. `display`/`visibility` cannot see this; `getBoundingClientRect`
     can. (Guard it: every element measures 0×0 in a headless DOM.)

**Each of those fixes generalises. Every one of them was found by failing on one site and pasting
the error back.** That is the thing that does not scale, and it is the central lesson of the
attempt: there is no finite list of rules that resolves an English phrase to a control across all
sites.

### 4e. A model reading the live page — the right answer, currently unavailable

Show a model the page's actual controls plus the client's sentence; ask for the **next single
step**; run it; look again. This closes the loop a crawler cannot, because the next observation is
the signal.

Blocked on both free routes:

- **Chrome's on-device Gemini Nano** (`LanguageModel`, GA to extensions since Chrome 138): the
  global is absent on the test machine even on Chrome 156. Needs 22 GB free disk, >4 GB VRAM,
  16 GB RAM / 4+ cores, and a separate multi-GB download.
- **A paid API key:** out of scope. No subscription, no tokens.

A local model over `http://localhost` (Ollama/LM Studio) is the untried free option — no key, no
per-call cost, nothing leaves the machine, but it needs an install and a multi-GB pull.

---

## 5. What follows from all that

**Guessing which control an English phrase means is not reliable across sites, and no amount of
rule-writing makes it so.** The sentence is excellent at the *shape* of a flow — how many steps,
what each does, what to type. It cannot know which element on this particular site.

A person looking at the page knows that in two seconds.

So the realistic design is:

1. **Read the sentence for the shape** — free, deterministic, gets simple steps right outright.
2. **A person points at anything it could not place** — a selector someone pointed at is a fact,
   not a guess, and keeps working on every later run.
3. **Save it per client.** Roughly 30 seconds an event, once. Then it runs unattended for ever,
   including the next time that client is re-validated.
4. **Keep a model-shaped hole.** Put the transport behind one injected function so a local or
   hosted model can be dropped in later without touching anything else.

**What is given up:** driving a brand-new site with zero human input. That needs a model, and there
is not one available. Claiming otherwise is what produced an evening of selector debugging.

**What is honest to claim:** validation is fully automatic on any site from the first second;
driving the flows needs a one-time setup per client.

---

## 6. Constraints that are not negotiable

- **Vertical-agnostic.** No storefront wording baked into prompts, step vocabulary or run ordering.
  Ecommerce is only testable now because one live site exists, not because it is the target. A cart
  taxonomy driving run order moves the problem rather than solving it.
- **Never spend money or commit the client to anything.** Payment events are refused. So is a
  BFSI "Submit Application", a hotel "Confirm Booking", "Accept Offer", "E-Sign". Phrases, not bare
  words — `submit` alone is every search box on the internet. Checked in code, never left to a
  prompt, and **re-checked on every step** if steps are ever proposed one at a time.
- **Never invent a person's details.** Email, phone, password, OTP, uploaded documents: the run
  stops and asks. A fabricated value burns the attempt and sometimes the account.
- **Never silently excuse an event.** If the sheet's prose says an event is a backend webhook, say
  so *and quote the words that decided it*. An event quietly dropped from the gap is worse than one
  wrongly reported.
- **Never choose a path invisibly.** Three separate bugs in the last attempt were the same shape:
  the tool picked between two behaviours and the tester could not see which, so a failure read as a
  defect in the client's site. Say which path a run will take *before* it runs.
- Zero permissions in the manifest for as long as possible. Nothing reaches the network today.

## 7. Known facts about the live test site (levisons.co.za)

Useful for testing, not to be designed around:

- Shopify. Two headers (mobile and desktop) in the same document; only one is on screen.
- Add to cart on a listing page opens a **quick-view modal**. Size and colour are chosen *only*
  inside it, and are often **pre-selected** — so "nothing to choose" and "could not work out what
  to choose" look identical unless they are deliberately told apart.
- `order cancelled` is a Shopify webhook and cannot fire from the browser at all.
- Baseline from a manual watch-mode run: 15 reachable, 1 pass, 2 warning (both real payload
  findings), 12 not triggered — most of the 12 simply were not driven by hand.

## 8. How to work on this

Per `CLAUDE.md`: one phase at a time, written into `PLAN.md` with exit criteria, verified before
the next one starts. Decision logic pure and testable without a browser. Dependencies injected at
the composition root.

**And one more, learned the hard way:** prefer a change that makes a failure *diagnosable* over one
that guesses at a fix. Twice, adding "say what you actually saw" turned a repeated dead end into a
one-round answer. The codebase already said this — *"several rounds were spent guessing at a
client's markup from a distance and being wrong each time"* — and it was still worth relearning.
