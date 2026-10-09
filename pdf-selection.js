import { getPDFTextLayerLine, getPDFTextLayerQuad } from './pdf-text-layer-geometry.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const ACTIVE_ATTRIBUTE = 'data-pdf-selection'

/**
 * @param {Range} range
 */
const getPDFSelectionFragments = range => {
    const doc = range.startContainer.ownerDocument
    if (!doc || range.collapsed) return []
    const root = range.commonAncestorContainer
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode()
    const rects = []
    while (node) {
        if (range.intersectsNode(node)) {
            const start = node === range.startContainer ? range.startOffset : 0
            const end = node === range.endContainer ? range.endOffset : node.textContent.length
            const text = node.textContent.slice(start, end)
            if (text.trim()) {
                const quad = getPDFTextLayerQuad(node.parentElement)
                const layer = node.parentElement?.closest('.textLayer')
                if (quad && layer && start === 0 && end === node.textContent.length) {
                    const bounds = layer.getBoundingClientRect()
                    const left = Math.min(quad.x1, quad.x2, quad.x3, quad.x4)
                    const top = Math.min(quad.y1, quad.y2, quad.y3, quad.y4)
                    const right = Math.max(quad.x1, quad.x2, quad.x3, quad.x4)
                    const bottom = Math.max(quad.y1, quad.y2, quad.y3, quad.y4)
                    rects.push({ rect: new DOMRect(bounds.left + left * bounds.width,
                        bounds.top + top * bounds.height, (right - left) * bounds.width,
                        (bottom - top) * bounds.height), quad, line: getPDFTextLayerLine(node.parentElement) })
                    node = walker.nextNode()
                    continue
                }
                const selected = doc.createRange()
                selected.setStart(node, start)
                selected.setEnd(node, end)
                for (const rect of selected.getClientRects()) {
                    if (rect.width > 0 && rect.height > 0) rects.push({
                        rect, line: getPDFTextLayerLine(node.parentElement),
                    })
                }
            }
        }
        node = walker.nextNode()
    }
    return rects
}

/**
 * @param {Range} range
 * @returns {DOMRect[]}
 */
export const getPDFSelectionRects = range =>
    getPDFSelectionFragments(range).map(({ rect }) => rect)

/** @param {Range} range */
export const getPDFSelectionQuads = range => {
    const layer = range.startContainer.ownerDocument?.querySelector('.textLayer')
    const bounds = layer?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) return []
    const normalized = value => Number(Math.min(1, Math.max(0, value)).toFixed(6))
    return getPDFSelectionFragments(range).map(({ rect, quad }) => {
        if (quad) return quad
        const x1 = normalized((rect.left - bounds.left) / bounds.width)
        const y1 = normalized((rect.top - bounds.top) / bounds.height)
        const x2 = normalized(x1 + normalized(rect.width / bounds.width))
        const y3 = normalized(y1 + normalized(rect.height / bounds.height))
        return { x1, y1, x2, y2: y1, x3: x2, y3, x4: x1, y4: y3 }
    })
}

/**
 * @param {Range} range
 * @returns {DOMRect[]}
 */
export const getPDFSelectionPaintRects = range => {
    const lines = new Map()
    const unmatched = []
    for (const { rect, line } of getPDFSelectionFragments(range)) {
        if (line === undefined) {
            unmatched.push(rect)
            continue
        }
        const previous = lines.get(line)
        lines.set(line, previous ? {
            left: Math.min(previous.left, rect.left),
            top: Math.min(previous.top, rect.top),
            right: Math.max(previous.right, rect.right),
            bottom: Math.max(previous.bottom, rect.bottom),
        } : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
    }
    return [...lines.values(), ...mergePDFLineRects(unmatched)]
        .sort((a, b) => a.top - b.top || a.left - b.left)
        .map(({ left, top, right, bottom }) => new DOMRect(left, top, right - left, bottom - top))
}

/** @param {ReadonlyArray<Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>>} rects */
export const mergePDFLineRects = rects => {
    const merged = []
    for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
        let { left, right, top, bottom } = rect
        for (let index = 0; index < merged.length;) {
            const line = merged[index]
            const height = Math.min(line.height, bottom - top)
            const centerDistance = Math.abs(line.top + line.bottom - top - bottom) / 2
            const gap = Math.max(line.left - right, left - line.right, 0)
            if (centerDistance <= height / 4 && gap <= height * 0.75) {
                left = Math.min(left, line.left)
                right = Math.max(right, line.right)
                top = Math.min(top, line.top)
                bottom = Math.max(bottom, line.bottom)
                merged.splice(index, 1)
                // The expanded line can now connect an earlier OCR fragment.
                index = 0
            } else index++
        }
        merged.push({ left, right, top, bottom, width: right - left, height: bottom - top })
    }
    return merged.sort((a, b) => a.top - b.top || a.left - b.left)
}

