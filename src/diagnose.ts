import { parseHTML } from 'linkedom'
import { parseSelector, toCss } from './parseSelector.ts'
import { score, matchesCompound, textMatches, roleOf, roleQuery } from './score.ts'
import { generateSelector } from './generate.ts'
import type { Candidate, Diagnosis, Signals, Unexplored, Verdict } from './types.ts'

export type DiagnoseInput = {
    /** The selector that failed, raw - a Playwright locator chain is understood as well as plain CSS. */
    selector: string
    /** The page as it looked when the selector failed. */
    html: string
    /** Below this, a candidate is not reported at all. Default 0.5. */
    minScore?: number
}

/**
 * What this HTML provably could not show. `page.content()` serializes light DOM only: a shadow root
 * leaves its host behind as an empty custom element, and an iframe leaves a tag with no document.
 * Without this, a component-based app makes every diagnosis a confident - and wrong - `absent`.
 */
function unexploredSubtrees(document: any): Unexplored | undefined {
    const frames = document.querySelectorAll('iframe, frame').length
    // Declarative shadow DOM does serialize, but its content lives outside querySelectorAll's reach.
    let shadowHosts = document.querySelectorAll('template[shadowrootmode], template[shadowroot]').length
    for (const element of document.querySelectorAll('*')) {
        const tag = element.tagName?.toLowerCase() ?? ''
        if (!tag.includes('-')) continue
        if (element.children.length || (element.textContent ?? '').trim()) continue
        shadowHosts++
    }
    return shadowHosts || frames ? { shadowHosts, frames } : undefined
}

/** Elements the target compound would match if its ancestors were ignored. */
function relaxAncestors(document: any, signals: Signals): any[] {
    try {
        return [...document.querySelectorAll(toCss(signals.target))]
    } catch {
        return []
    }
}

/** Elements that keep the tag/attributes but lost the classes. */
function relaxClasses(document: any, signals: Signals): any[] {
    const withoutClasses = { ...signals.target, classes: [] }
    if (!withoutClasses.tag && !withoutClasses.id && !withoutClasses.attrs.length) return []
    try {
        return [...document.querySelectorAll(toCss(withoutClasses))].filter(element =>
            signals.target.classes.some(name => element.classList?.contains(name)) ||
            signals.target.attrs.every(attr => element.getAttribute?.(attr.name) !== null))
    } catch {
        return []
    }
}

/** Everything that answers to the role the selector asked for - `<button>` as well as `[role=button]`. */
function relaxRole(document: any, signals: Signals): any[] {
    const role = signals.target.attrs.find(attr => attr.name === 'role')?.value
    if (!role) return []
    try {
        return [...document.querySelectorAll(roleQuery(role))].filter(element => roleOf(element) === role)
    } catch {
        return []
    }
}

/** Leaf-most elements whose text is what the selector filtered on. */
function relaxToText(document: any, signals: Signals): any[] {
    if (!signals.text) return []
    const matching = [...document.querySelectorAll('*')].filter(element => textMatches(element, signals.text!))
    return matching.filter(element => ![...element.children].some((child: any) => textMatches(child, signals.text!)))
}

/** How many elements the suggestion actually resolves to - text qualifier included. */
function countMatches(document: any, suggestion: { css: string; hasText?: string }): number {
    const byCss = [...document.querySelectorAll(suggestion.css)]
    if (!suggestion.hasText) return byCss.length
    return byCss.filter(element => (element.textContent ?? '').replace(/\s+/g, ' ').trim() === suggestion.hasText).length
}

function intactNote(signals: Signals): string {
    return signals.requiresVisible
        ? 'The selector still matches - the failure is about visibility or timing, not identity.'
        : 'The selector still matches - look for a timing, state or backend cause.'
}

function verdictFor(whatChanged: string[]): Verdict {
    if (!whatChanged.length) return 'intact'
    if (whatChanged.every(change => change.startsWith('no longer inside'))) return 'moved'
    if (whatChanged.every(change => change.startsWith('text '))) return 'text-changed'
    return 'renamed'
}

/**
 * Answers the only question worth asking about a failed selector: did the element change identity,
 * or is it not there at all? Everything else - healing, reporting, ticketing - is a policy on top.
 */
export function diagnose({ selector, html, minScore = 0.5 }: DiagnoseInput): Diagnosis {
    const { document } = parseHTML(html)
    const signals = parseSelector(selector)

    // Nothing is searched for a selector that was not fully understood. A partial translation finds
    // a real element for a locator that meant something else, and reports it with full confidence.
    if (signals.unsupported.length) {
        return {
            selector,
            verdict: 'unreadable',
            candidates: [],
            unsupported: signals.unsupported,
            note: `This version cannot translate ${signals.unsupported.map(part => `"${part}"`).join(', ')} - no verdict about the element would be honest.`,
        }
    }

    // `getByText('Save')` is a bare target plus a text filter: without this every ancestor up to
    // <body> contains the text and would win the exact match.
    const bareTarget = !signals.target.tag && !signals.target.id && !signals.target.classes.length && !signals.target.attrs.length

    const fullChain = [...signals.ancestors.map(toCss), toCss(signals.target)].join(' ')
    let exact: any[] = []
    try {
        exact = [...document.querySelectorAll(fullChain)]
        if (signals.text) {
            exact = exact.filter(element => textMatches(element, signals.text!))
            if (bareTarget) exact = exact.filter(element => ![...element.children].some((child: any) => textMatches(child, signals.text!)))
        }
    } catch {
        exact = []
    }
    if (exact.length) {
        const suggestion = generateSelector(exact[0], document)
        return {
            selector,
            verdict: 'intact',
            note: intactNote(signals),
            candidates: [{
                ...suggestion,
                score: 1,
                matches: exact.length,
                whatChanged: [],
                verdict: 'intact',
            }],
        }
    }

    const pool = new Set<any>([
        ...relaxAncestors(document, signals),
        ...relaxClasses(document, signals),
        ...relaxRole(document, signals),
        ...relaxToText(document, signals),
    ])

    const candidates: Candidate[] = [...pool]
        .map(element => {
            const { score: value, whatChanged } = score(element, signals)
            const suggestion = generateSelector(element, document)
            return {
                ...suggestion,
                score: Number(value.toFixed(2)),
                matches: countMatches(document, suggestion),
                whatChanged,
                verdict: verdictFor(whatChanged),
            }
        })
        .filter(candidate => candidate.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)

    // A role or text locator never matches its own CSS - `[role=button]` does not find a <button> -
    // so an intact element can only surface through the relaxations. The note belongs to it all the same.
    if (candidates.length) {
        const verdict = candidates[0].verdict
        return { selector, verdict, candidates, note: verdict === 'intact' ? intactNote(signals) : undefined }
    }

    // Only worth the full-document walk once nothing was found - that is the only verdict it changes.
    const unexplored = unexploredSubtrees(document)
    const unreachable = [
        unexplored?.shadowHosts ? `${unexplored.shadowHosts} shadow host(s)` : '',
        unexplored?.frames ? `${unexplored.frames} frame(s)` : '',
    ].filter(Boolean).join(' and ')

    return {
        selector,
        verdict: 'absent',
        note: unexplored
            ? `Nothing close enough in the reachable DOM, but ${unreachable} were not serialized - treat this as inconclusive, not as proof the element is gone.`
            : 'Nothing close enough in the DOM - the element is most likely gone, not renamed.',
        candidates,
        unexplored,
    }
}
