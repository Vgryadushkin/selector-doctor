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
  the element is now  header.mobile-header div.profile-avatar  (score 0.83)
  no longer inside .header
```

## What it is not

It is not an AI locator engine and it does not try to keep your suite green at any cost. Healing is
opt-in, off by the default, and every heal is written down — because a locator that heals forever is
a page object nobody maintains.

## Verdicts

The core returns one of five verdicts. The verdict, not the score, is what you act on:

| Verdict | Meaning | What to do |
|---|---|---|
| `intact` | The selector still matches. | The failure is timing, visibility or backend — stop looking at the locator. |
| `moved` | The element exists, but not under the ancestors the selector demands. | Re-scope the locator. |
| `renamed` | The element exists under a different identity (classes/attributes). | Update the identity, prefer a test id. |
| `text-changed` | Only the filtered text differs. | Product copy changed — or i18n leaked into the test. |
| `absent` | Nothing close enough. | The element is gone. This is a real failure. |

`intact` and `absent` are the valuable half: they tell you the locator is **not** the problem, which
is what most triage time is wasted on.

## Install

```bash
npm i -D selector-doctor
```

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

`HEAL=heal npx playwright test` overrides the mode per run.

A heal only happens when the candidate scores above `minScore` (default `0.8`) **and** resolves to
exactly one element. A suggestion that matches three rows is never used — it would make the test
pass while touching the wrong thing.

### Guardrails

Every heal is appended to `.selector-doctor/heals.jsonl`. The reporter reads it and, with
`failOnRepeat`, fails the run when the same locator has been healed in more than one run. Healing is
then a buffer for one release, not a way to never update the page objects.

## Use from another language

The diagnosis is a pure function of a selector and an HTML string, so anything that can write those
two to disk can use it:

```bash
selector-doctor --selector ".header div.profile-avatar" --html page.html
# → JSON: verdict + ranked candidates; exit code 1 when the verdict is `absent`
```

That is the whole integration surface for Java/Selenium, pytest or WebdriverIO — no JavaScript
runner in the loop.

## How the diagnosis works

1. **Parse.** The selector is split into signals: tag, id, classes, attributes, filtered text,
   ancestor chain. A Playwright locator chain (`locator('.a').locator('li').filter({ hasText: /x/i })`)
   is understood as well as plain CSS.
2. **Relax.** Signals are dropped one group at a time — ancestors first, then classes, then
   everything but the text — and each relaxation is queried against the DOM.
3. **Score.** Every candidate is scored against the original signals with weights that reflect what
   survives a redesign: test ids and aria labels count for much, classes for little (generated class
   names change on every build).
4. **Suggest.** The winner gets the smallest selector that identifies it — own identity first,
   widened with ancestors while ambiguous, qualified by text when identical siblings leave no other
   way to tell them apart.

## Limitations

Worth knowing before you wire it in:

- **Assertions are not healed.** `expect(locator).toBeVisible()` fails inside the matcher, out of
  reach of the wrapper. Actions (`click`, `fill`, `scrollIntoViewIfNeeded`, …) are covered; checks
  stay honestly red.
- **`page.content()` sees no shadow DOM and no iframes.** Elements inside them are invisible to the
  diagnosis until a DOM collector runs in-page.
- **Healing costs a timeout.** The first attempt has to fail before the diagnosis starts — use
  `probeTimeout` to keep that cheap.
- **"Renamed" and "replaced" are not distinguishable in principle.** A class rename and a deleted
  element with a similar neighbour look identical from the DOM. That is why the score, the
  uniqueness requirement and the drift log exist.

## Roadmap

- Fingerprints recorded from green runs, keyed by declaration site (`AuthorizedHeader.userAvatarButton`),
  so a drift can be judged against what the element used to be, not only against the selector text.
- In-page DOM collector for shadow DOM and iframes.
- Adapters: WebdriverIO (native command hooks), Cypress (`Cypress.on('fail')`), Selenium.
- `--fix` mode writing the suggested selectors straight into the page objects as a reviewable diff.

## Prior art

Healenium does self-healing for Selenium/Java; commercial tools (Testim, mabl) build the same idea
into their runners. The difference here is the split: a framework-agnostic diagnosis with no runner
in it, report-first behaviour, and a paper trail that makes the debt visible.

## License

MIT
