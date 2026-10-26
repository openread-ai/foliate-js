import { FixedLayout } from '../fixed-layout.js'
import { makePDF } from '../pdf.js'

const assert = (condition, message) => {
    if (!condition) throw new Error(message)
}
const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}
const task = () => new Promise(resolve => setTimeout(resolve, 0))
const waitFor = async predicate => {
    const deadline = performance.now() + 10_000
    while (!predicate()) {
        assert(performance.now() < deadline, 'The actual deferred result must become ready')
        await task()
    }
}
const assertPending = async (promise, message) => {
    let settled = false
    promise.then(() => { settled = true }, () => { settled = true })
    await task()
    assert(!settled, message)
}
const pageHTML = index => `<!doctype html><html><head>
    <meta name="viewport" content="width=600,height=800"></head>
    <body><p id="passage">Fixed passage ${index}</p></body></html>`
const section = (index, onZoom) => ({
    pageSpread: 'center',
    load: async () => ({ src: 'about:blank', data: pageHTML(index), onZoom }),
})
const readers = new Set()
const books = new Set()
const makeReader = (sections = [section(0)], { index = 0, book } = {}) => {
    const host = document.createElement('div')
    Object.assign(host.style, { width: '900px', height: '640px' })
    const reader = new FixedLayout()
    host.append(reader)
    document.body.append(host)
    host.scrollIntoView()
    const overlays = []
    reader.addEventListener('create-overlayer', event => {
        const element = document.createElement('div')
        event.detail.attach({ element, redraw: () => overlays.push(event.detail.index) })
    })
    reader.open(book ?? { sections, rendition: { spread: 'none', viewport: { width: 600, height: 800 } } })
    readers.add(reader)
    return { reader, host, overlays, navigation: reader.goTo({ index }) }
}
const cleanup = () => {
    for (const reader of readers) {
        reader.destroy()
        reader.parentElement?.remove()
    }
    readers.clear()
    for (const book of books) book.destroy()
    books.clear()
}
const apply = (reader, attributes = {}, extras = {}, signal = new AbortController().signal) =>
    reader.applyPresentation({ attributes, ...extras }, signal)

