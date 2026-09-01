import { parseHTML } from 'linkedom'
import { parseSelector, toCss } from './parseSelector.ts'
import { score, matchesCompound, textMatches } from './score.ts'
import { generateSelector } from './generate.ts'
import type { Candidate, Diagnosis, Signals, Verdict } from './types.ts'

export type DiagnoseInput = {
    /** The selector that failed, raw - a Playwright locator chain is understood as well as plain CSS. */
    selector: string
    /** The page as it looked when the selector failed. */
    html: string
    /** Below this, a candidate is not reported at all. Default 0.5. */
    minScore?: number
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

    const fullChain = [...signals.ancestors.map(toCss), toCss(signals.target)].join(' ')
    let exact: any[] = []
    try {
        exact = [...document.querySelectorAll(fullChain)]
        if (signals.text) exact = exact.filter(element => textMatches(element, signals.text!))
    } catch {
        exact = []
    }
    if (exact.length) {
        const suggestion = generateSelector(exact[0], document)
        return {
            selector,
            verdict: 'intact',
            note: signals.requiresVisible
                ? 'The selector still matches - the failure is about visibility or timing, not identity.'
                : 'The selector still matches - look for a timing, state or backend cause.',
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

    return {
        selector,
        verdict: candidates.length ? candidates[0].verdict : 'absent',
        note: candidates.length ? undefined : 'Nothing close enough in the DOM - the element is most likely gone, not renamed.',
        candidates,
    }
}
