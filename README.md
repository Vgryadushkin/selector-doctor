# selector-doctor

When a UI test fails on a locator, the report tells you the locator timed out. It does not tell you
the one thing you actually need to know: **did the element change identity, or is it not there at
all?** Answering that by hand — open the trace, read the DOM, compare against the page object — is
the bulk of the time spent triaging a red suite.

`selector-doctor` answers it automatically, and optionally heals the step so the test can finish
while still reporting the drift.

```
✗ .header div.profile-avatar — timeout 5000ms

  selector-doctor: moved
  the element is now  header.mobile-header div.profile-avatar  (score 0.85)
  no longer inside .header
```

## What it is not

It is not an AI locator engine and it does not try to keep your suite green at any cost. Healing is
opt-in, off by the default, and every heal is written down — because a locator that heals forever is
a page object nobody maintains.

## Verdicts

The core returns one of six verdicts. The verdict, not the score, is what you act on:

| Verdict | Meaning | What to do |
|---|---|---|
| `intact` | The selector still matches. | The failure is timing, visibility or backend — stop looking at the locator. |
| `moved` | The element exists, but not under the ancestors the selector demands. | Re-scope the locator. |
| `renamed` | The element exists under a different identity (classes/attributes). | Update the identity, prefer a test id. |
| `text-changed` | Only the filtered text differs. | Product copy changed — or i18n leaked into the test. |
| `absent` | Nothing close enough. | The element is gone. This is a real failure — unless `unexplored` is set, and then the DOM had shadow roots or frames this HTML could not show. |
| `unreadable` | Part of the selector could not be translated. | Nothing was searched, and nothing is claimed. `unsupported` lists the parts. |

`intact` and `absent` are the valuable half: they tell you the locator is **not** the problem, which
is what most triage time is wasted on.

## Install

```bash
npm i -D selector-doctor
```

Node 22.18 or newer — the package ships TypeScript sources and relies on Node's own type stripping,
so there is no build output to install.

## Use with Playwright

Page objects build their locators from `page`, so wrapping `page` once covers the whole suite —
no spec and no page object changes:

```ts
// fixtures/healing.ts
import { test as base } from '@playwright/test'
import { withHealing } from 'selector-doctor/playwright'

export const test = base.extend({
    page: async ({ page }, use, testInfo) => {
        await use(withHealing(page, testInfo, { mode: 'report', probeTimeout: 2000 }))
    },
})
```

```ts
// playwright.config.ts
reporter: [
    ['html'],
    ['selector-doctor/playwright/reporter', { failOnRepeat: true }],
]
```

### Modes

| Mode | Behaviour |
|---|---|
| `off` | Inert. |
| `report` (default) | Diagnose, annotate the test, fail as before. |
| `heal` | Retry the step with the healed locator; the test passes and carries a `locator-healed` annotation. |

`HEAL=heal npx playwright test` overrides the mode per run — the environment wins over the fixture,
which is the only way a run can turn healing on without editing code. A value that is not one of
`off|report|heal` is refused with a warning and the fixture's mode is kept: `HEAL=1` must never mean
"heal".

### Options

| Option | Default | What it is for |
|---|---|---|
| `probeTimeout` | none | Shortens the *first* attempt so a drifted locator does not cost the full action timeout before the diagnosis starts. Safe to set: a locator that still matches is retried with the suite's own timeout (see `locator-slow`), so shortening the probe cannot turn a slow page into a failure. |
| `minScore` | `0.8` | Below this a candidate is reported, never used. |
| `maxDiagnoses` | `25` | Diagnoses one worker will run before going inert for the rest of the run. When a suite goes red at this scale the cause is the environment, not the page objects, and paying for the diagnosis fifty times says the same thing fifty times. |
| `captureCallSite` | `true` | Records `pages/AuthorizedHeader.ts:42` — where the locator was built — into the annotations and the drift log. Costs one stack capture per locator. |
| `logDir` | `.selector-doctor` | Where `heals.jsonl` is appended. Give the reporter the same value, or its repeat guard reads an empty log. |

