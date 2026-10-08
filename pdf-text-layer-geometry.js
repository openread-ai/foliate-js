const originalStyles = new WeakMap()

export const resetPDFTextLayerGeometry = layer => {
    for (const span of layer.textDivs) {
        const style = originalStyles.get(span)
        if (style !== undefined) {
            span.style.cssText = style
            originalStyles.delete(span)
        }
    }
}

// Keep PDF.js text nodes and their offsets intact: CFIs and search refer to them.
export const fitPDFTextLayer = (layer, boxes, viewport) => {
    const container = layer.textDivs.find(span => span.isConnected)?.parentElement
    if (!container) return
    const doc = container.ownerDocument
    const rootScale = doc.documentElement.getBoundingClientRect().width /
        doc.documentElement.offsetWidth
    if (!(rootScale > 0)) return
    const candidates = layer.textDivs.flatMap((span, index) => {
        const box = boxes[index]
        if (!box || !span.firstChild || !span.textContent.trim()) return []
        if (!originalStyles.has(span)) originalStyles.set(span, span.style.cssText)
        const text = span.textContent
        const start = text.length - text.trimStart().length
        const end = text.trimEnd().length
        Object.assign(span.style, {
            left: '0px', top: '0px', fontSize: '100px', lineHeight: '100px',
            width: 'auto', height: 'auto', transform: 'none', transformOrigin: '0 0',
        })
        const range = doc.createRange()
        range.setStart(span.firstChild, start)
        range.setEnd(span.firstChild, end)
        return [{ span, box, range }]
    })
    // Measure together, then position together, to avoid one layout per word.
    const measured = candidates.map(({ span, box, range }) => ({
        span, box, rect: range.getBoundingClientRect(), element: span.getBoundingClientRect(),
    }))
    for (const { span, box, rect, element } of measured) {
        if (!(rect.width > 0 && rect.height > 0)) {
            span.style.cssText = originalStyles.get(span)
            originalStyles.delete(span)
            continue
        }
        const width = box.width * viewport.width
        const height = box.height * viewport.height
        const sx = width * rootScale / rect.width
        const sy = height * rootScale / rect.height
        Object.assign(span.style, {
            left: `${box.x * viewport.width - (rect.left - element.left) / rootScale * sx}px`,
            top: `${box.y * viewport.height - (rect.top - element.top) / rootScale * sy}px`,
            transform: `scale(${sx}, ${sy})`,
        })
    }
}
