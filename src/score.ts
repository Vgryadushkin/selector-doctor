import type { Compound, Signals } from './types.ts'

/**
 * Attributes that carry identity survive redesigns; classes rarely do. Weighting them this way is
 * what keeps a Tailwind/Vuetify class churn from looking like a different element.
 */
const IDENTITY_ATTRS = new Set(['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'role', 'placeholder', 'type'])

const WEIGHT = { id: 4, identityAttr: 4, otherAttr: 2, text: 3, tag: 1, classes: 2 }

/**
 * Ancestors are not part of what the element *is* - they are where the selector expected to find it.
 * Scored as one more signal, they made the cleanest case in the whole tool unhealable: an element
 * that kept every bit of its identity and only moved scored 0.6 against a 0.8 threshold. So the
 * chain discounts the identity score instead of competing with it - enough to keep a move below an
 * untouched match, not enough to bury it.
 */
const OUT_OF_SCOPE = 0.85

/**
 * `getByRole('button')` matches a `<button>` as readily as a `<div role="button">`, so a role asked
 * for by a selector cannot be compared against the attribute alone - that would score every native
 * element as having lost its role.
 */
const IMPLICIT_ROLE: Record<string, string> = {
    button: 'button', a: 'link', img: 'img', select: 'combobox', textarea: 'textbox', nav: 'navigation',
    main: 'main', header: 'banner', footer: 'contentinfo', form: 'form', dialog: 'dialog', table: 'table',
    ul: 'list', ol: 'list', li: 'listitem', option: 'option', progress: 'progressbar',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
}

const INPUT_ROLE: Record<string, string> = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox',
    submit: 'button', button: 'button', reset: 'button', image: 'button',
    text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox',
}

/** The role this element answers to: the explicit attribute first, then what the tag implies. */
export function roleOf(element: any): string | undefined {
    const explicit = element.getAttribute?.('role')
    if (explicit) return explicit
    const tag = element.tagName?.toLowerCase() ?? ''
    if (tag === 'input') return INPUT_ROLE[(element.getAttribute('type') ?? 'text').toLowerCase()]
    if (tag === 'a') return element.getAttribute('href') === null ? undefined : 'link'
    return IMPLICIT_ROLE[tag]
}

/** The query that collects every element which could answer to this role, native tags included. */
export function roleQuery(role: string): string {
    const tags = Object.entries(IMPLICIT_ROLE).filter(([, value]) => value === role).map(([tag]) => tag)
    if (Object.values(INPUT_ROLE).includes(role)) tags.push('input')
    return [`[role="${role}"]`, ...tags].join(',')
}

function textOf(element: any): string {
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function textMatches(element: any, text: NonNullable<Signals['text']>): boolean {
    const actual = textOf(element)
    if (text.regex) return new RegExp(text.value, text.ignoreCase ? 'i' : '').test(actual)
    return text.ignoreCase ? actual.toLowerCase().includes(text.value.toLowerCase()) : actual.includes(text.value)
}

function hasAncestors(element: any, ancestors: Compound[]): boolean {
    let current = element.parentElement
    let remaining = [...ancestors].reverse()
    while (current && remaining.length) {
        if (matchesCompound(current, remaining[0])) remaining = remaining.slice(1)
        current = current.parentElement
    }
    return remaining.length === 0
}

function matchesCompound(element: any, compound: Compound): boolean {
    if (compound.tag && element.tagName?.toLowerCase() !== compound.tag) return false
    if (compound.id && element.id !== compound.id) return false
    for (const name of compound.classes) if (!element.classList?.contains(name)) return false
    for (const attr of compound.attrs) {
        const actual = attr.name === 'role' ? roleOf(element) : element.getAttribute?.(attr.name)
        if (actual === null || actual === undefined) return false
        if (attr.value !== undefined && actual !== attr.value) return false
    }
    return true
}

/**
 * How much of the element's own identity survived, discounted for having left the scope the selector
 * demanded - plus the list of what no longer holds.
 */
export function score(element: any, signals: Signals): { score: number; whatChanged: string[] } {
    const { target, ancestors, text } = signals
    let max = 0
    let got = 0
    const whatChanged: string[] = []

    if (target.tag) {
        max += WEIGHT.tag
        if (element.tagName?.toLowerCase() === target.tag) got += WEIGHT.tag
        else whatChanged.push(`tag ${target.tag} → ${element.tagName?.toLowerCase()}`)
    }
    if (target.id) {
        max += WEIGHT.id
        if (element.id === target.id) got += WEIGHT.id
        else whatChanged.push(`id ${target.id} → ${element.id || '(none)'}`)
    }
    if (target.classes.length) {
        max += WEIGHT.classes
        const shared = target.classes.filter(name => element.classList?.contains(name))
        got += (shared.length / target.classes.length) * WEIGHT.classes
        const lost = target.classes.filter(name => !shared.includes(name))
        if (lost.length) whatChanged.push(`class ${lost.map(name => `.${name}`).join('')} → ${[...(element.classList ?? [])].map((c: string) => `.${c}`).join('') || '(none)'}`)
    }
    for (const attr of target.attrs) {
        const weight = IDENTITY_ATTRS.has(attr.name) ? WEIGHT.identityAttr : WEIGHT.otherAttr
        max += weight
        const actual = attr.name === 'role' ? roleOf(element) : element.getAttribute?.(attr.name)
        if (actual !== null && actual !== undefined && (attr.value === undefined || actual === attr.value)) got += weight
        else whatChanged.push(`[${attr.name}] ${attr.value ?? ''} → ${actual ?? '(none)'}`)
    }
    if (text) {
        max += WEIGHT.text
        if (textMatches(element, text)) got += WEIGHT.text
        else whatChanged.push(`text ${text.regex ? `/${text.value}/` : `"${text.value}"`} → "${textOf(element).slice(0, 40)}"`)
    }
    let scope = 1
    if (ancestors.length && !hasAncestors(element, ancestors)) {
        scope = OUT_OF_SCOPE
        whatChanged.push(`no longer inside ${ancestors.map(a => (a.tag ?? '') + a.classes.map(c => `.${c}`).join('')).join(' ')}`)
    }

    return { score: max === 0 ? 0 : (got / max) * scope, whatChanged }
}

export { matchesCompound, textMatches, hasAncestors }
