import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnose, parseSelector } from '../src/index.ts'

// Playwright prints a `getBy*` locator as its own selector engine (`internal:testid=…`), and page
// objects write the call form. Both have to reach the same signals - parsed as plain CSS they read
// as a tag called `internal`, and every such locator gets diagnosed `absent` on a live element.

const page = `
<body>
  <header class="header">
    <button data-testid="user-avatar" aria-label="Profile">A</button>
  </header>
  <main>
    <div class="totals"><span>Total</span></div>
    <input placeholder="Search">
    <div role="button" class="fake-button">Save</div>
  </main>
</body>`

const forms: [string, string][] = [
    ['call form', `getByTestId('user-avatar')`],
    ['engine form', 'internal:testid=[data-testid="user-avatar"s]'],
    ['chained engine form', '.header >> internal:testid=[data-testid="user-avatar"s]'],
]

for (const [name, selector] of forms) {
    test(`a test id locator in ${name} finds the element it points at`, () => {
        const result = diagnose({ selector, html: page })
        assert.equal(result.verdict, 'intact')
        assert.match(result.candidates[0].selector, /user-avatar/)
    })
}

test('a role locator matches the native element, not only [role]', () => {
    const native = diagnose({ selector: `getByRole('button', { name: 'A' })`, html: page })
    assert.equal(native.verdict, 'intact')
    assert.match(native.candidates[0].selector, /user-avatar/)

    const explicit = diagnose({ selector: `getByRole('button', { name: 'Save' })`, html: page })
    assert.equal(explicit.verdict, 'intact')
    assert.match(explicit.candidates[0].selector, /fake-button/)
})

test('a text locator lands on the leaf that holds the text, not on its ancestors', () => {
    const result = diagnose({ selector: `getByText('Total')`, html: page })
    assert.equal(result.verdict, 'intact')
    assert.equal(result.candidates[0].css, 'span')
})

test('label and placeholder locators are read as the attributes they stand for', () => {
    assert.deepEqual(parseSelector(`getByLabel('Profile')`).target.attrs, [{ name: 'aria-label', value: 'Profile' }])
    assert.deepEqual(parseSelector(`getByPlaceholder('Search')`).target.attrs, [{ name: 'placeholder', value: 'Search' }])
    assert.deepEqual(parseSelector(`getByAltText('Logo')`).target.attrs, [{ name: 'alt', value: 'Logo' }])
    assert.deepEqual(parseSelector(`getByTitle('Close')`).target.attrs, [{ name: 'title', value: 'Close' }])
    assert.equal(diagnose({ selector: `getByPlaceholder('Search')`, html: page }).verdict, 'intact')
})

test('a test id that left its scope is moved, and one that is gone is absent', () => {
    const moved = `<body><header class="mobile-header"><button data-testid="user-avatar">A</button></header></body>`
    const drifted = diagnose({ selector: `locator('.header').getByTestId('user-avatar')`, html: moved })
    assert.equal(drifted.verdict, 'moved')
    assert.ok(drifted.candidates[0].score >= 0.8)

    const gone = diagnose({ selector: `getByTestId('user-avatar')`, html: `<body><header class="header"></header></body>` })
    assert.equal(gone.verdict, 'absent')
})

test('the ancestors of a chain survive the translation', () => {
    const signals = parseSelector(`locator('.a').getByRole('button', { name: 'Save' })`)
    assert.deepEqual(signals.ancestors, [{ classes: ['a'], attrs: [] }])
    assert.deepEqual(signals.target.attrs, [{ name: 'role', value: 'button' }])
    // A role's name is matched whole - a button reading "Saved" is not the one this asked for.
    assert.equal(signals.text?.regex, true)
    assert.match('Save', new RegExp(signals.text!.value, 'i'))
    assert.doesNotMatch('Saved', new RegExp(signals.text!.value, 'i'))
})

test('a selector this version cannot read gets no verdict rather than a guessed one', () => {
    for (const selector of ['xpath=//button[@id="save"]', '.header >> internal:has=[data-x]', '//div[1]']) {
        const result = diagnose({ selector, html: page })
        assert.equal(result.verdict, 'unreadable', selector)
        assert.deepEqual(result.candidates, [], 'a suggestion from a misread selector is worse than none')
        assert.ok(result.unsupported?.length)
    }
})

test('a frame boundary is unreadable, not silently searched in the main document', () => {
    const result = diagnose({ selector: '.header >> internal:control=enter-frame >> .fake-button', html: page })
    assert.equal(result.verdict, 'unreadable')
    assert.match(result.note ?? '', /enter-frame/)
})

test('the engine prefixes that do have a meaning here are honoured', () => {
    assert.equal(diagnose({ selector: 'css=.header button', html: page }).verdict, 'intact')
    assert.equal(diagnose({ selector: 'text="Total"', html: page }).verdict, 'intact')
    // nth= narrows a set; it says nothing about identity, so it is dropped rather than refused.
    assert.equal(diagnose({ selector: 'nth=0 >> .totals', html: page }).verdict, 'intact')
})