### Annotations

| Type | Meaning |
|---|---|
| `locator-healed` | The step was retried with the healed locator and passed (`heal` mode). |
| `locator-drift` | A usable candidate was found, but the mode is `report` — the test still fails. |
| `locator-unhealed` | Diagnosed, no candidate safe enough to use. Carries the verdict and the note. |
| `locator-slow` | The selector still matched: the probe timeout was short, the page was slow. The step was retried with the full timeout. |
| `locator-diagnosis-off` | The worker's diagnosis budget is spent; the rest of its failures are reported raw. |

A heal only happens when the candidate scores above `minScore` (default `0.8`) **and** resolves to
exactly one element. A suggestion that matches three rows is never used — it would make the test
pass while touching the wrong thing.

### Guardrails

Every heal is appended to `.selector-doctor/heals.jsonl`. The reporter reads it and, with
`failOnRepeat`, fails the run when the same locator has been healed in more than one run. Healing is
then a buffer for one release, not a way to never update the page objects. The reporter takes
`outputFile`, `failOnRepeat` and `logDir` — the last has to match the one `withHealing` was given.

## Use from another language

The diagnosis is a pure function of a selector and an HTML string, so anything that can write those
two to disk can use it:

```bash
selector-doctor --selector ".header div.profile-avatar" --html page.html
# → JSON: verdict + ranked candidates
```

| Exit | Meaning |
|---|---|
| `0` | The selector matches, or it drifted and a candidate is offered. |
| `1` | `absent` — nothing close enough, and nothing was hidden from the HTML. A real failure. |
| `3` | Inconclusive — either `absent` while the page had shadow hosts or frames this HTML cannot show (`unexplored` says how much was out of reach), or `unreadable` because the selector had parts this version cannot translate (`unsupported` lists them). Treating this as `1` would act on a verdict the input could not support. |

That is the whole integration surface for Java/Selenium, pytest or WebdriverIO — no JavaScript
runner in the loop.

## How the diagnosis works

