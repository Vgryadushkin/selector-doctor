import { writeFileSync } from 'node:fs'
import { readHeals } from './healLog.ts'

type ReporterOptions = {
    outputFile?: string
    failOnRepeat?: boolean
    /** Must match the `logDir` given to `withHealing`, or the repeat guard reads an empty log. */
    logDir?: string
}

type Annotation = { type: string; description?: string }
type MinimalTestCase = { titlePath(): string[] }
type MinimalResult = { status: string }

const OUR_TYPES = ['locator-healed', 'locator-drift', 'locator-unhealed', 'locator-slow', 'locator-diagnosis-off']

/**
 * Collects the drift annotations of a run into one place: a markdown summary a human reads, and the
 * exit status that stops a healed suite from staying green forever.
 *
 *   reporter: [['selector-doctor/playwright/reporter', { failOnRepeat: true }]]
 */
export default class SelectorDoctorReporter {
    private readonly rows: { test: string; type: string; description: string }[] = []
    private readonly options: ReporterOptions

    constructor(options: ReporterOptions = {}) {
        this.options = options
    }

    onTestEnd(test: MinimalTestCase, result: MinimalResult & { annotations?: Annotation[] }): void {
        for (const annotation of result.annotations ?? []) {
            if (!OUR_TYPES.includes(annotation.type)) continue
            this.rows.push({
                test: test.titlePath().filter(Boolean).join(' › '),
                type: annotation.type,
                description: annotation.description ?? '',
            })
        }
    }

    onEnd(): { status?: 'failed' } | void {
        if (!this.rows.length) return
        const count = (type: string) => this.rows.filter(row => row.type === type).length
        const healed = count('locator-healed')
        const slow = count('locator-slow')
        const lines = [
            '# Selector drift',
            '',
            `${healed} step(s) healed, ${this.rows.length - healed - slow} reported without healing, ${slow} slow but intact.`,
            '',
            ...this.rows.map(row => `- **${row.type}** — ${row.test}\n  - ${row.description}`),
        ]

        // A locator that drifts in two separate runs is not a flake, it is an unmaintained page object.
        const seen = new Map<string, { count: number; origin?: string }>()
        for (const record of readHeals(this.options.logDir)) {
            const entry = seen.get(record.selector) ?? { count: 0, origin: record.origin }
            seen.set(record.selector, { count: entry.count + 1, origin: entry.origin ?? record.origin })
        }
        const repeats = [...seen].filter(([, entry]) => entry.count > 1)
        if (repeats.length) {
            lines.push('', '## Healed more than once — update the page object', '',
                ...repeats.map(([selector, entry]) => `- \`${selector}\` (${entry.count} runs)${entry.origin ? ` — declared at ${entry.origin}` : ''}`))
        }

        const file = this.options.outputFile ?? 'selector-drift.md'
        writeFileSync(file, `${lines.join('\n')}\n`)
        console.log(`\nSelector drift: ${healed} healed, ${this.rows.length - healed - slow} reported, ${slow} slow → ${file}`)

        if (this.options.failOnRepeat && repeats.length) return { status: 'failed' }
    }
}
