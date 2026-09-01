import type { Compound, Signals } from './types.ts'

/**
 * Playwright prints locators as a chain: `locator('.a').locator('b').filter({ hasText: /x/i })`.
 * Flatten that into the plain CSS-ish chain plus the text filter, so the same parser handles
 * both a raw CSS string and whatever ends up in an error message.
 */
function flattenPlaywrightChain(input: string): { css: string; text?: Signals['text'] } {
    let text: Signals['text'] | undefined
    let css = input.trim()

    const hasTextRegex = css.match(/hasText:\s*\/(.+?)\/([a-z]*)/)
    if (hasTextRegex) {
        text = { value: hasTextRegex[1], regex: true, ignoreCase: hasTextRegex[2].includes('i') }
    } else {
        const hasTextString = css.match(/hasText:\s*['"](.+?)['"]/) ?? css.match(/:has-text\(['"](.+?)['"]\)/)
        if (hasTextString) text = { value: hasTextString[1], regex: false, ignoreCase: true }
    }

    if (css.includes('locator(')) {
        const parts = [...css.matchAll(/locator\(\s*['"](.+?)['"]\s*\)/g)].map(match => match[1])
        if (parts.length) css = parts.join(' ')
    }

    // Drop what is left of the chain syntax - filters and modifiers are captured above.
    css = css.replace(/\.(filter|first|last|nth)\([^)]*\)/g, '').trim()
    return { css, text }
}

const COMPOUND_TOKEN = /([.#]?[\w-]+|\[[^\]]+\]|:[\w-]+(\([^)]*\))?)/g

function parseCompound(token: string): Compound {
    const compound: Compound = { classes: [], attrs: [] }
    for (const [piece] of token.matchAll(COMPOUND_TOKEN)) {
        if (piece.startsWith('.')) compound.classes.push(piece.slice(1))
        else if (piece.startsWith('#')) compound.id = piece.slice(1)
        else if (piece.startsWith('[')) {
            const attr = piece.slice(1, -1).match(/^([\w-]+)(?:\s*[*^$|~]?=\s*['"]?(.*?)['"]?)?$/)
            if (attr) compound.attrs.push({ name: attr[1], value: attr[2] })
        } else if (piece.startsWith(':')) {
            // Pseudo-classes carry no identity of their own; `:visible` is kept separately.
            continue
        } else if (!compound.tag) compound.tag = piece.toLowerCase()
    }
    return compound
}

/** Splits a selector into the signals it asks for, ready to be relaxed one at a time. */
export function parseSelector(selector: string): Signals {
    const { css, text } = flattenPlaywrightChain(selector)
    const chain = css
        .replace(/\s*>\s*/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(parseCompound)
        .filter(compound => compound.tag || compound.id || compound.classes.length || compound.attrs.length)

    const target = chain.pop() ?? { classes: [], attrs: [] }
    return {
        raw: selector,
        target,
        ancestors: chain,
        text,
        requiresVisible: /:visible\b/.test(selector),
    }
}

/** The CSS the signals describe, minus anything a browser would not accept. */
export function toCss(compound: Compound): string {
    return [
        compound.tag ?? '',
        compound.id ? `#${compound.id}` : '',
        compound.classes.map(name => `.${CSS_ESCAPE(name)}`).join(''),
        compound.attrs.map(attr => (attr.value === undefined ? `[${attr.name}]` : `[${attr.name}="${attr.value}"]`)).join(''),
    ].join('') || '*'
}

// linkedom has no CSS.escape; class names in these suites are plain enough for a light guard.
const CSS_ESCAPE = (value: string) => value.replace(/([^\w-])/g, '\\$1')
