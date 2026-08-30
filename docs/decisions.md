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
