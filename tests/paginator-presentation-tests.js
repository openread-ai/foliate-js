import { Paginator } from '../paginator.js'

const assert = (condition, message) => {
    if (!condition) throw new Error(message)
}
const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}
const task = () => new Promise(resolve => setTimeout(resolve, 0))
const chapter = (count = 100) => `<!doctype html><html><head><title>Owned chapter</title></head>
    <body>${Array.from({ length: count }, (_, i) => `<p id="p${i}">Passage ${i}.
    The reader keeps this exact passage through real font and layout work.
    Reading continues across columns and sections without another action.</p>`).join('')}</body></html>`
const section = (html = chapter()) => ({
    load: async () => 'about:blank',
    loadContent: async () => html,
})
const readers = new Set()
const makeReader = (sections = [section()], { preload = false, index = 0 } = {}) => {
    const host = document.createElement('div')
    Object.assign(host.style, { width: '1000px', height: '640px' })
    const reader = new Paginator()
    reader.setAttribute('max-column-count', '2')
    reader.setAttribute('max-inline-size', '420px')
    if (!preload) reader.setAttribute('no-preload', '')
    host.append(reader)
    document.body.append(host)
    reader.open({ dir: 'ltr', sections })
    readers.add(reader)
    return { reader, host, navigation: reader.goTo({ index }) }
}
const cleanup = () => {
    for (const reader of readers) {
        reader.destroy()
        reader.parentElement.remove()
    }
    readers.clear()
}
const presentation = (styles, attributes = {}) => ({ attributes, styles })
const apply = (reader, value, signal = new AbortController().signal) =>
    reader.applyPresentation(value, signal)
const holdFont = async (reader, id) => {
    const { doc } = reader.getContents().find(item => item.index === reader.primaryIndex)
    const face = new doc.defaultView.FontFace(`Owned${id}`, `url("${window.presentationFontURL(id)}")`)
    doc.fonts.add(face)
    return { doc, face, styles: `body { font: 22px/1.6 "Owned${id}"; }` }
}
const assertPending = async (promise, message) => {
    let settled = false
    promise.then(() => { settled = true }, () => { settled = true })
    await task()
    assert(!settled, message)
}
const visible = (reader, element) => {
    const frame = reader.shadowRoot.querySelector('iframe')
    const passage = element.getBoundingClientRect()
    const viewport = reader.shadowRoot.querySelector('#container').getBoundingClientRect()
    const bounds = frame.getBoundingClientRect()
    return bounds.left + passage.right > viewport.left
        && bounds.left + passage.left < viewport.right
        && bounds.top + passage.bottom > viewport.top
        && bounds.top + passage.top < viewport.bottom
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
        document.getElementById('paginator-presentation-results').textContent =
            JSON.stringify(results, null, 2)
    }
}

