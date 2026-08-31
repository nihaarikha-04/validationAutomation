/*
 * Answers the two open Phase 2 questions against a real client site:
 *
 *   1. Does their Smartech snippet use a queuing-stub pattern?
 *   2. Does the SDK ever redefine window.smartech after load?
 *
 * HOW TO RUN
 *   Best:  DevTools → Sources → Snippets → New snippet → paste → Ctrl/Cmd+Enter, then reload
 *          the page and run it again immediately as the page starts.
 *   Good:  paste into the Console on a loaded page. It still classifies what is there now,
 *          it just cannot see assignments that already happened.
 *
 * Leave the tab alone for 15s, then read the two tables it prints.
 */
(() => {
  const started = performance.now();
  const at = () => `${Math.round(performance.now() - started)}ms`;
  const timeline = [];

  const classify = (value) => {
    if (typeof value !== 'function') {
      return { verdict: `not a function (${typeof value})`, source: '' };
    }
    const source = Function.prototype.toString.call(value);
    const queued = value.q !== undefined || /\.q\b/.test(source) || /arguments\)/.test(source);
    return {
      verdict: source.length < 300 && queued ? 'QUEUING STUB' : 'looks like the real SDK',
      length: source.length,
      hasQueueProperty: value.q !== undefined,
      queueLength: Array.isArray(value.q) ? value.q.length : null,
      source: source.slice(0, 200),
    };
  };

  let current = window.smartech;
  timeline.push({ at: at(), event: 'probe installed', ...classify(current) });

  Object.defineProperty(window, 'smartech', {
    configurable: true,
    get: () => current,
    set: (value) => {
      timeline.push({ at: at(), event: 'window.smartech ASSIGNED', ...classify(value) });
      current = value;
    },
  });

  const report = () => {
    console.log('%c[smartech probe] assignment timeline', 'font-weight:bold');
    console.table(timeline.map(({ source, ...row }) => row));
    console.log('[smartech probe] final state:', classify(window.smartech));
    console.log(
      '[smartech probe] READ THIS:',
      timeline.length > 1
        ? `window.smartech was reassigned ${timeline.length - 1}x → the interceptor MUST re-wrap on assignment (it does).`
        : 'no reassignment observed in this window — run it again from a Snippet at page start before concluding.',
    );
    console.log('[smartech probe] full sources:', timeline);
  };

  window.__smartechProbe = report;
  setTimeout(report, 15000);
  console.log('[smartech probe] watching for 15s. Call __smartechProbe() any time for an early read.');
})();
