const wordGeometry = new WeakMap()

export const getPDFTextLayerLine = span => wordGeometry.get(span)?.line
export const getPDFTextLayerQuad = span => wordGeometry.get(span)?.quad

const getGapQuad = (previous, next) => {
    const ux = previous.x2 - previous.x1
    const uy = previous.y2 - previous.y1
    const vx = previous.x4 - previous.x1
    const vy = previous.y4 - previous.y1
    const determinant = ux * vy - uy * vx
    if (!determinant) return null
    const points = [1, 2, 3, 4].map(index => {
        const x = next[`x${index}`] - previous.x1
        const y = next[`y${index}`] - previous.y1
        return { u: (x * vy - y * vx) / determinant,
            v: (ux * y - uy * x) / determinant }
    })
    const min = Math.min(...points.map(point => point.u))
    const max = Math.max(...points.map(point => point.u))
    const left = min >= 1 ? 1 : max
    const right = min >= 1 ? min : 0
    if (!(right > left)) return null
    const top = Math.min(0, ...points.map(point => point.v))
    const bottom = Math.max(1, ...points.map(point => point.v))
    return Object.fromEntries([[left, top], [right, top], [right, bottom], [left, bottom]]
        .flatMap(([u, v], index) => [
            [`x${index + 1}`, previous.x1 + u * ux + v * vx],
            [`y${index + 1}`, previous.y1 + u * uy + v * vy],
        ]))
}

export const createRecognizedPDFTextLayer = (container, model) => {
    const doc = container.ownerDocument
    container.style.whiteSpace = 'pre'
    const fragment = doc.createDocumentFragment()
    const positionedSpans = []
    const appendSpan = (text, geometry) => {
        const span = doc.createElement('span')
        span.textContent = text
        Object.assign(span.style, { position: 'absolute', whiteSpace: 'pre',
            color: 'transparent', fontFamily: 'sans-serif', fontSize: '100px',
            lineHeight: '100px', transformOrigin: '0 0' })
        wordGeometry.set(span, geometry)
        positionedSpans.push(span)
        fragment.append(span)
        return span
    }
    const textDivs = model.runs.map((run, index) => {
        if (run.separator) {
            const previous = model.runs[index - 1]
            const quad = previous?.line === run.line && run.separator === ' '
                ? getGapQuad(previous.quad, run.quad) : null
            if (quad) appendSpan(run.separator, { quad, line: run.line }).dataset.pdfTextSpace = ''
            else fragment.append(doc.createTextNode(run.separator))
        }
        const span = appendSpan(run.text, run)
        span.dataset.pdfTextStart = String(run.start)
        span.dataset.pdfTextEnd = String(run.end)
        span.dataset.pdfTextQuad = JSON.stringify(run.quad)
        span.dataset.pdfTextLine = run.line
        return span
    })
    container.replaceChildren(fragment)
    container.dataset.pdfTextRevision = model.revision
    container.dataset.pdfTextGeometry = 'recognized'
    return { textDivs, update: ({ viewport }) => {
        Object.assign(container.style, { width: `${viewport.width}px`, height: `${viewport.height}px` })
        const rootScale = doc.defaultView ? doc.documentElement.getBoundingClientRect().width /
            doc.documentElement.offsetWidth : 1
        if (!(rootScale > 0)) return
        for (const span of positionedSpans) Object.assign(span.style, {
            left: '0px', top: '0px', transform: 'none',
        })
        const measured = positionedSpans.map(span => {
            const range = doc.createRange()
            range.selectNodeContents(span)
            return { span, rect: range.getBoundingClientRect(), element: span.getBoundingClientRect() }
        })
        for (const { span, rect, element } of measured) {
            if (!(rect.width > 0 && rect.height > 0)) continue
            const q = wordGeometry.get(span).quad
            const a = (q.x2 - q.x1) * viewport.width * rootScale / rect.width
            const b = (q.y2 - q.y1) * viewport.height * rootScale / rect.width
            const c = (q.x4 - q.x1) * viewport.width * rootScale / rect.height
            const d = (q.y4 - q.y1) * viewport.height * rootScale / rect.height
            const dx = (rect.left - element.left) / rootScale
            const dy = (rect.top - element.top) / rootScale
            Object.assign(span.style, {
                left: `${q.x1 * viewport.width - dx * a - dy * c}px`,
                top: `${q.y1 * viewport.height - dx * b - dy * d}px`,
                transform: `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`,
            })
        }
    } }
}
