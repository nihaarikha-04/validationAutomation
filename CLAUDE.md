# Coding practices

TypeScript project — Chrome Extension MV3, React, Vite, Vitest. No Python. These rules are binding.
If a rule blocks the task, say so — don't work around it.

## No wrapper functions
- A function that only forwards its arguments to another function must not exist. Call the target directly.
- Don't wrap a library call to rename it, reorder its parameters, or supply a default. Pass the default at the call site.
- One-line helpers with a single caller are inlined, not extracted.
- No barrel files. A module that only re-exports other modules must not exist; import from the source.
- No component that exists only to pass its props through to another component.
- A new layer is justified only when it adds real behaviour: validation, error translation, retry, caching, or a genuine boundary between subsystems. Name what it adds in a doc comment.

## Dependency injection
- Pass collaborators in as constructor or function arguments. Never construct them inside the unit that uses them.
- Type parameters against an interface declared by the consumer, not a concrete class.
- No module-level singletons, no mutable module state, no import-time side effects — the MV3 service worker restarts and will re-run them.
- `chrome.*`, DOM, `fetch`, `Date.now`, `Math.random`, and storage are reached at the composition root only — pass values or interfaces down.
- Wire explicitly in one entrypoint per surface: background, content script, devtools panel, popup. No DI framework, no decorators, no `reflect-metadata`.
- React: dependencies arrive via props or one provider defined at the root. Never import a singleton inside a component.

## Business logic
- Keep decision logic pure: inputs in, result out. No DOM, no `chrome.*`, no network. Side effects live at the edges.
- Parsing, matching, and validation must be testable with plain objects and no browser.
- One responsibility per function. If the name needs "and", split it.
- Return a discriminated union or throw a typed error. Never signal an outcome with `null`, `false`, or a magic string.
- Parse and validate at the boundary; interior code assumes valid, typed data.
- Model domain data with named types and enums, never `Record<string, any>` or loose object literals.
- Components render state — they don't compute verdicts. No business rules in components, tests, fixtures, or config.

## No over-complication
- Write the simplest thing that satisfies the current requirement. No speculative generality.
- No interface with a single implementation. No registry or plugin indirection until a third case exists.
- Compose functions. Classes only where there is real instance state; no inheritance for code reuse.
- No `any`. No `as` to silence the compiler — fix the type. No non-null `!` without a comment saying why it holds.
- Prefer the standard library and web platform APIs. A new dependency needs a stated reason.
- Guard clauses over nested conditionals; keep nesting at two levels or less.
- No premature `useMemo`/`useCallback`. Extract a custom hook on the second real caller, not the first.
- Delete dead code and commented-out code rather than keeping it.

## Style
- `strict` stays on. Never weaken `tsconfig` to make code compile.
- Explicit return types on exported functions.
- Comments explain *why*; the code already says *what*. No commentary that restates the line below it.
- Fail loudly. No empty `catch`, no `catch` that logs and continues. Catch only where the error is genuinely handled.

## PLAN.md
- `PLAN.md` holds the phase-by-phase build plan. Work phases in order; don't start one until the previous phase's exit criteria are met and verified.
- Update `PLAN.md` the moment a phase is finished and verified — before starting the next phase, not in a batch at the end.
- Tick a phase's checkboxes only for work that is actually done and verified. If it's partly done, say what's left.
- For each completed phase record: files changed, how the exit criteria were verified, anything deferred.
- Append forward. Don't delete or rewrite finished phases; correct them in place with a note.
- Never generate more than one phase's worth of code in a single pass.