1. **Parse.** The selector is split into signals: tag, id, classes, attributes, filtered text,
   ancestor chain. Plain CSS, a Playwright locator chain
   (`locator('.a').locator('li').filter({ hasText: /x/i })`), the `getBy*` call form and the selector
   engines Playwright prints in its own error messages
   (`.header >> internal:testid=[data-testid="avatar"s]`) all reduce to the same signals — see
   [Locator forms](#locator-forms) for what each one becomes.
2. **Relax.** Signals are dropped one group at a time — ancestors first, then classes, then
   everything but the text — and each relaxation is queried against the DOM.
3. **Score.** Every candidate is scored against the original signals with weights that reflect what
   survives a redesign: test ids and aria labels count for much, classes for little (generated class
   names change on every build). The ancestor chain is not one of those signals — it says where the
   element was expected to be, not what it is, so leaving it discounts the score rather than
   competing with it. An element that kept its whole identity and only moved stays healable; one
   that moved *and* lost part of its identity does not.
4. **Suggest.** The winner gets the smallest selector that identifies it — own identity first,
   widened with ancestors while ambiguous, qualified by text when identical siblings leave no other
   way to tell them apart.

## Locator forms

`getBy*` locators are read, not treated as CSS. What each becomes:

| Locator | Signal |
|---|---|
| `getByTestId('avatar')` | `[data-testid="avatar"]` |
| `getByLabel('Email')` | `[aria-label="Email"]` |
| `getByPlaceholder`, `getByAltText`, `getByTitle` | the matching attribute |
| `getByText('Total')` | a text filter on a bare element |
| `getByRole('button', { name: 'Save' })` | role + accessible name |

Two things are worth knowing about that translation. A role is matched against what the element
*answers to*, not against the attribute: `getByRole('button')` finds a `<button>` as readily as a
`<div role="button">`. And a role's `name` is matched whole, the way Playwright matches it — a button
reading "Saved" is not the one `{ name: 'Save' }` asked for — while `getByText` stays a substring.

The approximations: `getByLabel` is read as `aria-label` only, so a label associated through
`<label for>` is not followed, and attribute matches are exact where Playwright's are substrings.
Both make the tool understate a match, never invent one.

`css=`, `text=` and `nth=` are understood (the last is dropped — a position says nothing about
identity). Anything else — an xpath, `internal:has=`, the `internal:control=enter-frame` a
`frameLocator` chain carries, an engine added by a newer Playwright — makes the whole diagnosis
`unreadable`. That is deliberate: a partly translated selector finds a real element for a locator
that meant something else and then reports it with full confidence.

## Limitations

Worth knowing before you wire it in:

- **Assertions are not healed.** `expect(locator).toBeVisible()` fails inside the matcher, out of
  reach of the wrapper. Actions (`click`, `fill`, `scrollIntoViewIfNeeded`, …) are covered; checks
  stay honestly red.
- **`page.content()` sees no shadow DOM and no iframes.** Elements inside them are invisible to the
  diagnosis until a DOM collector runs in-page. What the tool does about it today is refuse to lie:
  when nothing is found and the page has shadow hosts or frames, the verdict is reported as
  inconclusive rather than as `absent`, and `unexplored` says how much of the page was out of reach.
  A closed shadow root on a page with no custom-element host is still a blind spot.
- **Healing costs a timeout.** The first attempt has to fail before the diagnosis starts — use
  `probeTimeout` to keep that cheap.
- **`frameLocator` is not wrapped, on purpose.** Its document is not in `page.content()`, so anything
  the diagnosis found for it would have been found in the wrong document. Locators built through it
  behave exactly as they do without this package.
- **The declaration site is POSIX-only.** `captureCallSite` reads the stack frame with a regex that
  expects a path starting with `/`, so on Windows `origin` is silently `undefined` and the drift log
  loses the `pages/Header.ts:42` anchor — everything else works. The fix is one line in
  [`callSite()`](src/playwright/withHealing.ts): the frame pattern

  ```ts
  /\(?(?:file:\/\/)?(\/[^):]+):(\d+):\d+\)?\s*$/
  ```

  rejects `C:\Users\…` twice over — it demands a leading `/`, and its `[^):]` class stops at the
  colon after the drive letter. Replace it with

  ```ts
  /(?:^|\(|\s)(?:file:\/\/\/?)?([A-Za-z]:[\\/][^)]*|\/[^)]*):(\d+):\d+\)?\s*$/
  ```

  which accepts `C:\…`, `C:/…`, `file:///C:/…` and every POSIX shape, parenthesised or not. Nothing
  else in the function is platform-specific: the `node_modules` skip and `relative()` already behave
  on Windows.
- **"Renamed" and "replaced" are not distinguishable in principle.** A class rename and a deleted
  element with a similar neighbour look identical from the DOM. That is why the score, the
  uniqueness requirement and the drift log exist.

## Roadmap

- Fingerprints recorded from green runs, keyed by declaration site, so a drift can be judged against
  what the element used to be, not only against the selector text. The site itself
  (`pages/AuthorizedHeader.ts:42`) is already captured and logged; what is missing is the recording.
- In-page DOM collector for shadow DOM and iframes, replacing `page.content()` with a `page.evaluate`
  that inlines shadow roots, plus a walk over `page.frames()`.
- Adapters: WebdriverIO (native command hooks), Cypress (`Cypress.on('fail')`), Selenium.
- `--fix` mode writing the suggested selectors straight into the page objects as a reviewable diff.
  This needs the declaration site above, not the selector string: the runtime locator chain a heal
  records exists nowhere in the source, so patching by text search would be guesswork.

## Prior art

Healenium does self-healing for Selenium/Java; commercial tools (Testim, mabl) build the same idea
into their runners. The difference here is the split: a framework-agnostic diagnosis with no runner
in it, report-first behaviour, and a paper trail that makes the debt visible.

## License

MIT
