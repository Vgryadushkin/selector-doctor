import { diagnose } from '../diagnose.ts'
import { appendHeal } from './healLog.ts'

// Typed structurally on purpose: the package must not depend on Playwright, so it can be installed
// next to any version of it - and the adapter only ever touches these members.
type MinimalPage = { content(): Promise<string>; locator(selector: string, options?: unknown): any }
type MinimalTestInfo = {
    title: string
    titlePath?: string[]
    annotations: { type: string; description?: string }[]
}

export type HealingMode =
    /** Do nothing - the wrapper is inert. */
    | 'off'
    /** Diagnose and annotate, then fail as before. The honest default for a regression suite. */
    | 'report'
    /** Retry the step with the healed locator and let the test pass, annotating the drift. */
    | 'heal'

export type HealingOptions = {
    mode?: HealingMode
    /** Below this score a candidate is never used, only reported. */
    minScore?: number
    /**
     * Timeout for the first attempt while healing is on. Without it every drifted locator costs the
     * full action timeout before the diagnosis even starts.
     */
    probeTimeout?: number
    /** Where the drift log is appended, for the "healed twice in a row" guard. */
    logDir?: string
}

/** Actions worth healing. Assertions are absent by design - they fail inside the matcher. */
const HEALABLE = new Set([
    'click', 'dblclick', 'fill', 'press', 'hover', 'check', 'uncheck', 'selectOption',
    'scrollIntoViewIfNeeded', 'tap', 'focus', 'clear', 'setInputFiles', 'type',
])

/** Chaining methods that must keep returning a healing locator. */
const CHAINABLE = new Set(['locator', 'filter', 'first', 'last', 'nth', 'getByRole', 'getByText', 'getByLabel', 'getByTestId', 'getByPlaceholder', 'and', 'or'])

const isTimeout = (error: unknown) =>
    error instanceof Error && /Timeout .*exceeded|waiting for locator/i.test(error.message)

function withProbeTimeout(args: unknown[], probeTimeout?: number): unknown[] {
    if (!probeTimeout) return args
    const last = args[args.length - 1]
    if (last && typeof last === 'object' && !Array.isArray(last)) {
        return [...args.slice(0, -1), { timeout: probeTimeout, ...(last as object) }]
    }
    return [...args, { timeout: probeTimeout }]
}

/**
 * Wraps a page so that a locator failing on a timeout gets diagnosed - and, in `heal` mode, retried
 * with the selector that now identifies the same element. The test's own code stays untouched:
 * page objects build their locators from this page and never know.
 */
export function withHealing<T extends MinimalPage>(page: T, testInfo: MinimalTestInfo, options: HealingOptions = {}): T {
    const mode = options.mode ?? (process.env.HEAL as HealingMode) ?? 'report'
    if (mode === 'off') return page

    const { minScore = 0.8, probeTimeout, logDir } = options

    const healLocator = (locator: any): any => new Proxy(locator, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (typeof value !== 'function' || typeof property !== 'string') return value

            if (CHAINABLE.has(property)) {
                return (...args: unknown[]) => healLocator(value.apply(target, args))
            }
            if (!HEALABLE.has(property)) return value.bind(target)

            return async (...args: unknown[]) => {
                try {
                    return await value.apply(target, withProbeTimeout(args, probeTimeout))
                } catch (error) {
                    if (!isTimeout(error)) throw error

                    // Playwright's own toString() is the locator chain the diagnosis knows how to read.
                    const selector = String(target)
                    const result = diagnose({ selector, html: await page.content() })
                    const best = result.candidates[0]
                    const usable = best && best.score >= minScore && best.matches === 1

                    if (!usable) {
                        testInfo.annotations.push({
                            type: 'locator-unhealed',
                            description: `${selector} — ${result.verdict}${result.note ? `: ${result.note}` : ''}`,
                        })
                        throw error
                    }

                    const description = `${selector} → ${best.selector} (${result.verdict}, score ${best.score}; ${best.whatChanged.join('; ')})`
                    appendHeal({ testTitle: testInfo.titlePath?.join(' › ') ?? testInfo.title, selector, suggestion: best, mode }, logDir)

                    if (mode === 'report') {
                        testInfo.annotations.push({ type: 'locator-drift', description })
                        throw error
                    }

                    testInfo.annotations.push({ type: 'locator-healed', description })
                    const healed = best.hasText
                        ? page.locator(best.css).filter({ hasText: best.hasText })
                        : page.locator(best.css)
                    return await (healed as any)[property](...args)
                }
            }
        },
    })

    return new Proxy(page, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (typeof value !== 'function' || typeof property !== 'string') return value
            if (!CHAINABLE.has(property)) return value.bind(target)
            return (...args: unknown[]) => healLocator(value.apply(target, args))
        },
    }) as T
}