document.documentElement.dataset.paginatorPresentationStatus = 'running'
try {
    await run('unavailable work requires an explicit live retry', async () => {
        const held = deferred()
        const { reader, navigation, host } = makeReader([{
            load: () => held.promise,
            loadContent: async () => chapter(),
        }])
        const value = presentation('body { font-size: 24px; }')
        assert(await apply(reader, value) === 'unavailable', 'A missing document cannot be applied')
        held.resolve('about:blank')
        await navigation
        host.style.height = '0px'
        assert(await apply(reader, value) === 'unavailable', 'A zero viewport cannot be applied')
        host.style.height = '640px'
        assert(await apply(reader, value) === 'applied', 'The current live retry must apply')
    })
    await run('waits for the registered selected font and keeps the latest navigation', async () => {
        const { reader, navigation } = makeReader()
        await navigation
        const { doc, face, styles } = await holdFont(reader, 'navigation')
        const first = doc.getElementById('p20')
        const latest = doc.getElementById('p70')
        await reader.scrollToAnchor(first)
        const pending = apply(reader, presentation(styles, { 'margin-left': '60px', 'gap': '5%' }))
        await window.waitForPresentationFont('navigation')
        await assertPending(pending, 'Applied must wait for the actual registered face response')
        await reader.scrollToAnchor(latest)
        await window.releasePresentationFont('navigation')
        assert(await pending === 'applied', 'The matching font request must apply after release')
        assert(face.status === 'loaded', 'The selected registered font must really load')
        assert(doc.defaultView.getComputedStyle(latest).fontFamily.includes('Ownednavigation'),
            'The actual passage must use the requested family')
        assert(visible(reader, latest), 'Settlement must retain navigation made during the font wait')
        assert(!visible(reader, first), 'Settlement must not restore the captured earlier passage')
    })
    await run('a newer presentation supersedes held work without replaying its styles', async () => {
        const { reader, navigation } = makeReader()
        await navigation
        const { doc, styles } = await holdFont(reader, 'superseded')
        const old = apply(reader, presentation(styles))
        await window.waitForPresentationFont('superseded')
        const latest = apply(reader, presentation('body { font: 30px/1.4 serif; }'))
        assert(await old === 'superseded', 'The earlier request must settle as superseded')
        await window.releasePresentationFont('superseded')
        assert(await latest === 'applied', 'The latest request must apply')
        assert(doc.defaultView.getComputedStyle(doc.body).fontSize === '30px',
            'Late older font work must not restore older styles')
    })
    await run('awaits late selected-face preparation before registered font settlement', async () => {
        const { reader, navigation } = makeReader()
        await navigation
        const entered = deferred()
        const registration = deferred()
        const { doc } = reader.getContents()[0]
        let face
        const pending = apply(reader, {
            ...presentation('body { font: 23px/1.5 "Ownedlate"; }'),
            prepareDocument: async (actualDoc, signal) => {
                assert(actualDoc === doc && !signal.aborted, 'Preparation must own the actual live document')
                entered.resolve()
                await registration.promise
                if (signal.aborted) return
                face = new actualDoc.defaultView.FontFace('Ownedlate', `url("${window.presentationFontURL('late')}")`)
                actualDoc.fonts.add(face)
                await face.load()
            },
        })
        await entered.promise
        assert(!face, 'The selected face must actually be unregistered while app preparation is held')
        await assertPending(pending, 'A resolved earlier fonts.ready cannot bypass app face registration')
        registration.resolve()
        await window.waitForPresentationFont('late')
        await assertPending(pending, 'Registered selected-face loading must still be joined')
        await window.releasePresentationFont('late')
        assert(await pending === 'applied' && face.status === 'loaded',
            'The selected face must be registered and loaded before applied')
        assert(doc.defaultView.getComputedStyle(doc.body).fontFamily.includes('Ownedlate'),
            'The real document must use the prepared selected family')
    })
    for (const stop of ['abort', 'destroy', 'supersede']) {
        await run(`revokes document preparation on ${stop} in its completion turn`, async () => {
            const { reader, navigation } = makeReader()
            await navigation
            const entered = deferred()
            const gate = deferred()
            const controller = new AbortController()
            let preparationSignal
            const pending = apply(reader, {
                ...presentation('body { font-size: 24px; }'),
                prepareDocument: async (_, signal) => {
                    preparationSignal = signal
                    entered.resolve()
                    await gate.promise
                },
            }, controller.signal)
            await entered.promise
            gate.resolve()
            let latest
            if (stop === 'abort') controller.abort()
            else if (stop === 'destroy') reader.destroy()
            else latest = apply(reader, presentation('body { font-size: 29px; }'))
            assert(preparationSignal.aborted, 'The request-owned signal must revoke delayed app DOM work')
            assert(await pending === (stop === 'supersede' ? 'superseded' : 'cancelled'),
                'The explicit interruption outcome must survive the resumed continuation')
            if (latest) assert(await latest === 'applied', 'The replacement request must complete normally')
        })
    }
    await run('rejects a real current preparation failure without reporting applied', async () => {
        const { reader, navigation } = makeReader()
        await navigation
        const failure = new Error('Selected face registration failed')
        let caught
        try {
            await apply(reader, {
                ...presentation('body { font-family: "Missing selected face"; }'),
                prepareDocument: async () => { throw failure },
            })
        } catch (error) { caught = error }
        assert(caught === failure, 'A real preparation failure must not settle as applied or fallback success')
    })
    await run('a preparation failure revokes its held required-document sibling', async () => {
        const { reader, navigation } = makeReader([section(chapter(20)), section(chapter(20))], { index: 1 })
        await navigation
        reader.removeAttribute('no-preload')
        await apply(reader, presentation('body { font-size: 20px; }', { flow: 'scrolled' }))
        const contents = reader.getContents()
        assert(contents.length === 2, 'Both actual required section documents must be loaded')
        const first = contents[0].doc
        const sibling = contents[1].doc
        const entered = deferred()
        const held = deferred()
        const completed = deferred()
        const failure = new Error('One required document preparation failed')
        let siblingSignal
        let caught
        try {
            await apply(reader, {
                ...presentation('body { font-size: 24px; }'),
                prepareDocument: async (doc, signal) => {
                    if (doc === first) {
                        await entered.promise
                        throw failure
                    }
                    assert(doc === sibling, 'Hold the other actual required document')
                    siblingSignal = signal
                    entered.resolve()
                    await held.promise
                    if (!signal.aborted) doc.body.style.fontSize = '12px'
                    completed.resolve()
                },
            })
        } catch (error) { caught = error }
        assert(caught === failure, 'The original preparation error must reach its caller')
        const revokedBeforeRelease = siblingSignal.aborted
        assert(await apply(reader, presentation('body { font-size: 31px; }')) === 'applied',
            'A new request must apply while the failed sibling remains held')
        held.resolve()
        await completed.promise
        assert(sibling.defaultView.getComputedStyle(sibling.body).fontSize === '31px',
            'The failed request must not apply late sibling DOM work over the newer presentation')
        assert(revokedBeforeRelease, 'The failed request must revoke its sibling signal before release')
    })
    await run('owns existing animation flags and observes legacy changes without rendering them', async () => {
        const { reader, navigation } = makeReader()
        await navigation
        const flags = { animated: '', eink: '' }
        assert(await apply(reader, presentation('body { font-size: 24px; }', flags)) === 'applied',
            'The owned batch must accept both existing navigation flags')
        assert(reader.hasAttribute('animated') && reader.hasAttribute('eink'),
            'Applied must include both requested flags')
        for (const name of ['animated', 'eink']) {
            const entered = deferred()
            const held = deferred()
            let preparationSignal
            const pending = apply(reader, {
                ...presentation('body { font-size: 25px; }', flags),
                prepareDocument: async (_, signal) => {
                    preparationSignal = signal
                    entered.resolve()
                    await held.promise
                },
            })
            await entered.promise
            let reflows = 0
            const onReflow = () => { reflows++ }
            reader.addEventListener('stabilized', onReflow)
            reader.removeAttribute(name)
            reader.removeEventListener('stabilized', onReflow)
            assert(reflows === 0, 'A legacy navigation flag change must not force a geometry render')
            assert(preparationSignal.aborted, 'The legacy flag change must revoke the pending batch')
            held.resolve()
            assert(await pending === 'superseded', 'A legacy flag change must supersede old applied evidence')
            assert(!reader.hasAttribute(name), 'The older batch must not restore the legacy flag')
        }
        assert(await apply(reader, presentation('body { font-size: 26px; }', {
            animated: null, eink: null,
        })) === 'applied', 'The owned batch must support removing both existing flags')
        assert(!reader.hasAttribute('animated') && !reader.hasAttribute('eink'),
            'Applied must include requested flag removal')
    })
    for (const stop of ['abort', 'destroy']) {
        await run(`${stop} remains cancelled when held work resumes in the same turn`, async () => {
            const { reader, navigation } = makeReader()
            await navigation
            const { styles } = await holdFont(reader, stop)
            const controller = new AbortController()
            const pending = apply(reader, presentation(styles), controller.signal)
            await window.waitForPresentationFont(stop)
            if (stop === 'abort') controller.abort()
            else reader.destroy()
            await window.releasePresentationFont(stop)
            assert(await pending === 'cancelled', 'Abort/destroy must not become superseded')
            if (stop === 'destroy') {
                await task()
                assert(reader.getContents().length === 0, 'Late work must not recreate a destroyed document')
                assert(!reader.shadowRoot.querySelector('iframe'), 'Destroyed frames must stay removed')
            } else {
                assert(await apply(reader, presentation('body { font-size: 28px; }')) === 'applied',
                    'Aborting one wait must allow the same reader to receive a new request')
            }
        })
    }
    await run('joins preceding section work required by the new flow', async () => {
        const held = deferred()
        const started = deferred()
        const { reader, navigation } = makeReader([{
            load: () => { started.resolve(); return held.promise },
            loadContent: async () => chapter(20),
        }, section()], { index: 1 })
        await navigation
        reader.removeAttribute('no-preload')
        const pending = apply(reader, presentation('body { font-size: 21px; }', {
            flow: 'scrolled', 'margin-top': '18px', 'margin-bottom': '18px',
        }))
        await started.promise
        await assertPending(pending, 'The newly required preceding document must be joined')
        held.resolve('about:blank')
        assert(await pending === 'applied', 'Internal section style reuse must not supersede its request')
        assert(reader.scrolled && reader.getContents().some(item => item.index === 0),
            'The new flow must include its required preceding section')
        for (const { doc } of reader.getContents())
            assert(doc.defaultView.getComputedStyle(doc.body).fontSize === '21px',
                'A section created during the request must receive the current styles')
    })
    await run('does not wait for an unrelated future preload', async () => {
        const held = deferred()
        const started = deferred()
        const { reader, navigation } = makeReader([section(chapter(20)), {
            load: () => { started.resolve(); return held.promise },
            loadContent: async () => chapter(),
        }], { preload: true })
        await navigation
        await started.promise
        assert(await apply(reader, presentation('body { font-size: 23px; }')) === 'applied',
            'An offscreen future preload cannot block the current presentation')
        held.resolve('about:blank')
    })
    await run('new flow geometry joins a formerly future section and its app preparation', async () => {
        const held = deferred()
        const started = deferred()
        const preparation = deferred()
        const preparing = deferred()
        const { reader, navigation } = makeReader([section(chapter(2)), {
            load: () => { started.resolve(); return held.promise },
            loadContent: async () => chapter(20),
        }], { preload: true })
        await navigation
        await started.promise
        const prepared = []
        const pending = apply(reader, {
            ...presentation('body { font-size: 20px; }', {
                flow: 'scrolled', 'max-column-count': '1', 'margin-top': '10px',
                'margin-bottom': '10px', 'margin-left': '30px', 'margin-right': '30px',
            }),
            prepareDocument: async doc => {
                prepared.push(doc)
                if (doc.body.textContent.includes('Passage 19.')) {
                    preparing.resolve()
                    await preparation.promise
                }
            },
        })
        await assertPending(pending, 'New flow geometry must require the held next section')
        held.resolve('about:blank')
        await preparing.promise
        await assertPending(pending, 'A newly required document must finish actual app preparation')
        preparation.resolve()
        assert(await pending === 'applied', 'The new geometry and newly required document must settle together')
        assert(reader.getContents().length === 2 && prepared.length === 2,
            'Prepare exactly the two documents required by the new viewport')
    })
    document.documentElement.dataset.paginatorPresentationStatus = 'passed'
} catch (error) {
    document.documentElement.dataset.paginatorPresentationStatus = 'failed'
    throw error
}