export const setupPDFSelection = doc => {
    const win = doc.defaultView
    const container = doc.querySelector('.textLayer')
    const svg = doc.createElementNS(SVG_NS, 'svg')
    const path = doc.createElementNS(SVG_NS, 'path')
    const style = doc.createElement('style')
    style.textContent = `.textLayer[${ACTIVE_ATTRIBUTE}]::selection, .textLayer[${ACTIVE_ATTRIBUTE}] ::selection { background: transparent; }`
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('data-pdf-selection-overlay', '')
    Object.assign(svg.style, {
        position: 'absolute', left: '0', top: '0', width: '1px', height: '1px',
        overflow: 'visible', pointerEvents: 'none', userSelect: 'none', zIndex: '1',
    })
    // One nonzero path paints the union once, including overlapping OCR lines.
    path.setAttribute('fill-rule', 'nonzero')
    svg.append(path)
    doc.head.append(style)
    doc.body.append(svg)

    let disposed = false
    let frame = null
    const forcedColors = win.matchMedia('(forced-colors: active)')

    const clear = () => {
        if (frame !== null) win.cancelAnimationFrame(frame)
        frame = null
        container.removeAttribute(ACTIVE_ATTRIBUTE)
        path.removeAttribute('d')
    }

    const update = () => {
        clear()
        if (disposed || !container.isConnected || forcedColors.matches) return
        const selection = doc.getSelection()
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
        const range = selection.getRangeAt(0)
        if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return

        // The PDF root scales by 1/devicePixelRatio. SVG's matrix also accounts
        // for scrolling and CSS zoom without guessing the screen pixel ratio.
        const matrix = svg.getScreenCTM()
        if (!matrix || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return
        const rects = []
        let color
        const root = range.commonAncestorContainer
        const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT)
        let node = root.nodeType === win.Node.TEXT_NODE ? root : walker.nextNode()
        while (node) {
            if (range.intersectsNode(node)) {
                const start = node === range.startContainer ? range.startOffset : 0
                const end = node === range.endContainer ? range.endOffset : node.length
                if (node.data.slice(start, end).trim()) {
                    const parent = node.parentElement
                    const computed = win.getComputedStyle(parent)
                    const transform = new win.DOMMatrix(computed.transform)
                    if (computed.writingMode !== 'horizontal-tb' || transform.b !== 0 || transform.c !== 0) return
                    color ??= win.getComputedStyle(parent, '::selection').backgroundColor
                }
            }
            node = walker.nextNode()
        }
        for (const rect of getPDFSelectionPaintRects(range)) rects.push({
            left: (rect.left - matrix.e) / matrix.a,
            right: (rect.right - matrix.e) / matrix.a,
            top: (rect.top - matrix.f) / matrix.d,
            bottom: (rect.bottom - matrix.f) / matrix.d,
        })
        if (!rects.length) return
        path.setAttribute('fill', color || 'rgba(0, 0, 255, 0.25)')
        path.setAttribute('d', rects.map(({ left, right, top, bottom }) =>
            `M ${left} ${top} H ${right} V ${bottom} H ${left} Z`).join(' '))
        container.setAttribute(ACTIVE_ATTRIBUTE, '')
    }

    const schedule = () => {
        if (!disposed && frame === null) frame = win.requestAnimationFrame(update)
    }
    const observer = new win.MutationObserver(schedule)
    observer.observe(container, { childList: true, subtree: true })
    doc.addEventListener('selectionchange', schedule)
    win.addEventListener('resize', schedule)
    forcedColors.addEventListener('change', schedule)
    const destroy = () => {
        if (disposed) return
        disposed = true
        clear()
        observer.disconnect()
        doc.removeEventListener('selectionchange', schedule)
        win.removeEventListener('resize', schedule)
        win.removeEventListener('pagehide', destroy)
        forcedColors.removeEventListener('change', schedule)
        svg.remove()
        style.remove()
    }
    win.addEventListener('pagehide', destroy, { once: true })
    return { update, clear, destroy }
}
