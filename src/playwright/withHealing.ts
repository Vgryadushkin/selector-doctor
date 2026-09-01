import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    /**
     * Diagnoses this worker will run before going inert. When a whole suite goes red at once the
     * cause is the environment, not fifty page objects - and paying for fifty diagnoses to be told
     * that fifty times is waste. Default 25, per worker process.
     */
    maxDiagnoses?: number
    /**
     * Record the file:line where the page object built the locator. That is the anchor a fix needs -
     * the locator string alone does not exist anywhere in the source. Costs a stack capture per
     * locator; set false on very large suites. Default true.
     */
    captureCallSite?: boolean
}

/** Actions worth healing. Assertions are absent by design - they fail inside the matcher. */
const HEALABLE = new Set([
    'click', 'dblclick', 'fill', 'press', 'pressSequentially', 'hover', 'check', 'uncheck', 'setChecked',
    'selectOption', 'selectText', 'scrollIntoViewIfNeeded', 'tap', 'focus', 'blur', 'clear',
    'setInputFiles', 'dragTo', 'dispatchEvent', 'type',
])

/** Chaining methods that must keep returning a healing locator. */
// `frameLocator` is deliberately absent: its document is not in `page.content()`, so anything found
// for it would be found in the wrong document.
const CHAINABLE = new Set(['locator', 'filter', 'first', 'last', 'nth', 'getByRole', 'getByText', 'getByLabel',
    'getByTestId', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'and', 'or'])

const isTimeout = (error: unknown) =>
    error instanceof Error && /Timeout .*exceeded|waiting for locator/i.test(error.message)

const SELF = fileURLToPath(import.meta.url).replace(/withHealing\.ts$/, '')

/**
 * Where the page object built this locator, as `pages/AuthorizedHeader.ts:42`. The heal log without
 * it is a list of runtime selector strings that appear nowhere in the repository, which is why a
 * `--fix` writing patches from it would be guesswork.
 */
function callSite(): string | undefined {
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 12
    const stack = new Error().stack ?? ''
    Error.stackTraceLimit = limit

    for (const line of stack.split('\n').slice(2)) {
        if (line.includes(SELF) || line.includes('node_modules') || line.includes('node:')) continue
        const frame = line.match(/\(?(?:file:\/\/)?(\/[^):]+):(\d+):\d+\)?\s*$/)
        if (frame) return `${relative(process.cwd(), frame[1])}:${frame[2]}`
    }
    return undefined
}

const MODES = new Set<HealingMode>(['off', 'report', 'heal'])

/**
 * `HEAL=heal npx playwright test` has to win over the fixture, or it could never turn healing on for
 * a run - the fixture is where the mode is written down. Anything unrecognised is refused rather
 * than passed through: `HEAL=1` reaching the healing branch would enable it by accident, and healing
 * is opt-in by design.
 */
function resolveMode(option: HealingMode | undefined): HealingMode {
    const fallback = option && MODES.has(option) ? option : 'report'
    if (option && !MODES.has(option)) {
        console.warn(`selector-doctor: mode "${option}" is not one of off|report|heal - using report.`)
    }
    const requested = process.env.HEAL?.trim()
    if (!requested) return fallback
    if (MODES.has(requested as HealingMode)) return requested as HealingMode
    console.warn(`selector-doctor: HEAL="${requested}" is not one of off|report|heal - using ${fallback}.`)
    return fallback
}

/** Per worker process, not per test: the budget exists to cap a whole run gone red. */
let diagnosesUsed = 0

/** Positional arguments each action takes before its options object: `dragTo(target, options)`. */
const POSITIONAL: Record<string, number> = {
    fill: 1, press: 1, pressSequentially: 1, type: 1, selectOption: 1, setInputFiles: 1,
    setChecked: 1, dragTo: 1, dispatchEvent: 2,
}

/**
 * A trailing object is only the options bag once the positional arguments are accounted for.
 * Assuming it always is destroyed the call it was meant to speed up: `dragTo(target)` had its target
 * locator replaced by `{ timeout }`, and `selectOption({ label: 'Week' })` had the value merged into
 * the options - both silently, and only for suites that set `probeTimeout`.
 */
function withProbeTimeout(method: string, args: unknown[], probeTimeout?: number): unknown[] {
    if (!probeTimeout) return args
    const positional = POSITIONAL[method] ?? 0
    // Fewer arguments than the signature takes: appending would land in a positional slot.
    if (args.length < positional) return args

    const last = args[args.length - 1]
    if (args.length > positional && last && typeof last === 'object' && !Array.isArray(last)) {
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
    const mode = resolveMode(options.mode)
    if (mode === 'off') return page

    const { minScore = 0.8, probeTimeout, logDir, maxDiagnoses = 25, captureCallSite = true } = options
    let budgetReported = false

    const healLocator = (locator: any, origin?: string): any => new Proxy(locator, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (typeof value !== 'function' || typeof property !== 'string') return value

            if (CHAINABLE.has(property)) {
                // The chain keeps the site where it started: that is the line in the page object.
                return (...args: unknown[]) => healLocator(value.apply(target, args), origin)
            }
            if (!HEALABLE.has(property)) return value.bind(target)

            return async (...args: unknown[]) => {
                try {
                    return await value.apply(target, withProbeTimeout(property, args, probeTimeout))
                } catch (error) {
                    if (!isTimeout(error)) throw error

                    // Playwright's own toString() is the locator chain the diagnosis knows how to read.
                    const selector = String(target)
                    const where = origin ? ` [${origin}]` : ''

                    if (diagnosesUsed >= maxDiagnoses) {
                        if (!budgetReported) {
                            budgetReported = true
                            testInfo.annotations.push({
                                type: 'locator-diagnosis-off',
                                description: `${maxDiagnoses} diagnoses spent in this worker — the rest of the run fails undiagnosed. A suite failing at this scale is an environment, not a page object.`,
                            })
                        }
                        throw error
                    }
                    diagnosesUsed++

                    const result = diagnose({ selector, html: await page.content() })
                    const best = result.candidates[0]

                    // Two cases cannot justify failing on a shortened timeout: the selector still
                    // matches, or the diagnosis could not read it. Both get the full timeout back -
                    // otherwise `probeTimeout` becomes a flake generator, failing at 2s what had 30s.
                    if (result.verdict === 'intact' || result.verdict === 'unreadable') {
                        if (!probeTimeout) throw error
                        testInfo.annotations.push(result.verdict === 'intact'
                            ? { type: 'locator-slow', description: `${selector}${where} — still matches after ${probeTimeout}ms, retried with the full timeout` }
                            : { type: 'locator-unhealed', description: `${selector}${where} — unreadable${result.note ? `: ${result.note}` : ''}` })
                        return await value.apply(target, args)
                    }

                    const usable = best && best.score >= minScore && best.matches === 1

                    if (!usable) {
                        testInfo.annotations.push({
                            type: 'locator-unhealed',
                            description: `${selector}${where} — ${result.verdict}${result.note ? `: ${result.note}` : ''}`,
                        })
                        throw error
                    }

                    const description = `${selector}${where} → ${best.selector} (${result.verdict}, score ${best.score}; ${best.whatChanged.join('; ')})`
                    appendHeal({ testTitle: testInfo.titlePath?.join(' › ') ?? testInfo.title, selector, origin, suggestion: best, mode }, logDir)

                    // Anything but an explicit `heal` fails as before: the safe half of the branch is
                    // the one an unexpected mode has to land in.
                    if (mode !== 'heal') {
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
            return (...args: unknown[]) => healLocator(value.apply(target, args), captureCallSite ? callSite() : undefined)
        },
    }) as T
}
