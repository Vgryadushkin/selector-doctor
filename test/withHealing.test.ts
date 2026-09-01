import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withHealing, readHeals } from '../src/playwright/index.ts'

// The adapter is typed structurally so the package never depends on Playwright - which also means a
// page with `content()` and `locator()` is all these tests need.

const withAvatar = `<body><header class="header"><div class="profile-avatar"><img src="a.png"></div></header></body>`
const withoutAvatar = `<body><header class="header"><button class="login">Log in</button></header></body>`

function fakePage(html: string, onAction: (options: any) => Promise<unknown>) {
    return {
        content: async () => html,
        locator: (selector: string) => ({
            toString: () => selector,
            click: (options: any = {}) => onAction(options),
            filter: () => ({ toString: () => selector, click: (options: any = {}) => onAction(options) }),
        }),
    }
}

const timeout = (ms: number) => new Error(`Timeout ${ms}ms exceeded.`)
const newTestInfo = () => ({ title: 'a test', annotations: [] as { type: string; description?: string }[] })

test('a slow but intact locator is retried with the full timeout instead of failing', async () => {
    const attempts: any[] = []
    const page = fakePage(withAvatar, async options => {
        attempts.push(options)
        if (options.timeout === 2000) throw timeout(2000)
        return 'clicked'
    })
    const testInfo = newTestInfo()
    const healing = withHealing(page as any, testInfo as any, { mode: 'report', probeTimeout: 2000 })

    assert.equal(await healing.locator('.header div.profile-avatar').click(), 'clicked')
    assert.equal(attempts.length, 2, 'the probe and the real attempt')
    assert.equal(attempts[1].timeout, undefined, 'the retry uses the suite timeout, not the probe one')
    assert.equal(testInfo.annotations[0].type, 'locator-slow')
})

test('the page object line that built the locator is reported with the drift', async () => {
    const page = fakePage(withoutAvatar, async () => { throw timeout(2000) })
    const testInfo = newTestInfo()
    const healing = withHealing(page as any, testInfo as any, { mode: 'report', probeTimeout: 2000 })

    await assert.rejects(() => healing.locator('.header div.profile-avatar').click())
    assert.equal(testInfo.annotations[0].type, 'locator-unhealed')
    assert.match(testInfo.annotations[0].description ?? '', /withHealing\.test\.ts:\d+/)
})

test('the diagnosis budget stops a run that has gone red at scale', async () => {
    let contentReads = 0
    const page = {
        content: async () => { contentReads++; return withoutAvatar },
        locator: (selector: string) => ({ toString: () => selector, click: async () => { throw timeout(2000) } }),
    }
    const testInfo = newTestInfo()
    const healing = withHealing(page as any, testInfo as any, { mode: 'report', probeTimeout: 2000, maxDiagnoses: 0 })

    await assert.rejects(() => healing.locator('.header div.profile-avatar').click())
    await assert.rejects(() => healing.locator('.header div.profile-avatar').click())
    assert.equal(contentReads, 0, 'no page is serialized once the budget is spent')
    assert.deepEqual(testInfo.annotations.map(a => a.type), ['locator-diagnosis-off'], 'and it is said once, not per failure')
})

const movedAvatar = `<body><header class="mobile-header"><div class="profile-avatar"><img src="a.png"></div></header></body>`

test('heal mode retries with the healed locator and writes the drift down', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'selector-doctor-'))
    const page = fakePage(movedAvatar, async options => {
        if (options.timeout === 2000) throw timeout(2000)
        return 'clicked'
    })
    const testInfo = newTestInfo()
    const healing = withHealing(page as any, testInfo as any, { mode: 'heal', probeTimeout: 2000, logDir })

    assert.equal(await healing.locator('.header div.profile-avatar').click(), 'clicked')
    assert.equal(testInfo.annotations[0].type, 'locator-healed')

    const [record] = readHeals(logDir)
    assert.equal(record.verdict, 'moved')
    assert.equal(record.mode, 'heal')
    assert.match(record.origin ?? '', /withHealing\.test\.ts:\d+/)
    rmSync(logDir, { recursive: true, force: true })
})

test('HEAL overrides the mode written in the fixture', async () => {
    process.env.HEAL = 'heal'
    const logDir = mkdtempSync(join(tmpdir(), 'selector-doctor-'))
    try {
        const page = fakePage(movedAvatar, async options => {
            if (options.timeout === 2000) throw timeout(2000)
            return 'clicked'
        })
        const testInfo = newTestInfo()
        const healing = withHealing(page as any, testInfo as any, { mode: 'report', probeTimeout: 2000, logDir })

        assert.equal(await healing.locator('.header div.profile-avatar').click(), 'clicked')
        assert.equal(testInfo.annotations[0].type, 'locator-healed')
    } finally {
        delete process.env.HEAL
        rmSync(logDir, { recursive: true, force: true })
    }
})

test('a HEAL value that is not a mode never enables healing', async () => {
    process.env.HEAL = '1'
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (message: string) => { warnings.push(message) }
    try {
        const page = fakePage(movedAvatar, async () => { throw timeout(2000) })
        const testInfo = newTestInfo()
        const healing = withHealing(page as any, testInfo as any, { mode: 'report', probeTimeout: 2000 })

        await assert.rejects(() => healing.locator('.header div.profile-avatar').click(), 'report is what an unknown value falls back to')
        assert.equal(testInfo.annotations[0].type, 'locator-drift')
        assert.match(warnings.join(' '), /HEAL="1"/)
    } finally {
        console.warn = warn
        delete process.env.HEAL
    }
})

test('the probe timeout is added without overwriting a positional argument', async () => {
    const calls: [string, unknown[]][] = []
    const dropZone = { toString: () => 'locator(".drop-zone")', isLocator: true }
    const page = {
        content: async () => withAvatar,
        locator: (selector: string) => ({
            toString: () => selector,
            dragTo: async (...args: unknown[]) => { calls.push(['dragTo', args]) },
            selectOption: async (...args: unknown[]) => { calls.push(['selectOption', args]) },
            fill: async (...args: unknown[]) => { calls.push(['fill', args]) },
            dispatchEvent: async (...args: unknown[]) => { calls.push(['dispatchEvent', args]) },
        }),
    }
    const healing = withHealing(page as any, newTestInfo() as any, { mode: 'report', probeTimeout: 2000 })
    const locator = healing.locator('.card')

    await locator.dragTo(dropZone)
    await locator.selectOption({ label: 'Week' })
    await locator.fill('hi', { force: true })
    await locator.dispatchEvent('click')

    assert.deepEqual(calls, [
        ['dragTo', [dropZone, { timeout: 2000 }]],
        ['selectOption', [{ label: 'Week' }, { timeout: 2000 }]],
        ['fill', ['hi', { timeout: 2000, force: true }]],
        // Fewer arguments than the signature takes: an appended object would land in `eventInit`.
        ['dispatchEvent', ['click']],
    ])
})
