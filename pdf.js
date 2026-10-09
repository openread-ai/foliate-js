const pdfjsPath = path => `/vendor/pdfjs/${path}`

import { checkPreviewSignal, PreviewResources, validatePreviewRequest, fitPreview, canvasPreview } from './page-preview.js'
import { setupPDFSelection } from './pdf-selection.js'
import { needsPDFRecognition, prepareRecognizedPDFText } from './pdf-text-geometry.js'
import { createRecognizedPDFTextLayer } from './pdf-text-layer-geometry.js'
import '@pdfjs/pdf.min.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.min.mjs')

const fetchText = async url => await (await fetch(url)).text()

let textLayerBuilderCSS = null
let annotationLayerBuilderCSS = null

// Track active render tasks per iframe document to cancel superseded renders
const activeRenderTasks = new WeakMap()
// Generation counter per document to detect stale renders after async gaps
const renderGenerations = new WeakMap()
const textLayers = new WeakMap()

// Set up panning and selection event handlers once per iframe document
const setupPanningEvents = (doc) => {
    if (doc._readestEventsInitialized) return
    doc._readestEventsInitialized = true

    const container = doc.querySelector('.textLayer')
    if (!container) return

    let isPanning = false
    let startX = 0
    let startY = 0
    let scrollLeft = 0
    let scrollTop = 0
    let scrollParent = null

    const findScrollableParent = (element) => {
        let current = element
        while (current) {
            if (current !== document.body && current.nodeType === 1) {
                const style = window.getComputedStyle(current)
                const overflow = style.overflow + style.overflowY + style.overflowX
                if (/(auto|scroll)/.test(overflow)) {
                    if (current.scrollHeight > current.clientHeight ||
                        current.scrollWidth > current.clientWidth) {
                        return current
                    }
                }
            }
            if (current.parentElement) {
                current = current.parentElement
            } else if (current.parentNode && current.parentNode.host) {
                current = current.parentNode.host
            } else {
                break
            }
        }
        return window
    }

    container.onpointerdown = (e) => {
        const selection = doc.getSelection()
        const hasTextSelection = selection && selection.toString().length > 0

        const elementUnderCursor = doc.elementFromPoint(e.clientX, e.clientY)
        const hasTextUnderneath = elementUnderCursor &&
                             (elementUnderCursor.tagName === 'SPAN' || elementUnderCursor.tagName === 'P') &&
                             (elementUnderCursor.textContent.trim().length > 0 ||
                              elementUnderCursor.hasAttribute('data-pdf-text-space'))

        if (!hasTextUnderneath && !hasTextSelection) {
            e.preventDefault()
            isPanning = true
            startX = e.screenX
            startY = e.screenY

            const iframe = doc.defaultView?.frameElement
            if (iframe) {
                scrollParent = findScrollableParent(iframe)
                if (scrollParent === window) {
                    scrollLeft = window.scrollX || window.pageXOffset
                    scrollTop = window.scrollY || window.pageYOffset
                } else {
                    scrollLeft = scrollParent.scrollLeft
                    scrollTop = scrollParent.scrollTop
                }
                container.style.cursor = 'grabbing'
            }
        } else {
            container.classList.add('selecting')
        }
    }

    container.onpointermove = (e) => {
        if (isPanning && scrollParent) {
            e.preventDefault()

            const dx = e.screenX - startX
            const dy = e.screenY - startY

            if (scrollParent === window) {
                window.scrollTo(scrollLeft - dx, scrollTop - dy)
            } else {
                scrollParent.scrollLeft = scrollLeft - dx
                scrollParent.scrollTop = scrollTop - dy
            }
        }
    }

    container.onpointerup = () => {
        if (isPanning) {
            isPanning = false
            scrollParent = null
            container.style.cursor = 'grab'
        } else {
            container.classList.remove('selecting')
        }
    }

    container.onpointerleave = () => {
        if (isPanning) {
            isPanning = false
            scrollParent = null
            container.style.cursor = 'grab'
        }
    }

    doc.addEventListener('selectionchange', () => {
        const selection = doc.getSelection()
        if (selection && selection.toString().length > 0) {
            container.style.cursor = 'text'
        } else if (!isPanning) {
            container.style.cursor = 'grab'
        }
    })

    container.style.cursor = 'grab'
}

