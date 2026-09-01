import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnose } from '../src/index.ts'

// The fixtures below are trimmed versions of real failures from a Playwright suite: an avatar that
// moved out of the desktop header on mobile, and a select whose option list was rebuilt.

const mobileHeader = `
<body>
  <header class="mobile-header">
    <button aria-label="Menu">Menu</button>
    <div class="profile-avatar"><img src="a.png"></div>
  </header>
  <main><div class="content">games</div></main>
</body>`

const noAvatarAtAll = `
<body>
  <header class="header"><button aria-label="Menu">Menu</button></header>
  <main><button class="login">Log in</button></main>
</body>`

const desktopHeader = `
<body>
  <header class="header"><div class="profile-avatar"><img src="a.png"></div></header>
</body>`

const rebuiltSelect = `
<body>
  <div class="v-overlay__content">
    <div class="v-list">
      <div class="v-list-item"><span class="v-list-item-title">Day</span></div>
      <div class="v-list-item"><span class="v-list-item-title">Week</span></div>
      <div class="v-list-item"><span class="v-list-item-title">Month</span></div>
    </div>
  </div>
</body>`

test('element that left its ancestor is reported as moved, not gone', () => {
    const result = diagnose({ selector: '.header div.profile-avatar', html: mobileHeader })
    assert.equal(result.verdict, 'moved')
    assert.ok(result.candidates[0].selector.includes('profile-avatar'))
    assert.match(result.candidates[0].whatChanged.join(' '), /no longer inside/)
})

test('a genuinely missing element is not healed into something similar', () => {
    const result = diagnose({ selector: '.header div.profile-avatar', html: noAvatarAtAll })
    assert.equal(result.verdict, 'absent')
    assert.equal(result.candidates.length, 0)
})

test('a still-matching selector points the blame away from the locator', () => {
    const result = diagnose({ selector: '.header div.profile-avatar', html: desktopHeader })
    assert.equal(result.verdict, 'intact')
    assert.match(result.note ?? '', /timing|visibility/)
})

test('a rebuilt dropdown is found through the text the selector filtered on', () => {
    const result = diagnose({
        selector: `locator('.ng-select-dropdown:visible').locator('li').filter({ hasText: /^Week$/i })`,
        html: rebuiltSelect,
    })
    assert.notEqual(result.verdict, 'absent')
    const best = result.candidates[0]
    assert.equal(best.matches, 1, 'a healable candidate has to be unique')
    assert.match(best.selector, /v-list-item|v-list-item-title/)
})

const shadowApp = `
<body>
  <app-header></app-header>
  <main><iframe src="/wallet"></iframe></main>
</body>`

test('absent is marked inconclusive when the page has subtrees the HTML cannot show', () => {
    const result = diagnose({ selector: '.header div.profile-avatar', html: shadowApp })
    assert.equal(result.verdict, 'absent')
    assert.deepEqual(result.unexplored, { shadowHosts: 1, frames: 1 })
    assert.match(result.note ?? '', /inconclusive/)
})

test('absent stays final when nothing was hidden from the serialization', () => {
    const result = diagnose({ selector: '.header div.profile-avatar', html: noAvatarAtAll })
    assert.equal(result.unexplored, undefined)
    assert.match(result.note ?? '', /most likely gone/)
})

// The heal gate is `score >= 0.8` by default, so where a move lands relative to it is behaviour,
// not a detail: it decides whether the tool's own headline example is healable at all.

test('an element that only moved stays above the default heal threshold', () => {
    const result = diagnose({ selector: '.header div.profile-avatar', html: mobileHeader })
    assert.equal(result.candidates[0].verdict, 'moved')
    assert.ok(result.candidates[0].score >= 0.8, `a clean move scored ${result.candidates[0].score}`)
    assert.equal(result.candidates[0].matches, 1)
})

test('a move that also lost part of the identity is reported, not healed', () => {
    const result = diagnose({ selector: '.header div.profile-avatar.round', html: mobileHeader })
    // Losing an identity signal outranks the move in the verdict: `renamed` is the thing to fix.
    assert.equal(result.verdict, 'renamed')
    assert.deepEqual(result.candidates[0].whatChanged, ['class .round → .profile-avatar', 'no longer inside .header'])
    assert.ok(result.candidates[0].score < 0.8, `a lossy move scored ${result.candidates[0].score}`)
})
