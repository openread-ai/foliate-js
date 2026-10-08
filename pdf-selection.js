const SVG_NS = 'http://www.w3.org/2000/svg'
const ACTIVE_ATTRIBUTE = 'data-pdf-selection'

/**
 * @param {Range} range
 * @returns {DOMRect[]}
 */
export const getPDFSelectionRects = range => {
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
                const selected = doc.createRange()
                selected.setStart(node, start)
                selected.setEnd(node, end)
                for (const rect of selected.getClientRects()) {
                    if (rect.width > 0 && rect.height > 0) rects.push(rect)
                }
            }
        }
        node = walker.nextNode()
    }
    return rects
}

const mergeLineRects = rects => {
    const merged = []
    for (const rect of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
        const match = merged.find(line => {
            const height = Math.min(line.bottom - line.top, rect.bottom - rect.top)
            const centerDistance = Math.abs(line.top + line.bottom - rect.top - rect.bottom) / 2
            const gap = Math.max(line.left - rect.right, rect.left - line.right, 0)
            return centerDistance <= height / 4 && gap <= height * 0.75
        })
        if (match) {
            match.left = Math.min(match.left, rect.left)
            match.right = Math.max(match.right, rect.right)
            match.top = Math.min(match.top, rect.top)
            match.bottom = Math.max(match.bottom, rect.bottom)
        } else merged.push({ ...rect })
    }
    return merged
}

export const setupPDFSelection = doc => {
    const win = doc.defaultView
    const container = doc.querySelector('.textLayer')
    const svg = doc.createElementNS(SVG_NS, 'svg')
    const path = doc.createElementNS(SVG_NS, 'path')
    const style = doc.createElement('style')
    style.textContent = `.textLayer[${ACTIVE_ATTRIBUTE}] ::selection { background: transparent; }`
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
        for (const rect of getPDFSelectionRects(range)) rects.push({
            left: (rect.left - matrix.e) / matrix.a,
            right: (rect.right - matrix.e) / matrix.a,
            top: (rect.top - matrix.f) / matrix.d,
            bottom: (rect.bottom - matrix.f) / matrix.d,
        })
        if (!rects.length) return
        path.setAttribute('fill', color || 'rgba(0, 0, 255, 0.25)')
        path.setAttribute('d', mergeLineRects(rects).map(({ left, right, top, bottom }) =>
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
