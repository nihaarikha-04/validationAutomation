/**
 * Builds a selector that finds this element again later.
 *
 * Detection and execution are separate steps — the page may re-render between them — so a
 * candidate carries a selector rather than an element reference.
 */
export function selectorFor(element: Element): string {
  const id = element.getAttribute('id');
  if (id !== null && id !== '' && isUnique(element, `#${cssEscape(id)}`)) {
    return `#${cssEscape(id)}`;
  }

  const testId = element.getAttribute('data-testid');
  if (testId !== null && testId !== '') {
    const selector = `[data-testid="${cssEscape(testId)}"]`;
    if (isUnique(element, selector)) {
      return selector;
    }
  }

  return pathFrom(element);
}

function isUnique(element: Element, selector: string): boolean {
  const matches = element.ownerDocument.querySelectorAll(selector);
  return matches.length === 1 && matches[0] === element;
}

/** Falls back to a structural path, which survives re-render better than a text match. */
function pathFrom(element: Element): string {
  const steps: string[] = [];
  let current: Element | null = element;

  while (current !== null && current.nodeName.toLowerCase() !== 'html') {
    const parent: Element | null = current.parentElement;
    if (parent === null) {
      steps.unshift(current.nodeName.toLowerCase());
      break;
    }

    const siblings = [...parent.children].filter(
      (sibling) => sibling.nodeName === current?.nodeName,
    );
    const step =
      siblings.length === 1
        ? current.nodeName.toLowerCase()
        : `${current.nodeName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`;

    steps.unshift(step);
    current = parent;
  }

  return steps.join(' > ');
}

/** Minimal CSS escaping — enough for ids and data attributes seen in the wild. */
function cssEscape(value: string): string {
  return value.replace(/(["\\\]\[#.:>+~*^$|=()])/g, '\\$1');
}
