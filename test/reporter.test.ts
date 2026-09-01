import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SelectorDoctorReporter from '../src/playwright/reporter.ts'

const heal = (selector: string, origin?: string) => JSON.stringify({
    at: new Date().toISOString(),
    testTitle: 'a test',
    selector,
    origin,
    suggestion: 'header.mobile-header div.profile-avatar',
    verdict: 'moved',
    score: 0.6,
    mode: 'heal',
})

/** A run that healed the same locator as some earlier run - the state `failOnRepeat` exists for. */
function runWith(options: { failOnRepeat?: boolean }, records: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'selector-doctor-'))
    writeFileSync(join(dir, 'heals.jsonl'), records.map(record => `${record}\n`).join(''))
    const outputFile = join(dir, 'drift.md')
    const reporter = new SelectorDoctorReporter({ ...options, logDir: dir, outputFile })

    reporter.onTestEnd(
        { titlePath: () => ['spec.ts', 'a test'] },
        { status: 'failed', annotations: [{ type: 'locator-healed', description: '.header div.profile-avatar → div.profile-avatar' }] },
    )
    const result = reporter.onEnd()
    const report = readFileSync(outputFile, 'utf-8')
    rmSync(dir, { recursive: true, force: true })
    return { result, report }
}

test('the repeat guard reads the log directory it was configured with', () => {
    const { result, report } = runWith({ failOnRepeat: true }, [
        heal('.header div.profile-avatar', 'pages/Header.ts:42'),
        heal('.header div.profile-avatar', 'pages/Header.ts:42'),
    ])
    assert.deepEqual(result, { status: 'failed' })
    assert.match(report, /Healed more than once/)
    assert.match(report, /declared at pages\/Header\.ts:42/)
})

test('a locator healed once is a buffer, not a failure', () => {
    const { result, report } = runWith({ failOnRepeat: true }, [heal('.header div.profile-avatar')])
    assert.equal(result, undefined)
    assert.doesNotMatch(report, /Healed more than once/)
})

test('without failOnRepeat the repeat is reported but the run stands', () => {
    const { result, report } = runWith({}, [heal('.a'), heal('.a')])
    assert.equal(result, undefined)
    assert.match(report, /Healed more than once/)
})
