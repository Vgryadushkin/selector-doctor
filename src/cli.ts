#!/usr/bin/env node --experimental-strip-types
import { readFileSync } from 'node:fs'
import { diagnose } from './diagnose.ts'

/**
 * The language-agnostic entry point: any framework that can write the failing selector and the page
 * HTML to disk can use the diagnosis, without a JavaScript runner in the loop.
 *
 *   selector-doctor --selector ".header div.profile-avatar" --html page.html
 */
const args = process.argv.slice(2)
const valueOf = (name: string) => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? undefined : args[index + 1]
}

const selector = valueOf('selector')
const htmlPath = valueOf('html')
if (!selector || !htmlPath) {
    console.error('usage: selector-doctor --selector "<selector>" --html <file.html> [--min-score 0.5]')
    process.exit(2)
}

const result = diagnose({
    selector,
    html: readFileSync(htmlPath, 'utf-8'),
    minScore: Number(valueOf('min-score') ?? 0.5),
})
console.log(JSON.stringify(result, null, 2))
process.exit(result.verdict === 'absent' ? 1 : 0)