// A small valid PDF exercises the real parser, operator list, canvas raster and
// RenderTask. The source remains local and does not require a fixture download.
const pdfBytes = () => {
    const stream = 'BT /F1 20 Tf 40 180 Td (Owned PDF passage) Tj ET'
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Annot /Subtype /Link /Rect [40 150 240 200] /Border [0 0 0] /A << /S /URI /URI (https://openread.example/owned) >> >>',
    ]
    return encodePDF(objects)
}
const encodePDF = objects => {
    let source = '%PDF-1.4\n'
    const offsets = [0]
    objects.forEach((object, index) => {
        offsets.push(source.length)
        source += `${index + 1} 0 obj\n${object}\nendobj\n`
    })
    const xref = source.length
    source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return new TextEncoder().encode(source)
}
const scannedPDFBytes = () => {
    const stream = 'q 300 0 0 240 0 0 cm /Im1 Do Q'
    return encodePDF([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
        ...[0, 1, 2].map(() => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Resources << /XObject << /Im1 6 0 R >> >> /Contents 7 0 R >>'),
        '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n507090>\nendstream',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ])
}
const makePDFReader = async () => {
    const book = await makePDF(new File([pdfBytes()], 'presentation.pdf', { type: 'application/pdf' }))
    books.add(book)
    const value = makeReader(undefined, { book })
    await value.navigation
    assert(await apply(value.reader, { spread: 'none' }) === 'applied', 'The initial PDF presentation must actually settle')
    const { doc } = value.reader.getContents().find(item => item.index === 0)
    assert(doc.querySelector('#canvas canvas')?.width > 0, 'Initial actual PDF raster must exist')
    return { ...value, doc }
}
const results = []
const run = async (name, body) => {
    try {
        await body()
        results.push({ name, status: 'passed' })
    } catch (error) {
        results.push({ name, status: 'failed', error: String(error), stack: error.stack })
        throw error
    } finally {
        cleanup()
        document.getElementById('fixed-presentation-results').textContent = JSON.stringify(results, null, 2)
    }
}

document.documentElement.dataset.fixedPresentationStatus = 'running'
try {
    await run('offscreen PDF text waits for visible text and retains lookahead', async () => {
        const book = await makePDF(new File([scannedPDFBytes()], 'scanned.pdf'))
        books.add(book)
        const entered = deferred()
        const release = deferred()
        const requests = []
        book.configureTextRecognition({ dispose() {}, get: async request => {
            requests.push({ index: request.pageIndex, priority: request.priority })
            const image = await request.rasterize(request.signal)
            assert(image.size > 0, 'Scheduling proof must rasterize the actual scanned page')
            if (request.pageIndex === 0) { entered.resolve(); await release.promise }
            return { version: 2, revision: 'a'.repeat(64), width: 300, height: 240,
                words: [{ text: 'Ready', block: 0, line: 0, quad: {
                    x1: .1, y1: .1, x2: .3, y2: .1, x3: .3, y3: .2, x4: .1, y4: .2,
                } }] }
        } })
        try {
            const { reader, navigation } = makeReader(undefined, { book })
            await navigation
            await apply(reader, { spread: 'none', flow: 'scrolled', zoom: 'fit-width' })
            await entered.promise
            await waitFor(() => reader.getContents().some(item => item.index === 1
                && item.doc.querySelector('#canvas canvas')?.width > 0))
            await new Promise(resolve => setTimeout(resolve, 300))
            assert(requests.length > 0 && requests.every(item => item.index === 0
                && item.priority === 'visible'),
            'Buffered pages must not begin recognition ahead of the held visible text')
            release.resolve()
            await waitFor(() => requests.some(item => item.index === 1 && item.priority === 'prefetch'))
            const { doc } = reader.getContents().find(item => item.index === 0)
            await waitFor(() => doc.querySelector('.textLayer span')?.textContent === 'Ready')
            assert(requests.filter(item => item.index !== 0).every(item => item.priority === 'prefetch'),
                'Offscreen lookahead must retain its lower recognition priority')
        } finally {
            release.resolve()
        }
    })
    for (const format of ['PDF', 'fixed']) {
        await run(`${format} sidebar resize retains the passage within the page`, async () => {
            const value = format === 'PDF' ? await makePDFReader() : makeReader()
            const { reader, host } = value
            await value.navigation
            await apply(reader, { flow: 'scrolled', zoom: 'fit-width' })
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            await reader.pan(0, 40)
            await new Promise(resolve => setTimeout(resolve, 200))
            const page = reader.shadowRoot.querySelector('.scroll-page')
            const fraction = () => (reader.getBoundingClientRect().top
                - page.getBoundingClientRect().top) / page.getBoundingClientRect().height
            const before = fraction()
            assert(before > 0, 'Input must reach a passage inside the actual page')
            host.style.width = '1100px'
            await new Promise(resolve => setTimeout(resolve, 200))
            assert(Math.abs(fraction() - before) < .003,
                'Sidebar width changes must retain the same passage after deferred resize work')
            await apply(reader)
            await new Promise(resolve => setTimeout(resolve, 200))
            assert(Math.abs(fraction() - before) < .003,
                'Late presentation after sidebar resize must also retain the passage')
            host.style.width = '850px'
            await new Promise(resolve => setTimeout(resolve, 200))
            assert(Math.abs(fraction() - before) < .003,
                'Opening the sidebar must retain the passage when it remains scrollable')
        })
        await run(`${format} document presentation preserves the in-page scroll position`, async () => {
            const value = format === 'PDF' ? await makePDFReader() : makeReader()
            const { reader } = value
            await value.navigation
            assert(await apply(reader, { flow: 'scrolled', zoom: 'fit-width' }) === 'applied',
                'The actual scrolling page must settle before input')
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const scrolled = new Promise(resolve => reader.addEventListener('relocate', event => {
                if (event.detail.reason === 'scroll') resolve()
            }))
            await reader.pan(0, 40)
            await scrolled
            const before = reader.scrollTop
            assert(before >= 40, 'Actual input must move within the rendered page')
            assert(await apply(reader, {}, { styles: 'body { color: rgb(1, 2, 3); }' }) === 'applied',
                'Late document presentation must finish its actual work')
            await new Promise(resolve => setTimeout(resolve, 200))
            assert(Math.abs(reader.scrollTop - before) < 1,
                'Preparing the document must not jump back to the start of its page')
            const { doc } = reader.getContents().find(item => item.index === 0)
            assert(doc.defaultView.getComputedStyle(doc.body).color === 'rgb(1, 2, 3)',
                'Preserving position must still apply the requested document styles')
        })
    }
    await run('unchanged PDF presentation retains the completed canvas, text and links', async () => {
        const { reader, doc } = await makePDFReader()
        await new Promise(resolve => {
            if (doc.querySelector('.textLayer span')) resolve()
            else doc.addEventListener('pdf-text-ready', resolve, { once: true })
        })
        const canvas = doc.querySelector('#canvas canvas')
        const text = doc.querySelector('.textLayer span')
        const link = doc.querySelector('.annotationLayer a')
        assert(canvas.width > 0 && text && link, 'Actual PDF raster, text and link must exist')
        const selection = doc.getSelection()
        const range = doc.createRange()
        range.selectNodeContents(text)
        selection.addRange(range)
        const selected = selection.toString()
        assert(selected.length > 0, 'Select actual embedded PDF text before presentation')
        await apply(reader, {}, { styles: 'body { color: rgb(1, 2, 3); }' })
        await new Promise(resolve => setTimeout(resolve, 200))
        assert(doc.querySelector('#canvas canvas') === canvas && canvas.width > 0,
            'Unchanged presentation must retain the completed visible canvas')
        assert(doc.querySelector('.textLayer span') === text && selection.toString() === selected,
            'Unchanged presentation must preserve the actual text selection')
        assert(doc.querySelector('.annotationLayer a') === link,
            'Unchanged presentation must retain the interactive annotation')
        await apply(reader, { zoom: 'fit-width' })
        assert(doc.querySelector('#canvas canvas') !== canvas,
            'A real zoom change must still paint a new raster')
        const zoomed = doc.querySelector('#canvas canvas')
        reader.pageColors = { background: '#000000', foreground: '#ffffff' }
        await apply(reader)
        assert(doc.querySelector('#canvas canvas') !== zoomed,
            'A real page-color change must still paint a new raster')
    })
    await run('waits for current onZoom and overlayer before final location', async () => {
        let held
        const entered = deferred()
        const { reader, navigation, overlays } = makeReader([section(0, async () => {
            if (held) { entered.resolve(); await held.promise }
            return { status: 'rendered' }
        })])
        await navigation
        held = deferred()
        const previous = overlays.length
        const relocated = []
        reader.addEventListener('relocate', event => relocated.push(event.detail))
        const pending = apply(reader, { zoom: 'fit-width' }, { styles: 'body { color: rgb(1, 2, 3); }' })
        await entered.promise
        await assertPending(pending, 'Held current renderer work must not be certified applied')
        assert(overlays.length === previous && !relocated.length, 'No premature overlay or final location')
        held.resolve()
        assert(await pending === 'applied', 'Matching completed raster must apply')
        assert(overlays.length > previous, 'Actual current overlay must redraw before acknowledgement')
        assert(relocated.at(-1).index === 0 && relocated.at(-1).reason === 'presentation',
            'Acknowledgement must include the actual final page')
        const { doc } = reader.getContents().find(item => item.index === 0)
        assert(doc.defaultView.getComputedStyle(doc.body).color === 'rgb(1, 2, 3)', 'Styles must reach the actual frame')
    })
    await run('awaits late document preparation and preserves actual errors', async () => {
        const { reader, navigation } = makeReader()
        await navigation
        const held = deferred()
        const entered = deferred()
        const error = new Error('Selected face registration failed')
        const pending = apply(reader, {}, { prepareDocument: async (doc, signal) => {
            assert(doc.getElementById('passage') && !signal.aborted, 'Preparation owns the actual document')
            entered.resolve()
            await held.promise
            throw error
        } })
        await entered.promise
        await assertPending(pending, 'Late preparation must remain pending')
        held.resolve()
        assert(await pending.catch(actual => actual) === error, 'The original preparation error must reject')
    })
    await run('new request supersedes held work without late overlay writes', async () => {
        let held
        const entered = deferred()
        const { reader, navigation, overlays } = makeReader([section(0, async () => {
            const own = held
            if (own) { entered.resolve(); await own.promise }
            return { status: 'rendered' }
        })])
        await navigation
        await new Promise(resolve => {
            const observer = new ResizeObserver(() => {
                observer.disconnect()
                resolve()
            })
            observer.observe(reader)
        })
        held = deferred()
        const old = apply(reader, { zoom: 'fit-width' })
        await entered.promise
        const release = held
        held = null
        const latest = apply(reader, { zoom: 'fit-page' })
        assert(await old === 'superseded', 'The earlier request must be superseded')
        assert(await latest === 'applied', 'The latest actual rendering must apply')
        const count = overlays.length
        release.resolve()
        await task()
        assert(overlays.length === count, 'Late old raster must not redraw the current overlay')
    })
    await run('caller abort wins even when onZoom ignores cancellation', async () => {
        let held
        const entered = deferred()
        const { reader, navigation, overlays } = makeReader([section(0, async () => {
            if (held) { entered.resolve(); await held.promise }
        })])
        await navigation
        await new Promise(resolve => {
            const observer = new ResizeObserver(() => {
                observer.disconnect()
                resolve()
            })
            observer.observe(reader)
        })
        held = deferred()
        const controller = new AbortController()
        const pending = apply(reader, {}, {}, controller.signal)
        await entered.promise
        const count = overlays.length
        controller.abort()
        assert(await pending === 'cancelled', 'The actual caller abort must settle cancelled')
        held.resolve()
        await task()
        assert(overlays.length === count, 'Late cancelled work must not redraw')
    })
    await run('viewport changes during real current work settle the latest geometry', async () => {
        let held
        const entered = deferred()
        const { reader, navigation, host } = makeReader([section(0, async () => {
            const own = held
            if (own) { held = null; entered.resolve(); await own.promise }
        })])
        await navigation
        const release = deferred()
        held = release
        const pending = apply(reader, { zoom: 'fit-width' })
        await entered.promise
        host.style.width = '600px'
        release.resolve()
        assert(await pending === 'applied', 'Latest actual viewport work must apply')
        const { doc } = reader.getContents().find(item => item.index === 0)
        assert(doc.defaultView.frameElement.clientWidth === reader.clientWidth,
            'Acknowledgement must include the latest actual iframe geometry after a held raster')
    })
    await run('scroll transition waits for actual current frame and retains page', async () => {
        let held
        const entered = deferred()
        const { reader, navigation } = makeReader([section(0), section(1, async () => {
            if (held) { entered.resolve(); await held.promise }
        })], { index: 1 })
        await navigation
        held = deferred()
        const pending = apply(reader, { flow: 'scrolled', zoom: 'fit-width' })
        await entered.promise
        await assertPending(pending, 'The actual scroll frame raster must finish')
        held.resolve()
        assert(await pending === 'applied', 'Scroll transition must apply after its actual work')
        assert(reader.scrolled && reader.index === 1, 'Scroll transition must keep the original page')
        assert(await apply(reader, { flow: 'paginated' }) === 'applied', 'Return to paginated must await the restored spread')
        assert(!reader.scrolled && reader.index === 1, 'Restored paginated spread must retain the page')
    })
    await run('resize during a smooth page turn retains its actual destination and reopened page', async () => {
        const sections = [section(0), section(1)]
        const { reader, host, navigation } = makeReader(sections)
        await navigation
        assert(await apply(reader, { flow: 'scrolled', 'page-snap': '', zoom: 'fit-page' }) === 'applied',
            'The initial actual scrolling presentation must settle')
        await new Promise(resolve => {
            const observer = new ResizeObserver(() => {
                observer.disconnect()
                resolve()
            })
            observer.observe(reader)
        })
        const height = reader.clientHeight
        let inFlight
        const relocated = new Promise(resolve => reader.addEventListener('relocate', event => {
            if (event.detail.reason === 'scroll') resolve(event.detail)
        }))
        const resize = () => {
            if (reader.scrollTop <= 0 || reader.scrollTop >= height) return
            reader.removeEventListener('scroll', resize)
            inFlight = { top: reader.scrollTop, index: reader.index }
            host.style.height = `${height + 60}px`
        }
        reader.addEventListener('scroll', resize)
        await reader.next()
        assert(reader.index === 0, 'An admitted turn must not publish its unrendered destination')
        const location = await relocated
        assert(inFlight?.top > 0 && inFlight.top < height && inFlight.index === 0,
            'Resize must occur during actual scrolling before the destination is current')
        assert(reader.clientHeight === height + 60 && location.index === 1 && reader.index === 1,
            'The actual resized reader must settle on the single page-turn destination')
        const target = reader.shadowRoot.querySelector('.scroll-page[data-index="1"]')
        assert(Math.abs(target.getBoundingClientRect().top - reader.getBoundingClientRect().top) < 1,
            'The destination must physically occupy the leading viewport edge')
        await waitFor(() => reader.getContents().some(item =>
            item.index === 1 && item.doc.getElementById('passage')))
        reader.destroy()
        host.remove()
        const reopened = makeReader(sections, { index: location.index })
        await reopened.navigation
        assert(await apply(reopened.reader, { flow: 'scrolled', 'page-snap': '', zoom: 'fit-page' }) === 'applied',
            'Reopening the actual settled page must complete')
        assert(reopened.reader.index === 1
            && reopened.reader.getContents().some(item => item.index === 1 && item.doc.getElementById('passage')),
        'Reopen must retain the actual page reached after the resize')
    })
    await run('partial scroll idle retains the turn through late presentation and reopen', async () => {
        const sections = [section(0), section(1)]
        const { reader, host, navigation } = makeReader(sections)
        await navigation
        assert(await apply(reader, { flow: 'scrolled', 'page-snap': '', zoom: 'fit-page' }) === 'applied',
            'The actual scrolling presentation must settle before the turn')
        await new Promise(resolve => {
            const observer = new ResizeObserver(() => {
                observer.disconnect()
                resolve()
            })
            observer.observe(reader)
        })
        const height = reader.clientHeight
        const originalTimeout = globalThis.setTimeout
        const presented = deferred()
        let idle
        let partial
        let delivered = false
        globalThis.setTimeout = (callback, delay, ...args) => {
            const timer = originalTimeout(callback, delay, ...args)
            if (delay === 150 && typeof callback === 'function') idle = () => {
                clearTimeout(timer)
                callback(...args)
            }
            return timer
        }
        const present = event => {
            if (event.detail.reason === 'scroll' && !delivered) {
                delivered = true
                presented.resolve(apply(reader))
            }
        }
        const quiet = () => {
            if (!idle || partial || reader.scrollTop <= 0 || reader.scrollTop >= height) return
            partial = reader.scrollTop
            globalThis.setTimeout = originalTimeout
            idle()
        }
        reader.addEventListener('relocate', present)
        reader.addEventListener('scroll', quiet)
        try {
            await reader.next()
            assert(reader.index === 0, 'Admission must not publish an unrendered page')
            assert(await presented.promise === 'applied', 'Late actual presentation must settle')
            assert(partial > 0 && partial < height, 'The actual idle callback must see a partial native turn')
            const target = reader.shadowRoot.querySelector('.scroll-page[data-index="1"]')
            assert(reader.index === 1
                && Math.abs(target.getBoundingClientRect().top - reader.getBoundingClientRect().top) < 1,
            'Late presentation after partial idle must retain the physical page-turn destination')
            const location = reader.index
            reader.destroy()
            host.remove()
            const reopened = makeReader(sections, { index: location })
            await reopened.navigation
            assert(await apply(reopened.reader, { flow: 'scrolled', 'page-snap': '', zoom: 'fit-page' }) === 'applied'
                && reopened.reader.index === 1, 'Reopen must retain the actual settled page')
            const cancelled = reopened.reader
            await cancelled.prev()
            await cancelled.goTo({ index: 1 })
            assert(await apply(cancelled) === 'applied' && cancelled.index === 1,
                'Explicit newer navigation must revoke the earlier turn target')
        } finally {
            globalThis.setTimeout = originalTimeout
            reader.removeEventListener('relocate', present)
            reader.removeEventListener('scroll', quiet)
        }
    })
    await run('pending actual spread loading and destroy never publish a late frame', async () => {
        const held = deferred()
        const entered = deferred()
        const next = section(1)
        next.load = async () => { entered.resolve(); return held.promise }
        const { reader, navigation } = makeReader([section(0), next])
        await navigation
        const moving = reader.goTo({ index: 1 })
        await entered.promise
        const pending = apply(reader, { zoom: 'fit-width' })
        await assertPending(pending, 'An actual pending current spread cannot use the previous frame')
        reader.destroy()
        assert(await pending === 'cancelled', 'Destroy must cancel pending settlement')
        held.resolve({ src: 'about:blank', data: pageHTML(1) })
        await moving
        assert(!reader.getContents().some(item => item.index === 1), 'Destroyed late source must not publish a frame')
    })
    await run('zero viewport and missing publication are unavailable', async () => {
        const { reader, navigation, host } = makeReader()
        await navigation
        host.style.height = '0px'
        assert(await apply(reader) === 'unavailable', 'A zero viewport cannot certify applied')
        host.style.height = '640px'
        assert(await apply(reader) === 'applied', 'A live explicit retry must apply')
        const empty = new FixedLayout()
        assert(await apply(empty) === 'unavailable', 'A missing publication must remain unavailable')
        empty.destroy()
    })
    await run('removing scale factor restores default geometry and keeps the page', async () => {
        const { reader, navigation } = makeReader([section(0), section(1, async () => {})], { index: 1 })
        await navigation
        assert(await apply(reader, { zoom: 'fit-width', 'scale-factor': '200' }) === 'applied',
            'The actual doubled-scale presentation must apply')
        const { doc } = reader.getContents().find(item => item.index === 1)
        const frame = doc.defaultView.frameElement
        assert(frame.clientWidth === reader.clientWidth * 2, 'The actual requested doubled geometry must be present')
        assert(await apply(reader, { 'scale-factor': null }) === 'applied',
            'Removing the scale attribute must settle the existing default')
        assert(frame.clientWidth === reader.clientWidth && reader.index === 1,
            'Default scale must restore actual fit-width geometry on the same page')
    })
    await run('new request reconstructs the actual spread after superseded loading', async () => {
        let held
        const entered = deferred()
        const sections = [0, 1, 2].map(index => ({
            load: async () => {
                if (index === 1 && held) { entered.resolve(); await held.promise }
                return { src: 'about:blank', data: pageHTML(index) }
            },
        }))
        const { reader, navigation } = makeReader(sections, { index: 1 })
        await navigation
        held = deferred()
        const old = apply(reader, { spread: 'both' })
        await entered.promise
        const latest = apply(reader, { spread: 'both', zoom: 'fit-width' })
        assert(await old === 'superseded', 'Pending spread owner must be superseded')
        const release = held
        held = null
        release.resolve()
        assert(await latest === 'applied', 'Latest request must settle the actual requested spread')
        const current = reader.getContents().filter(item => item.doc?.defaultView
            && item.doc.defaultView.frameElement?.parentElement.style.visibility !== 'hidden')
        assert(current.some(item => item.index === 1) && current.some(item => item.index === 2),
            'Both actual current spread pages must exist; the previous one-page frame is insufficient')
    })
    await run('failed required preparation revokes its held sibling before newer work', async () => {
        const sections = [0, 1, 2].map(index => ({
            load: async () => ({ src: 'about:blank', data: pageHTML(index) }),
        }))
        const { reader, navigation } = makeReader(sections, { index: 1 })
        await navigation
        const siblingEntered = deferred()
        const releaseSibling = deferred()
        const error = new Error('Required first spread document failed')
        let siblingSignal
        const pending = apply(reader, { spread: 'both' }, { prepareDocument: async (doc, signal) => {
            const index = Number(doc.defaultView.frameElement.dataset.sectionIndex)
            if (index === 1) {
                await siblingEntered.promise
                throw error
            }
            siblingSignal = signal
            siblingEntered.resolve()
            await releaseSibling.promise
            if (!signal.aborted) doc.body.style.color = 'rgb(255, 0, 0)'
        } })
        assert(await pending.catch(actual => actual) === error, 'The original required preparation error must remain intact')
        assert(siblingSignal?.aborted, 'Failure must revoke still-running sibling preparation')
        assert(await apply(reader, {}, { styles: 'body { color: rgb(0, 128, 0); }' }) === 'applied',
            'A current normal retry must apply to both actual spread documents')
        releaseSibling.resolve()
        await task()
        for (const { doc, index } of reader.getContents()) {
            if (index === 1 || index === 2)
                assert(doc.defaultView.getComputedStyle(doc.body).color === 'rgb(0, 128, 0)',
                    'A late failed sibling must not overwrite newer visible presentation')
        }
    })
    await run('unrelated future source preload does not block current settlement', async () => {
        const held = deferred()
        const entered = deferred()
        const future = section(1)
        future.load = async () => { entered.resolve(); return held.promise }
        const { reader, navigation } = makeReader([section(0), future])
        await navigation
        await entered.promise
        assert(await apply(reader, { zoom: 'fit-width' }) === 'applied',
            'A held future preload must not block actual current presentation')
        assert(reader.index === 0 && !reader.getContents().some(item => item.index === 1),
            'Acknowledgement must cover the live page while the future source remains pending')
        reader.destroy()
        held.resolve({ src: 'about:blank', data: pageHTML(1) })
        await task()
        assert(!reader.getContents().some(item => item.index === 1), 'Destroyed future preload must not publish late')
    })

    await run('explicit retry recovers after an actual required source load fails', async () => {
        const error = new Error('Required spread source failed once')
        let failing = false
        let sourceLoads = 0
        const sections = [0, 1, 2].map(index => ({
            load: async () => {
                if (index === 1) {
                    sourceLoads++
                    if (failing) throw error
                }
                return { src: 'about:blank', data: pageHTML(index) }
            },
        }))
        const { reader, navigation } = makeReader(sections, { index: 1 })
        await navigation
        failing = true
        assert(await apply(reader, { spread: 'both' }).catch(actual => actual) === error,
            'The actual failed required source must reject with the original Error')
        const failedLoads = sourceLoads
        failing = false
        assert(await apply(reader, { spread: 'both' }).catch(actual => actual) === 'applied',
            'An explicit same-payload retry must load the recovered source and apply')
        assert(sourceLoads > failedLoads && reader.index === 1,
            'The recovered actual source must be loaded again on the same page')
        const current = reader.getContents().filter(item => item.doc?.defaultView
            && item.doc.defaultView.frameElement?.parentElement.style.visibility !== 'hidden')
        assert(current.some(item => item.index === 1) && current.some(item => item.index === 2),
            'The recovered actual spread frames must both be attached')
    })
    await run('spread changes made while scrolled survive return to paginated mode', async () => {
        const sections = [0, 1, 2].map(index => ({
            load: async () => ({ src: 'about:blank', data: pageHTML(index) }),
        }))
        const book = { sections, rendition: { spread: 'both', viewport: { width: 600, height: 800 } } }
        const { reader, navigation } = makeReader(undefined, { book, index: 1 })
        await navigation
        assert(await apply(reader, { flow: 'scrolled', spread: 'none', zoom: 'fit-width' }) === 'applied',
            'The actual scrolled presentation must settle on the same page')
        assert(reader.index === 1 && reader.scrolled, 'The scrolled transition must retain the current page')
        assert(await apply(reader, { flow: 'paginated', spread: 'none', zoom: 'fit-width' }) === 'applied',
            'Return must reconcile actual grouping to the current requested spread')
        const current = reader.getContents().filter(item => item.doc?.defaultView
            && item.doc.defaultView.frameElement?.parentElement.style.visibility !== 'hidden')
        assert(!reader.scrolled && reader.index === 1 && current.length === 1 && current[0].index === 1,
            'The actual paginated result must show only the requested single current page')
        assert(current[0].doc.defaultView.frameElement.getBoundingClientRect().width === reader.clientWidth,
            'The actual single-page fit-width geometry must match the current viewport')
    })

    // Use the actual PDFPageProxy implementation. onContinue holds the actual
    // renderer; the rejected case throws from a real canvas painting operation.
    const probe = await globalThis.pdfjsLib.getDocument({ data: pdfBytes() }).promise
    const proxy = await probe.getPage(1)
    const prototype = Object.getPrototypeOf(proxy)
    const originalRender = prototype.render
    let control
    prototype.render = function (options) {
        const own = control
        let restore
        if (own?.error) {
            const context = options.canvasContext
            const fillRect = context.fillRect
            context.fillRect = () => { throw own.error }
            restore = () => { context.fillRect = fillRect }
        }
        const actual = originalRender.call(this, options)
        if (restore) actual.promise.then(restore, restore)
        if (own) {
            own.task = actual
            const cancel = actual.cancel.bind(actual)
            actual.cancel = (...args) => { own.cancelled = true; return cancel(...args) }
            actual.onContinue = resume => {
                own.entered.resolve()
                if (own.held) own.held.promise.then(resume)
                else resume()
            }
        }
        return actual
    }
    try {
        await run('actual PDF raster stays pending until its RenderTask completes', async () => {
            const { reader, doc, overlays } = await makePDFReader()
            control = { entered: deferred(), held: deferred() }
            const previous = doc.querySelector('#canvas canvas')
            const count = overlays.length
            const pending = apply(reader, { zoom: 'fit-width' })
            await control.entered.promise
            await assertPending(pending, 'An actual held PDF RenderTask cannot be applied')
            assert(doc.querySelector('#canvas canvas') === previous && overlays.length === count,
                'Held PDF work must not replace the raster or overlay early')
            control.held.resolve()
            assert(await pending === 'applied', 'The actual completed PDF raster must apply')
            assert(doc.querySelector('#canvas canvas') !== previous
                && doc.querySelector('#canvas canvas').width > 0 && overlays.length > count,
            'The actual new raster and overlay must be present')
            control = null
        })
        await run('actual PDF RenderTask cancellation is unavailable and preserves existing raster', async () => {
            const { reader, doc } = await makePDFReader()
            control = { entered: deferred(), held: deferred() }
            const previous = doc.querySelector('#canvas canvas')
            const pending = apply(reader, { zoom: 'fit-width' })
            await control.entered.promise
            control.task.cancel()
            assert(await pending === 'unavailable', 'An independently cancelled raster must not certify applied')
            assert(control.cancelled && doc.querySelector('#canvas canvas') === previous,
                'Actual cancelled work must preserve the existing raster')
            control.held.resolve()
            control = null
        })
        await run('actual PDF painting failure rejects with the original error', async () => {
            const { reader, doc } = await makePDFReader()
            const error = new Error('Actual canvas paint failure')
            const previous = doc.querySelector('#canvas canvas')
            control = { entered: deferred(), error }
            const outcome = await apply(reader, { zoom: 'fit-width' }).catch(actual => actual)
            assert(outcome === error, 'The real task rejection must preserve the actual Error')
            assert(doc.querySelector('#canvas canvas') === previous, 'Failed raster must preserve the previous visible canvas')
            control = null
        })
        await run('caller abort cancels the actual PDF RenderTask', async () => {
            const { reader, doc } = await makePDFReader()
            const controller = new AbortController()
            control = { entered: deferred(), held: deferred() }
            const previous = doc.querySelector('#canvas canvas')
            const pending = apply(reader, { zoom: 'fit-width' }, {}, controller.signal)
            await control.entered.promise
            controller.abort()
            assert(await pending === 'cancelled', 'The recorded request abort must win')
            assert(control.cancelled, 'Abort must reach actual PDF.js cancellation')
            control.held.resolve()
            await task()
            assert(doc.querySelector('#canvas canvas') === previous, 'Late aborted PDF task must not replace the visible raster')
            control = null
        })
        await run('superseded actual annotation work cannot replace the latest interactive layer', async () => {
            const { reader, doc } = await makePDFReader()
            const prototype = globalThis.pdfjsLib.AnnotationLayer.prototype
            const original = prototype.render
            const entered = deferred()
            const held = deferred()
            let oldLayer
            let hold = true
            prototype.render = async function (params) {
                if (hold) {
                    hold = false
                    oldLayer = this.div
                    entered.resolve()
                    await held.promise
                }
                return original.call(this, params)
            }
            try {
                const old = apply(reader, { zoom: 'fit-width' })
                await entered.promise
                await assertPending(old, 'Actual held annotation work must remain pending')
                const latest = apply(reader, { zoom: 'fit-page' })
                assert(await old === 'superseded', 'The older annotation request must be superseded')
                assert(await latest === 'applied', 'The latest annotations must complete')
                const latestLayer = doc.querySelector('.annotationLayer')
                const latestLink = latestLayer.querySelector('a')
                assert(!oldLayer.isConnected && latestLink?.href === 'https://openread.example/owned',
                    'The actual latest link must be attached while stale annotation work stays detached')
                held.resolve()
                await task()
                assert(doc.querySelector('.annotationLayer') === latestLayer
                    && latestLayer.querySelector('a') === latestLink,
                'Late old annotation work must preserve the actual latest interactive link')
                assert(await apply(reader, { zoom: 'fit-width' }) === 'applied',
                    'A later normal zoom must update the actual attached annotation layer')
                const liveLayer = doc.querySelector('.annotationLayer')
                const link = liveLayer.querySelector('a')
                const bounds = link.getBoundingClientRect()
                const page = doc.documentElement.getBoundingClientRect()
                assert(liveLayer !== latestLayer && link.href === 'https://openread.example/owned'
                    && bounds.width > 0 && bounds.height > 0 && bounds.left >= page.left
                    && bounds.top >= page.top && bounds.right <= page.right + 1,
                'Normal zoom must retain the correctly placed actual annotation link')
                link.focus()
                assert(doc.activeElement === link, 'The actual attached link must remain interactive')
                let clicked = false
                link.addEventListener('click', event => { event.preventDefault(); clicked = true }, { once: true })
                link.click()
                assert(clicked, 'The actual attached annotation must still receive activation')
            } finally {
                held.resolve()
                prototype.render = original
            }
        })
    } finally {
        prototype.render = originalRender
        await probe.destroy()
    }
    document.documentElement.dataset.fixedPresentationStatus = 'passed'
} catch (error) {
    console.error(error)
    document.documentElement.dataset.fixedPresentationStatus = 'failed'
}