const render = async (page, doc, zoom, pageColors, prepareText) => {
    if (!doc) return

    // Increment generation to invalidate any in-progress render for this doc
    const generation = (renderGenerations.get(doc) || 0) + 1
    renderGenerations.set(doc, generation)

    // Cancel any in-progress render task for this document
    const existingTask = activeRenderTasks.get(doc)
    if (existingTask) {
        existingTask.cancel()
        activeRenderTasks.delete(doc)
    }

    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--total-scale-factor', scale)
    doc.documentElement.style.setProperty('--user-unit', '1')
    doc.documentElement.style.setProperty('--scale-round-x', '1px')
    doc.documentElement.style.setProperty('--scale-round-y', '1px')
    const viewport = page.getViewport({ scale })

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    const renderTask = page.render({ canvasContext, viewport, pageColors })
    activeRenderTasks.set(doc, renderTask)

    try {
        await renderTask.promise
    } catch {
        // Render was cancelled or failed — release canvas bitmap memory
        canvas.width = 0
        canvas.height = 0
        return
    } finally {
        if (activeRenderTasks.get(doc) === renderTask) {
            activeRenderTasks.delete(doc)
        }
    }

    // Bail out if a newer render has started or iframe was removed
    if (renderGenerations.get(doc) !== generation || !doc.defaultView) {
        canvas.width = 0
        canvas.height = 0
        return
    }

    const canvasElement = doc.querySelector('#canvas')
    if (!canvasElement) {
        canvas.width = 0
        canvas.height = 0
        return
    }

    // Release old canvas bitmap memory before replacing
    const oldCanvas = canvasElement.querySelector('canvas')
    if (oldCanvas) {
        oldCanvas.width = 0
        oldCanvas.height = 0
    }
    canvasElement.replaceChildren(doc.adoptNode(canvas))

    const container = doc.querySelector('.textLayer')
    let state = textLayers.get(doc)
    if (!state) {
        const controller = new AbortController()
        state = { viewport, controller, layer: null, selection: null }
        textLayers.set(doc, state)
        doc.defaultView.addEventListener('pagehide', () => {
            controller.abort()
            state.selection?.destroy()
        }, { once: true })
        const status = doc.createElement('div')
        status.dataset.pdfTextStatus = ''
        status.setAttribute('role', 'status')
        status.setAttribute('aria-live', 'polite')
        Object.assign(status.style, { position: 'absolute', zIndex: '5',
            top: `${12 * devicePixelRatio}px`, left: `${12 * devicePixelRatio}px`,
            padding: `${6 * devicePixelRatio}px`, borderRadius: `${4 * devicePixelRatio}px`,
            background: 'Canvas', color: 'CanvasText', font: `${14 * devicePixelRatio}px sans-serif` })
        const start = async () => {
            status.remove()
            container.setAttribute('aria-busy', 'true')
            try {
                const model = await prepareText('visible', controller.signal)
                if (controller.signal.aborted || !doc.defaultView) return
                if (model.kind === 'recognized') {
                    state.layer = createRecognizedPDFTextLayer(container, model)
                } else {
                    state.layer = new pdfjsLib.TextLayer({
                        textContentSource: model.content, container, viewport: state.viewport,
                    })
                    await state.layer.render()
                }
                if (controller.signal.aborted || !doc.defaultView) return
                state.layer.update({ viewport: state.viewport })
                container.removeAttribute('aria-busy')
                const end = doc.createElement('div')
                end.className = 'endOfContent'
                container.append(end)
                state.selection = setupPDFSelection(doc)
                setupPanningEvents(doc)
                doc.dispatchEvent(new CustomEvent('pdf-text-ready'))
            } catch (error) {
                if (controller.signal.aborted || !doc.defaultView) return
                container.removeAttribute('aria-busy')
                status.textContent = 'Text could not be prepared. '
                const retry = doc.createElement('button')
                retry.type = 'button'
                retry.textContent = 'Retry'
                retry.onclick = () => void start()
                status.append(retry)
                doc.body.append(status)
            }
        }
        void start()
    } else {
        state.viewport = viewport
        state.layer?.update({ viewport })
        state.selection?.update()
    }

    // hide "offscreen" canvases appended to document when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const hiddenCanvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(hiddenCanvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    // Clear annotation layer before re-rendering to prevent DOM accumulation
    const div = doc.querySelector('.annotationLayer')
    div.replaceChildren()
    const linkService = {
        goToDestination: () => {},
        getDestinationHash: dest => JSON.stringify(dest),
        addLinkAttributes: (link, url) => link.href = url,
    }
    await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService }).render({
        annotations: await page.getAnnotations(),
    })
}

