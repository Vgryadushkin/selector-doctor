import type { Compound, Signals } from './types.ts'

/** One step of a locator chain, already reduced to CSS this tool can query. */
type Part = { css: string; text?: Signals['text'] }

const QUOTED = /^\s*(['"`])([\s\S]*)\1\s*$/

function unquote(value: string): string {
    const match = value.match(QUOTED)
    return match ? match[2].replace(/\\(['"`])/g, '$1') : value.trim()
}

/** Top-level comma split - `'button', { name: 'Save' }` is two arguments, not three. */
function args(input: string): string[] {
    const out: string[] = []
    let depth = 0
    let quote = ''
    let start = 0
    for (let i = 0; i < input.length; i++) {
        const character = input[i]
        if (quote) {
            if (character === quote && input[i - 1] !== '\\') quote = ''
            continue
        }
        if (character === '"' || character === "'" || character === '`') quote = character
        else if ('([{'.includes(character)) depth++
        else if (')]}'.includes(character)) depth--
        else if (character === ',' && depth === 0) {
            out.push(input.slice(start, i))
            start = i + 1
        }
    }
    out.push(input.slice(start))
    return out.map(value => value.trim()).filter(Boolean)
}

/** `"Save"i` and `/Save/i` are how Playwright writes a matched string in its own selectors. */
function matchedString(value: string): Signals['text'] | undefined {
    const regex = value.match(/^\/([\s\S]*)\/([a-z]*)$/)
    if (regex) return { value: regex[1], regex: true, ignoreCase: regex[2].includes('i') }
    const literal = value.match(/^"((?:[^"\\]|\\.)*)"([si]*)$/)
    if (literal) return { value: literal[1].replace(/\\"/g, '"'), regex: false, ignoreCase: !literal[2].includes('s') }
    return undefined
}

/**
 * The name of a role is matched whole, not as a substring: `getByRole('button', { name: 'A' })` does
 * not match a button reading "Save". Anchoring it as a regex keeps that difference without the text
 * signal needing to carry an exactness flag of its own.
 */
function accessibleName(text: Signals['text'] | undefined, exact: boolean): Signals['text'] | undefined {
    if (!text || text.regex || !exact) return text
    return { value: `^\\s*${text.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, regex: true, ignoreCase: text.ignoreCase }
}

/**
 * The selector engines Playwright prints instead of CSS once a locator is built with `getBy*`:
 * `internal:testid=[data-testid="avatar"s]`, `internal:role=button[name="Save"i]`. Left untranslated
 * they parse as a tag called `internal` and every such locator gets diagnosed `absent` - a confident
 * lie about the locator style Playwright's own documentation recommends.
 */
function fromEngine(part: string): Part | undefined {
    const engine = part.match(/^internal:([a-z-]+)=([\s\S]*)$/)
    if (!engine) return undefined
    const [, name, body] = engine

    if (name === 'testid' || name === 'attr') {
        const attribute = body.replace(/^\[|\]$/g, '').match(/^([\w-]+)\s*=\s*([\s\S]*)$/)
        const value = attribute && matchedString(attribute[2].trim())
        return value ? { css: `[${attribute![1]}="${value.value}"]` } : undefined
    }
    if (name === 'label') {
        const value = matchedString(body.trim())
        return value ? { css: `[aria-label="${value.value}"]` } : undefined
    }
    if (name === 'text' || name === 'has-text') {
        const value = matchedString(body.trim())
        return value ? { css: '*', text: value } : undefined
    }
    if (name === 'role') {
        const role = body.match(/^([\w-]+)/)
        if (!role) return undefined
        const named = body.match(/\[name\s*=\s*([\s\S]*?)\]\s*$/)
        return { css: `[role="${role[1]}"]`, text: accessibleName(named ? matchedString(named[1].trim()) : undefined, true) }
    }
    // Known engine, unreadable body - and every engine this version has never heard of.
    return undefined
}

/**
 * Splits on `>>` and reads each piece with the engine it declares. A piece nothing here understands
 * is recorded, never guessed at: translated to `*` it made `internal:has=[data-x]` match the first
 * child of the scope and report `intact`, which is a fabricated answer about an element the selector
 * never asked for.
 */
function cssToParts(css: string, unsupported: string[]): Part[] {
    return css.split('>>').flatMap(piece => {
        const trimmed = piece.trim()
        if (!trimmed) return []
        // A positional filter narrows a set without saying anything about identity.
        if (/^nth=/.test(trimmed)) return []

        if (trimmed.startsWith('internal:')) {
            const engine = fromEngine(trimmed)
            if (engine) return [engine]
            unsupported.push(trimmed)
            return []
        }

        const prefixed = trimmed.match(/^([a-z-]+)=([\s\S]*)$/)
        if (prefixed) {
            const [, engine, body] = prefixed
            if (engine === 'css') return cssToParts(body, unsupported)
            if (engine === 'text') {
                const text = matchedString(body.trim()) ?? { value: unquote(body), regex: false, ignoreCase: true }
                return [{ css: '*', text }]
            }
            unsupported.push(trimmed)
            return []
        }
        if (trimmed.startsWith('//') || trimmed.startsWith('(//')) {
            unsupported.push(trimmed)
            return []
        }

        return trimmed.replace(/\s*>\s*/g, ' ').split(/\s+/).filter(Boolean).map(token => ({ css: token }))
    })
}

/** `getByRole('button', { name: 'Save' })` and friends, as written in source or printed by Playwright. */
function fromCall(name: string, argument: string, unsupported: string[]): Part[] {
    const parameters = args(argument)
    const first = unquote(parameters[0] ?? '')
    const attribute = (attr: string): Part[] => (first ? [{ css: `[${attr}="${first}"]` }] : [])

    switch (name) {
        case 'locator': return cssToParts(first, unsupported)
        case 'getByTestId': return attribute('data-testid')
        case 'getByLabel': return attribute('aria-label')
        case 'getByPlaceholder': return attribute('placeholder')
        case 'getByAltText': return attribute('alt')
        case 'getByTitle': return attribute('title')
        case 'getByText': {
            const text = matchedString(parameters[0] ?? '') ?? { value: first, regex: false, ignoreCase: !/exact:\s*true/.test(argument) }
            return [{ css: '*', text }]
        }
        case 'getByRole': {
            const named = argument.match(/name:\s*([\s\S]*?)\s*[,}]/)
            const text = named ? matchedString(named[1]) ?? { value: unquote(named[1]), regex: false, ignoreCase: true } : undefined
            return first ? [{ css: `[role="${first}"]`, text: accessibleName(text, !/exact:\s*false/.test(argument)) }] : []
        }
        // first/last/nth/and/or narrow a set without changing what the element is.
        default: return []
    }
}

/** The calls of a locator chain, in order, with their arguments - quotes and nesting respected. */
function calls(input: string): { name: string; args: string }[] {
    const out: { name: string; args: string }[] = []
    const start = /(?:^|\.)(locator|getBy[A-Za-z]+|filter|first|last|nth|and|or)\(/g
    let match: RegExpExecArray | null
    while ((match = start.exec(input))) {
        let depth = 1
        let quote = ''
        let index = start.lastIndex
        for (; index < input.length && depth; index++) {
            const character = input[index]
            if (quote) {
                if (character === quote && input[index - 1] !== '\\') quote = ''
                continue
            }
            if (character === '"' || character === "'" || character === '`') quote = character
            else if (character === '(') depth++
            else if (character === ')') depth--
        }
        out.push({ name: match[1], args: input.slice(start.lastIndex, index - 1) })
        start.lastIndex = index
    }
    return out
}

function toParts(raw: string, unsupported: string[]): Part[] {
    const chain = calls(raw)
    if (!chain.length) return cssToParts(raw, unsupported)

    const parts: Part[] = []
    for (const call of chain) {
        if (call.name === 'filter') {
            const named = call.args.match(/hasText:\s*([\s\S]*?)\s*[,}]/)
            const text = named ? matchedString(named[1]) ?? { value: unquote(named[1]), regex: false, ignoreCase: true } : undefined
            if (text && parts.length) parts[parts.length - 1] = { ...parts[parts.length - 1], text }
            continue
        }
        parts.push(...fromCall(call.name, call.args, unsupported))
    }
    return parts.length ? parts : cssToParts(raw, unsupported)
}

/** `div:has-text("Save")` written by hand, outside any chain syntax. */
function inlineText(raw: string): Signals['text'] | undefined {
    const match = raw.match(/:has-text\(\s*(['"])([\s\S]*?)\1\s*\)/)
    return match ? { value: match[2], regex: false, ignoreCase: true } : undefined
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
    const raw = selector.trim().replace(/^Locator@/, '')
    const unsupported: string[] = []
    const parts = toParts(raw, unsupported)
    const chain = parts.map(part => parseCompound(part.css))

    // The target keeps its place even when it carries no CSS of its own: `getByText('Save')` is a
    // bare element plus a text filter, and dropping it would promote its ancestor to the target.
    const target = chain.pop() ?? { classes: [], attrs: [] }
    const ancestors = chain.filter(compound => compound.tag || compound.id || compound.classes.length || compound.attrs.length)

    return {
        raw: selector,
        target,
        ancestors,
        unsupported,
        text: [...parts].reverse().find(part => part.text)?.text ?? inlineText(raw),
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
