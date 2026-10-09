const multiply = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
]

export const needsPDFRecognition = (content, operators, viewport, ops) => {
    const items = content.items.filter(item => item.str?.trim())
    let transform = [1, 0, 0, 1, 0, 0]
    const stack = []
    let image = false
    let fullPageImage = false
    let hiddenText = false
    const imageOps = new Set([ops.paintImageXObject, ops.paintInlineImageXObject,
        ops.paintImageXObjectRepeat, ops.paintImageMaskXObject])
    for (let index = 0; index < operators.fnArray.length; index++) {
        const operation = operators.fnArray[index]
        const args = operators.argsArray[index]
        if (operation === ops.save) stack.push(transform)
        else if (operation === ops.restore) transform = stack.pop() ?? [1, 0, 0, 1, 0, 0]
        else if (operation === ops.transform) transform = multiply(transform, args)
        else if (operation === ops.setTextRenderingMode && (args[0] === 3 || args[0] === 7)) hiddenText = true
        else if (imageOps.has(operation)) {
            image = true
            const viewportScale = viewport.transform
                ? Math.abs(viewport.transform[0] * viewport.transform[3]
                    - viewport.transform[1] * viewport.transform[2]) : 1
            const area = Math.abs(transform[0] * transform[3] - transform[1] * transform[2]) * viewportScale
            if (area >= viewport.width * viewport.height * 0.65) fullPageImage = true
        }
    }
    if (!items.length) return image
    if (fullPageImage || hiddenText) return true
    return items.some(item => !Number.isFinite(item.width) || item.width <= 0
        || !Number.isFinite(item.height) || item.height <= 0
        || !Array.isArray(item.transform) || !item.transform.every(Number.isFinite))
}

export const prepareRecognizedPDFText = page => {
    if (page?.version !== 2 || !/^[a-f\d]{64}$/i.test(page.revision)
        || !Number.isFinite(page.width) || page.width <= 0
        || !Number.isFinite(page.height) || page.height <= 0
        || !Array.isArray(page.words)) throw new Error('Invalid recognized PDF text')
    let text = ''
    let previous
    const runs = page.words.map(word => {
        const { quad } = word
        if (typeof word.text !== 'string' || !word.text.trim()
            || !Number.isSafeInteger(word.block) || word.block < 0
            || !Number.isSafeInteger(word.line) || word.line < 0
            || !quad || !['x1', 'y1', 'x2', 'y2', 'x3', 'y3', 'x4', 'y4']
                .every(key => Number.isFinite(quad[key]) && quad[key] >= 0 && quad[key] <= 1)
            || Math.hypot(quad.x2 - quad.x1, quad.y2 - quad.y1) === 0
            || Math.hypot(quad.x4 - quad.x1, quad.y4 - quad.y1) === 0)
            throw new Error('Invalid recognized PDF word')
        const line = `${word.block}:${word.line}`
        const separator = previous === undefined ? '' : previous === line ? ' ' : '\n'
        text += separator
        const start = text.length
        text += word.text.trim()
        previous = line
        return Object.freeze({ text: word.text.trim(), start, end: text.length,
            separator, line, quad: Object.freeze({ ...quad }) })
    })
    return Object.freeze({ kind: 'recognized', revision: page.revision,
        text, runs: Object.freeze(runs) })
}
