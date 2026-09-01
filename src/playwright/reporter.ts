import { writeFileSync } from 'node:fs'
import { readHeals } from './healLog.ts'

type Annotation = { type: string; description?: string }
type MinimalTestCase = { titlePath(): string[] }
type MinimalResult = { status: string }

const OUR_TYPES = ['locator-healed', 'locator-drift', 'locator-unhealed']

/**
 * Collects the drift annotations of a run into one place: a markdown summary a human reads, and the
 * exit status that stops a healed suite from staying green forever.
 *
 *   reporter: [['selector-doctor/playwright/reporter', { failOnRepeat: true }]]
 */
export default class SelectorDoctorReporter {
    private readonly rows: { test: string; type: string; description: string }[] = []
    private readonly options: { outputFile?: string; failOnRepeat?: boolean }

    constructor(options: { outputFile?: string; failOnRepeat?: boolean } = {}) {
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
        const healed = this.rows.filter(row => row.type === 'locator-healed')
        const lines = [
            '# Selector drift',
            '',
            `${healed.length} step(s) healed, ${this.rows.length - healed.length} reported without healing.`,
            '',
            ...this.rows.map(row => `- **${row.type}** — ${row.test}\n  - ${row.description}`),
        ]

        // A locator that drifts in two separate runs is not a flake, it is an unmaintained page object.
        const seen = new Map<string, number>()
        for (const record of readHeals()) seen.set(record.selector, (seen.get(record.selector) ?? 0) + 1)
        const repeats = [...seen].filter(([, count]) => count > 1)
        if (repeats.length) {
            lines.push('', '## Healed more than once — update the page object', '', ...repeats.map(([selector, count]) => `- \`${selector}\` (${count} runs)`))
        }

        const file = this.options.outputFile ?? 'selector-drift.md'
        writeFileSync(file, `${lines.join('\n')}\n`)
        console.log(`\nSelector drift: ${healed.length} healed, ${this.rows.length - healed.length} reported → ${file}`)

        if (this.options.failOnRepeat && repeats.length) return { status: 'failed' }
    }
}
