import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Candidate } from '../types.ts'

export type HealRecord = {
    at: string
    testTitle: string
    selector: string
    /** `pages/AuthorizedHeader.ts:42` - where the locator was built, when it could be determined. */
    origin?: string
    suggestion: string
    verdict: string
    score: number
    mode: string
}

const FILE = 'heals.jsonl'

/**
 * Every drift is appended, not overwritten: a locator healed in two runs in a row is a page object
 * nobody updated, and that is the signal the guard in CI looks for.
 */
export function appendHeal(
    entry: { testTitle: string; selector: string; origin?: string; suggestion: Candidate; mode: string },
    logDir = '.selector-doctor',
): void {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
    const record: HealRecord = {
        at: new Date().toISOString(),
        testTitle: entry.testTitle,
        selector: entry.selector,
        origin: entry.origin,
        suggestion: entry.suggestion.selector,
        verdict: entry.suggestion.verdict,
        score: entry.suggestion.score,
        mode: entry.mode,
    }
    appendFileSync(join(logDir, FILE), `${JSON.stringify(record)}\n`)
}

export function readHeals(logDir = '.selector-doctor'): HealRecord[] {
    const path = join(logDir, FILE)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line) as HealRecord)
}