const renderPage = async (page, getImageBlob, prepareText) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(blob => {
            // Release canvas bitmap memory after extracting the blob
            canvas.width = 0
            canvas.height = 0
            resolve(blob)
        }))
    }
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.css
    if (textLayerBuilderCSS == null) {
        textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))
    }
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/annotation_layer_builder.css
    if (annotationLayerBuilderCSS == null) {
        annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))
    }
    const data = `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `
    const src = URL.createObjectURL(new Blob([data], { type: 'text/html' }))
    const onZoom = ({ doc, scale, pageColors }) => render(page, doc, scale, pageColors, prepareText)
    return { src, data, onZoom }
}

const makeTOCItem = async (item, pdf) => {
    let pageIndex = undefined

    if (item.dest) {
        try {
            const dest = typeof item.dest === 'string'
                ? await pdf.getDestination(item.dest)
                : item.dest
            if (dest?.[0]) {
                pageIndex = await pdf.getPageIndex(dest[0])
            }
        } catch (e) {
            console.warn('Failed to get page index for TOC item:', item.title, e)
        }
    }

    return {
        label: item.title,
        href: item.dest ? JSON.stringify(item.dest) : '',
        index: pageIndex,
        subitems: item.items?.length
            ? await Promise.all(item.items.map(i => makeTOCItem(i, pdf)))
            : null,
    }
}

const MAX_CACHED_PAGES = 8
const checkAbortSignal = signal => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

