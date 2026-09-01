import type { Compound, Signals } from './types.ts'

/**
 * Attributes that carry identity survive redesigns; classes rarely do. Weighting them this way is
 * what keeps a Tailwind/Vuetify class churn from looking like a different element.
 */
const IDENTITY_ATTRS = new Set(['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'role', 'placeholder', 'type'])

const WEIGHT = { id: 4, identityAttr: 4, otherAttr: 2, text: 3, tag: 1, classes: 2, ancestors: 2 }

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
        const actual = element.getAttribute?.(attr.name)
        if (actual === null || actual === undefined) return false
        if (attr.value !== undefined && actual !== attr.value) return false
    }
    return true
}

/** How much of what the selector asked for this element still satisfies, and what it lost. */
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
        const actual = element.getAttribute?.(attr.name)
        if (actual !== null && actual !== undefined && (attr.value === undefined || actual === attr.value)) got += weight
        else whatChanged.push(`[${attr.name}] ${attr.value ?? ''} → ${actual ?? '(none)'}`)
    }
    if (text) {
        max += WEIGHT.text
        if (textMatches(element, text)) got += WEIGHT.text
        else whatChanged.push(`text ${text.regex ? `/${text.value}/` : `"${text.value}"`} → "${textOf(element).slice(0, 40)}"`)
    }
    if (ancestors.length) {
        max += WEIGHT.ancestors
        if (hasAncestors(element, ancestors)) got += WEIGHT.ancestors
        else whatChanged.push(`no longer inside ${ancestors.map(a => (a.tag ?? '') + a.classes.map(c => `.${c}`).join('')).join(' ')}`)
    }

    return { score: max === 0 ? 0 : got / max, whatChanged }
}

export { matchesCompound, textMatches, hasAncestors }
