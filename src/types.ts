/** One compound selector, e.g. `div.profile-avatar[data-role=user]`. */
export type Compound = {
    tag?: string
    id?: string
    classes: string[]
    attrs: { name: string; value?: string }[]
}

/** Everything a selector asks for, split into signals that can be relaxed one by one. */
export type Signals = {
    raw: string
    /** The element the selector points at - the last compound of the chain. */
    target: Compound
    /** Everything the target was expected to live under, outermost first. */
    ancestors: Compound[]
    /** Parts of the selector this version cannot translate - an xpath, an unknown engine. */
    unsupported: string[]
    text?: { value: string; regex: boolean; ignoreCase: boolean }
    requiresVisible: boolean
}

export type Verdict =
    /** The selector still matches something - the failure was not about the selector. */
    | 'intact'
    /** The element is there, but no longer under the ancestors the selector demands. */
    | 'moved'
    /** The element is there under a different identity (classes/attributes changed). */
    | 'renamed'
    /** Only the text the selector filtered on is different. */
    | 'text-changed'
    /** Nothing close enough - most likely the element is genuinely gone. */
    | 'absent'
    /** Part of the selector could not be translated, so no claim about the element is justified. */
    | 'unreadable'

export type Candidate = {
    /** Playwright-flavoured, ready to show a human: `div.v-list-item:has-text("Week")`. */
    selector: string
    /** The CSS half of the suggestion - what `page.locator()` takes. */
    css: string
    /** Set when CSS alone is ambiguous and text is what separates the element from its siblings. */
    hasText?: string
    /** 0..1 - how much of the original selector's signals this element still satisfies. */
    score: number
    /** How many elements `selector` matches. Anything but 1 is unsafe to heal with. */
    matches: number
    /** Human-readable list of the signals that no longer hold. */
    whatChanged: string[]
    verdict: Verdict
}

/** Parts of the page the serialized HTML could not show. */
export type Unexplored = {
    /** Custom elements that are empty in the serialization - the usual sign of a shadow root. */
    shadowHosts: number
    /** Frames, whose documents are not part of this HTML at all. */
    frames: number
}

export type Diagnosis = {
    selector: string
    verdict: Verdict
    candidates: Candidate[]
    /** Anything the caller should know that the verdict alone does not say. */
    note?: string
    /**
     * Set when the DOM had subtrees this HTML cannot reach. Present with `absent` it means the
     * verdict is inconclusive, not final - the element may be alive inside a shadow root or a frame.
     */
    unexplored?: Unexplored
    /** The parts of the selector that could not be read, when the verdict is `unreadable`. */
    unsupported?: string[]
}