export const makePDF = async file => {
    const previews = new PreviewResources()
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        wasmUrl: pdfjsPath(''),
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    // Get viewport dimensions from first page for fixed-layout rendering
    const firstPage = await pdf.getPage(1)
    const firstViewport = firstPage.getViewport({ scale: 1 })
    const book = { rendition: {
        layout: 'pre-paginated',
        viewport: { width: firstViewport.width, height: firstViewport.height },
    } }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await pdf.getOutline()
    book.toc = outline ? await Promise.all(outline.map(item => makeTOCItem(item, pdf))) : null

    const cache = new Map()
    const pageCache = new Map()
    const preparedPages = new Map()
    const pinnedPages = new Map()
    const pageMetadata = new Map()
    const lifetime = new AbortController()
    let recognitionSource
    book.configureTextRecognition = source => {
        if (recognitionSource === source) return
        recognitionSource?.dispose()
        recognitionSource = source
    }
    const remember = (map, index, value) => {
        map.delete(index)
        map.set(index, value)
        while (map.size > MAX_CACHED_PAGES) map.delete(map.keys().next().value)
        return value
    }
    const publishPreparedText = (index, model, priority, signal) => {
        const pinned = pinnedPages.get(index)
        const canonical = pinned?.model ?? preparedPages.get(index) ?? model
        remember(preparedPages, index, canonical)
        if (priority === 'visible') {
            const entry = pinned ?? { model: canonical, signals: new Set() }
            pinnedPages.set(index, entry)
            if (!entry.signals.has(signal)) {
                entry.signals.add(signal)
                signal.addEventListener('abort', () => {
                    entry.signals.delete(signal)
                    if (!entry.signals.size && pinnedPages.get(index) === entry)
                        pinnedPages.delete(index)
                }, { once: true })
            }
        }
        return canonical
    }
    const preparePageText = async (index, priority, callerSignal) => {
        const controller = new AbortController()
        const signal = controller.signal
        const abort = () => controller.abort(callerSignal.reason ?? lifetime.signal.reason)
        callerSignal.addEventListener('abort', abort, { once: true })
        lifetime.signal.addEventListener('abort', abort, { once: true })
        if (callerSignal.aborted || lifetime.signal.aborted) abort()
        try {
            checkAbortSignal(signal)
            const ready = pinnedPages.get(index)?.model ?? preparedPages.get(index)
            if (ready) return publishPreparedText(index, ready, priority, callerSignal)
            let metadata = pageMetadata.get(index)
            if (!metadata) {
                metadata = (async () => {
                    const page = await getPage(index)
                    const [content, operators] = await Promise.all([
                        page.getTextContent(), page.getOperatorList(),
                    ])
                    const viewport = page.getViewport({ scale: 1 })
                    return { page, content, viewport,
                        recognize: needsPDFRecognition(content, operators, viewport, pdfjsLib.OPS) }
                })()
                remember(pageMetadata, index, metadata)
                metadata.catch(() => {
                    if (pageMetadata.get(index) === metadata) pageMetadata.delete(index)
                })
            }
            const { page, content, viewport, recognize } = await metadata
            checkAbortSignal(signal)
            if (!recognize) return publishPreparedText(index,
                Object.freeze({ kind: 'embedded', content }), priority, callerSignal)
            if (!recognitionSource) throw new Error('Text recognition is unavailable')
            // Aim for 300 dpi, bound both the longest edge and total raster memory.
            const scale = Math.min(300 / 72, 2800 / Math.max(viewport.width, viewport.height),
                Math.sqrt(6_000_000 / (viewport.width * viewport.height)))
            const recognized = await recognitionSource.get({
                pageIndex: index, priority, signal,
                key: JSON.stringify({ crop: page.view, rotation: viewport.rotation,
                    width: viewport.width, height: viewport.height, raster: '300dpi-2800-6mp-8mib-v2' }),
                rasterize: async recognitionSignal => {
                    checkAbortSignal(recognitionSignal)
                    const canvas = document.createElement('canvas')
                    const rasterViewport = page.getViewport({ scale })
                    canvas.width = Math.ceil(rasterViewport.width)
                    canvas.height = Math.ceil(rasterViewport.height)
                    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: rasterViewport })
                    const cancel = () => task.cancel()
                    recognitionSignal.addEventListener('abort', cancel, { once: true })
                    try {
                        await task.promise
                        checkAbortSignal(recognitionSignal)
                        let blob = await new Promise(resolve => canvas.toBlob(resolve))
                        for (const quality of [0.92, 0.8]) {
                            checkAbortSignal(recognitionSignal)
                            if (blob && blob.size <= 8 * 1024 * 1024) break
                            blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
                        }
                        checkAbortSignal(recognitionSignal)
                        if (!blob) throw new Error('Could not prepare the page image')
                        if (blob.size > 8 * 1024 * 1024) throw new Error('Page image exceeds the recognition size limit')
                        return blob
                    } finally {
                        recognitionSignal.removeEventListener('abort', cancel)
                        canvas.width = canvas.height = 0
                    }
                },
            })
            checkAbortSignal(signal)
            const previous = pinnedPages.get(index)?.model ?? preparedPages.get(index)
            return publishPreparedText(index, previous ?? prepareRecognizedPDFText(recognized), priority, callerSignal)
        } finally {
            callerSignal.removeEventListener('abort', abort)
            lifetime.signal.removeEventListener('abort', abort)
        }
    }
    const getPage = async (i) => {
        const cached = pageCache.get(i)
        if (cached) {
            // Move to end for LRU ordering
            pageCache.delete(i)
            pageCache.set(i, cached)
            return cached
        }
        const page = await pdf.getPage(i + 1)
        pageCache.set(i, page)

        // Evict oldest pages when over limit, freeing internal page data
        while (pageCache.size > MAX_CACHED_PAGES) {
            const oldestKey = pageCache.keys().next().value
            const oldPage = pageCache.get(oldestKey)
            pageCache.delete(oldestKey)
            oldPage?.cleanup()
        }

        return page
    }
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) {
                // Move to end for LRU ordering
                cache.delete(i)
                cache.set(i, cached)
                return cached
            }
            const url = await renderPage(await getPage(i), false, (priority, signal) => preparePageText(i, priority, signal))
            cache.set(i, url)

            // Evict oldest render results when over limit
            while (cache.size > MAX_CACHED_PAGES) {
                const oldestKey = cache.keys().next().value
                const oldEntry = cache.get(oldestKey)
                cache.delete(oldestKey)
                if (oldEntry?.src) URL.revokeObjectURL(oldEntry.src)
            }

            return url
        },
        createDocument: async ({ signal = lifetime.signal } = {}) => {
            const model = await preparePageText(i, 'search', signal)
            const page = await getPage(i)
            const doc = document.implementation.createHTMLDocument('')

            const canvas = doc.createElement('div')
            canvas.id = 'canvas'
            doc.body.appendChild(canvas)

            const textLayer = doc.createElement('div')
            textLayer.className = 'textLayer'
            doc.body.appendChild(textLayer)

            const annotationLayer = doc.createElement('div')
            annotationLayer.className = 'annotationLayer'
            doc.body.appendChild(annotationLayer)

            if (model.kind === 'recognized') createRecognizedPDFTextLayer(textLayer, model)
            else {
                const probe = doc.createElement('canvas')
                if (probe.getContext?.('2d')) {
                    const layer = new pdfjsLib.TextLayer({ textContentSource: model.content,
                        container: textLayer, viewport: page.getViewport({ scale: 1 }) })
                    await layer.render()
                } else for (const item of model.content.items) {
                    if (item.str) {
                        const span = doc.createElement('span')
                        span.textContent = item.str
                        textLayer.appendChild(span)
                    }
                }
            }
            return doc
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        if (!href) return [null, null]
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        try {
            const index = await pdf.getPageIndex(dest[0])
            return [index, null]
        } catch (e) {
            console.warn('Error getting page index for href', href, e)
            return [null, null]
        }
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.getPagePreview = async (index, options) => {
        const bounds = validatePreviewRequest(index, pdf.numPages, options)
        const scope = previews.open(options.signal)
        const canvas = document.createElement('canvas')
        let page
        let task
        const cancel = () => task?.cancel()
        scope.signal.addEventListener('abort', cancel, { once: true })
        try {
            // Preview requests must not evict or clean up pages used by the reader.
            page = await pdf.getPage(index + 1)
            checkPreviewSignal(scope.signal)
            const original = page.getViewport({ scale: 1 })
            const { width, height, scale } = fitPreview(original.width, original.height, bounds)
            canvas.width = width
            canvas.height = height
            task = page.render({
                canvasContext: canvas.getContext('2d'),
                viewport: page.getViewport({ scale }),
            })
            await task.promise
            return await canvasPreview(canvas, scope)
        } catch (error) {
            const aborted = scope.signal.aborted
            scope.release()
            if (aborted) checkPreviewSignal(scope.signal)
            throw error
        } finally {
            scope.signal.removeEventListener('abort', cancel)
            canvas.width = 0
            canvas.height = 0
            // PDF.js defers cleanup until concurrent render tasks have completed.
            if (!pageCache.has(index)) page?.cleanup()
        }
    }
    book.destroy = () => {
        lifetime.abort()
        preparedPages.clear()
        pinnedPages.clear()
        pageMetadata.clear()
        recognitionSource?.dispose()
        previews.destroy()
        // Clean up all cached canvases and revoke blob URLs
        for (const [, entry] of cache) {
            if (entry?.src) URL.revokeObjectURL(entry.src)
        }
        cache.clear()
        for (const [, page] of pageCache) {
            page?.cleanup()
        }
        pageCache.clear()
        pdf.destroy()
    }
    return book
}
