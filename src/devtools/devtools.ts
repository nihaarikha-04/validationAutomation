// DevTools entry. Chrome loads this page whenever DevTools opens on any tab, and
// discards it when DevTools closes. Its only job is to register the panel.
//
// The panel path is resolved against the extension root, not against this file.
chrome.devtools.panels.create(
  'Smartech Validator',
  '',
  'devtools/panel/index.html',
);
