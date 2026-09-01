/** Ids like `input-1731` or a uuid say nothing about identity and change on every render. */
function isStableId(id: string): boolean {
    return !!id && !/\d{3,}/.test(id) && !/^[0-9a-f]{8}-/i.test(id) && id.length < 40
}

const IDENTITY_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'placeholder']

function ownPart(element: any): string {
    const tag = element.tagName.toLowerCase()
    for (const attr of IDENTITY_ATTRS) {
        const value = element.getAttribute?.(attr)
        if (value) return `${tag}[${attr}="${value}"]`
    }
    if (isStableId(element.id)) return `#${element.id}`
    const classes = [...(element.classList ?? [])].filter((name: string) => !/\d{3,}|^v-\w+--|^css-/.test(name))
    return classes.length ? `${tag}.${classes.slice(0, 2).join('.')}` : tag
}

function ownText(element: any): string {
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

export type Suggestion = { selector: string; css: string; hasText?: string }

/**
 * Smallest suggestion that identifies the element in its own document: its own identity first,
 * widened with ancestors while ambiguous, and finally qualified by text - a list of identical rows
 * can be told apart by nothing else, and a suggestion that matches three elements is not healable.
 */
export function generateSelector(element: any, document: any): Suggestion {
    let css = ownPart(element)
    if (document.querySelectorAll(css).length === 1) return { selector: css, css }

    let current = element.parentElement
    for (let depth = 0; current && depth < 3; depth++) {
        css = `${ownPart(current)} ${css}`
        if (document.querySelectorAll(css).length === 1) return { selector: css, css }
        current = current.parentElement
    }

    const text = ownText(element)
    if (text && text.length <= 60) {
        const sameCss = [...document.querySelectorAll(css)]
        if (sameCss.filter(other => ownText(other) === text).length === 1) {
            return { selector: `${css}:has-text("${text}")`, css, hasText: text }
        }
    }
    return { selector: css, css }
}
