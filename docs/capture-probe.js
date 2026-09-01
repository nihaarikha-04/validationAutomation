/*
 * Finds out where capture is breaking, on the page you actually care about.
 *
 * RUN IT IN THE PAGE'S OWN CONSOLE (the site's tab, not the extension panel).
 * Paste, press enter, use the site normally for a few seconds, then read the summary it prints.
 */
(() => {
  const installed = Reflect.get(window, '__smartechValidatorInstalled') === true;
  const smartechType = typeof window.smartech;

  // Did our page→extension handoff actually fire? This is the hop the transport change touched.
  let transportFired = 0;
  document.addEventListener('smartech-validator:payload', () => {
    transportFired += 1;
  });

  // Record every console line so we can see what Smartech really prints on THIS site.
  const lines = [];
  for (const method of ['log', 'info', 'debug', 'warn']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      lines.push({
        method,
        firstArg: typeof args[0] === 'string' ? args[0].slice(0, 70) : `<${typeof args[0]}>`,
        args: args.length,
        looksLikeSmartech: typeof args[0] === 'string' && /^\s*\[\s*smartech\b/i.test(args[0]),
      });
      original(...args);
    };
  }

  // A line in the exact shape we match on. If capture works, this alone proves hops 1 and 2.
  console.log("[Smartech Debugger] Firing EVT: 'probe_test' with payload: ", { probe: true });

  setTimeout(() => {
    const smartechLines = lines.filter((line) => line.looksLikeSmartech);
    console.log('%c--- SMARTECH VALIDATOR PROBE ---', 'font-weight:bold');
    console.log('1. capture script present   :', installed, '(false = content script never ran)');
    console.log('2. our transport fired      :', transportFired, '(0 = capture is not seeing console)');
    console.log('3. window.smartech          :', smartechType);
    console.log('4. Smartech-looking lines   :', smartechLines.length, 'of', lines.length, 'console lines');
    if (smartechLines.length > 0) {
      console.table(smartechLines.slice(-10));
    } else {
      console.log('   None. Either debug mode is off on this site, or the prefix differs.');
      console.log('   Last 15 console lines, so we can see what the real format is:');
      console.table(lines.slice(-15));
    }
  }, 8000);

  console.log('[probe] watching for 8s — use the site now, then read the summary.');
})();
