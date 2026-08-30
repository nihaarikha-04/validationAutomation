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
