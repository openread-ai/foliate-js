import 'construct-style-sheets-polyfill'

const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom', 'scale-factor', 'spread', 'flow', 'page-snap']
    #root = this.attachShadow({ mode: 'open' })
    #observer = new ResizeObserver(() => {
        if (!this.#presentation && !this.#destroyed) this.#render()
    })
    #destroyed = false
    #lifetime = new AbortController()
    #presentation = null
    #batchingPresentation = false
    #spreadGeneration = 0
    #spreadReady = Promise.resolve()
    #displayedSpread = -1
    #styles
    #styleMap = new WeakMap()
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #scaleFactor = 1.0
    #totalScaleFactor = 1.0
    #scrollLocked = false
    #isOverflowX = false
    #isOverflowY = false
    #preloadCache = new Map()
    #prerenderedSpreads = new Map()
    #spreadAccessTime = new Map()
    #maxConcurrentPreloads = 1
    #numPrerenderedSpreads = 1
    #maxCachedSpreads = 2
    #overlayers = new Map()
    #pageColors = {}
    #preloadQueue = []
    #activePreloads = 0
    // Scroll mode fields
    #scrollMode = false
    #scrollPages = []
    #scrollObserver = null
    #scrollContainer = null
    #scrollLoadGen = new Map()
    #scrollMaxLoaded = 8
    #scrollIdleTimer = null
    #scrollCurrentIndex = -1
    #scrollViewport = null
    #scrollPosition = 0
    #scrollTarget = null
    #pageGestureTimer = null
    #pageWheelDelta = 0
    #pageTouch = null
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: flex-start;
            align-items: center;
            overflow: auto;
        }
        @supports (justify-content: safe center) {
          :host {
            justify-content: safe center;
          }
        }
        :host([flow="scrolled"]) {
            display: block;
            overflow-y: auto;
            overflow-x: hidden;
        }
        :host([flow="scrolled"][page-snap]) {
            scroll-snap-type: y mandatory;
        }
        :host([flow="scrolled"]) .scroll-container {
            display: flex;
            box-sizing: border-box;
            flex-direction: column;
            align-items: center;
            min-height: 100%;
            background-color: var(--scroll-bg-color);
            background-opacity: var(--scroll-bg-opacity);
        }
        :host([flow="scrolled"]) .scroll-page {
            position: relative;
            flex-shrink: 0;
            overflow: hidden;
            margin: 4px 0;
        }
        :host([flow="scrolled"][page-snap]) .scroll-page {
            align-items: center;
            display: flex;
            justify-content: center;
            margin: 0;
            scroll-snap-align: start;
            scroll-snap-stop: always;
        }
        :host([flow="scrolled"]) .scroll-container.scrolling iframe {
            pointer-events: none;
        }`)

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        if (!this.#batchingPresentation) this.#interruptPresentation('superseded')
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                if (!this.#batchingPresentation) this.#render()
                break
            case 'scale-factor':
                this.#scaleFactor = value === null ? 1.0 : parseFloat(value) / 100
                if (!this.#batchingPresentation) this.#render()
                break
            case 'spread':
                if (!this.#batchingPresentation) this.#respread(value)
                break
            case 'flow':
                if (this.#batchingPresentation) break
                if (value === 'scrolled' && !this.#scrollMode) {
                    // Capture index from paginated mode BEFORE setting scroll flag
                    const savedIndex = this.index
                    this.#scrollMode = true
                    if (this.book) this.#initScrollMode(savedIndex)
                } else if (value !== 'scrolled' && this.#scrollMode) {
                    this.#scrollMode = false
                    this.#destroyScrollMode()
                }
                break
            case 'page-snap':
                if (this.#scrollMode && !this.#batchingPresentation)
                    this.#renderScrollMode(this.#scrollCurrentIndex)
                break
        }
    }
    #interruptPresentation(outcome) {
        const request = this.#presentation
        if (!request) return
        this.#presentation = null
        request.outcome = outcome
        request.controller.abort()
        request.interrupt(outcome)
    }
    #isPresentationCurrent(request) {
        return !this.#destroyed && (!request || this.#presentation === request
            && !request.controller.signal.aborted)
    }
    #setDocumentStyles(doc) {
        if (this.#styles === undefined) return
        let styles = this.#styleMap.get(doc)
        if (!styles) {
            styles = [doc.createElement('style'), doc.createElement('style')]
            const head = doc.head ?? doc.documentElement
            head.prepend(styles[0])
            head.append(styles[1])
            this.#styleMap.set(doc, styles)
        }
        const [before, after] = Array.isArray(this.#styles)
            ? this.#styles : ['', this.#styles]
        styles[0].textContent = before
        styles[1].textContent = after
    }
    async #preparePresentationFrame(frame, request) {
        if (!this.#isPresentationCurrent(request) || !frame?.iframe?.isConnected)
            return false
        const doc = frame.iframe.contentDocument
        if (!doc || frame.blank) return false
        if (!request.prepared.has(doc)) {
            request.prepared.set(doc, (async () => {
                this.#setDocumentStyles(doc)
                await request.prepareDocument?.(doc, request.controller.signal)
                if (!this.#isPresentationCurrent(request)) return false
                doc.documentElement.getBoundingClientRect()
                await doc.fonts?.ready
                return this.#isPresentationCurrent(request)
                    && frame.iframe.contentDocument === doc && frame.iframe.isConnected
            })())
        }
        return request.prepared.get(doc)
    }
    #requiredFrames() {
        if (this.#center) return [this.#center]
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width * 1.2
        if (portrait) return [this.#side === 'left' ? this.#left : this.#right]
        return [this.#left, this.#right].filter(frame => frame && !frame.blank)
    }
    async applyPresentation(presentation, signal) {
        this.#interruptPresentation('superseded')
        if (this.#destroyed || signal.aborted) return 'cancelled'
        const { width, height } = this.getBoundingClientRect()
        const index = this.index
        if (!this.book || index < 0 || width <= 0 || height <= 0) return 'unavailable'
        let interrupt
        const interrupted = new Promise(resolve => { interrupt = resolve })
        const request = { interrupt, outcome: null, controller: new AbortController(),
            prepared: new Map(), prepareDocument: presentation.prepareDocument }
        const abort = () => {
            if (this.#presentation === request) this.#interruptPresentation('cancelled')
        }
        this.#presentation = request
        signal.addEventListener('abort', abort, { once: true })
        try {
            this.#batchingPresentation = true
            try {
                for (const [name, value] of Object.entries(presentation.attributes)) {
                    if (!FixedLayout.observedAttributes.includes(name))
                        throw new TypeError(`Unsupported fixed-layout presentation attribute: ${name}`)
                    if (value === null) this.removeAttribute(name)
                    else this.setAttribute(name, value)
                }
            } finally {
                this.#batchingPresentation = false
            }
            if (presentation.styles !== undefined) this.#styles = presentation.styles
            const work = this.#settlePresentation(request, index)
            const outcome = await Promise.race([work, interrupted])
            return request.outcome ?? outcome
        } catch (error) {
            if (request.outcome) return request.outcome
            throw error
        } finally {
            signal.removeEventListener('abort', abort)
            if (this.#presentation === request) this.#presentation = null
            request.controller.abort()
        }
    }
    async #settlePresentation(request, index) {
        const current = () => this.#isPresentationCurrent(request)
        await this.#spreadReady
        if (!current()) return 'superseded'
        const scrolled = this.getAttribute('flow') === 'scrolled'
        if (scrolled !== this.#scrollMode) {
            if (scrolled) {
                this.#scrollMode = true
                await this.#initScrollMode(index, request)
            } else {
                this.#scrollMode = false
                await this.#destroyScrollMode(request)
            }
        } else if (!scrolled && this.spread !==
            (this.getAttribute('spread') || this.book.rendition?.spread)) {
            await this.#respread(this.getAttribute('spread'), request)
        }
        if (!current()) return 'superseded'
        // An interrupted source load can leave the previous spread's frames
        // connected. Only the completed spread owns the current presentation.
        if (!scrolled && this.#displayedSpread !== this.#index) {
            const spread = this.#index
            this.#index = -1
            await this.goToSpread(spread, this.#side, 'presentation', request)
            if (!current()) return 'superseded'
        }
        if (scrolled) {
            const prepared = new Set()
            let settledBounds
            while (current()) {
                const bounds = this.getBoundingClientRect()
                if (bounds.width <= 0 || bounds.height <= 0) return 'unavailable'
                const required = this.#scrollPages.filter(page => {
                    const rect = page.el.getBoundingClientRect()
                    return page.index === this.index
                        || rect.bottom > bounds.top && rect.top < bounds.bottom
                })
                const pending = required.filter(page => !prepared.has(page))
                if (!pending.length && settledBounds?.width === bounds.width
                    && settledBounds.height === bounds.height) break
                for (const page of pending) {
                    await this.#loadScrollPage(page, request, false)
                    if (!current()) return 'superseded'
                    if (!await this.#preparePresentationFrame(page.frame, request))
                        return 'unavailable'
                    prepared.add(page)
                }
                settledBounds = this.getBoundingClientRect()
                if (settledBounds.width <= 0 || settledBounds.height <= 0) return 'unavailable'
                const outcomes = await Promise.all(this.#renderScrollMode(this.index, request))
                if (outcomes.some(value => value === false)) return 'unavailable'
            }
            if (!prepared.size) return 'unavailable'
        } else {
            while (current()) {
                const bounds = this.getBoundingClientRect()
                if (bounds.width <= 0 || bounds.height <= 0) return 'unavailable'
                const frames = this.#requiredFrames()
                if (!frames.length || (await Promise.all(frames.map(frame =>
                    this.#preparePresentationFrame(frame, request)))).some(value => !value))
                    return 'unavailable'
                if (!current()) return 'superseded'
                const preparedBounds = this.getBoundingClientRect()
                if (preparedBounds.width !== bounds.width || preparedBounds.height !== bounds.height)
                    continue
                const outcomes = await Promise.all(this.#render(this.#side, request))
                if (outcomes.some(value => value === false)) return 'unavailable'
                const renderedBounds = this.getBoundingClientRect()
                if (renderedBounds.width === bounds.width && renderedBounds.height === bounds.height) break
            }
        }
        if (!current()) return 'superseded'
        const bounds = this.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) return 'unavailable'
        if (scrolled) this.#reportScrollLocation('presentation')
        else {
            this.#reportLocation('presentation')
            this.#preloadNextSpreads()
        }
        return 'applied'
    }
    async #createFrame({ index, src: srcOption, detached = false, request }) {
        if (!this.#isPresentationCurrent(request)) return null
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const data = srcOptionIsString ? null : srcOption?.data
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        element.style.position = 'relative'
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#root.append(element)

        if (detached) {
            Object.assign(element.style, {
                position: 'absolute',
                visibility: 'hidden',
                pointerEvents: 'none',
            })
        }

        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            const signal = request?.controller.signal ?? this.#lifetime.signal
            const finish = value => {
                signal.removeEventListener('abort', cancel)
                iframe.removeEventListener('load', loaded)
                resolve(value)
            }
            const cancel = () => {
                element.remove()
                finish(null)
            }
            const loaded = () => {
                if (!this.#isPresentationCurrent(request)) return cancel()
                const doc = iframe.contentDocument
                this.#setDocumentStyles(doc)
                iframe.dataset.sectionIndex = index
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                this.#listenForPageGestures(doc)
                const { width, height } = getViewport(doc, this.defaultViewport)
                finish({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                    detached,
                })
            }
            iframe.addEventListener('load', loaded, { once: true })
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) return cancel()
            if (data) {
                iframe.srcdoc = data
            } else {
                iframe.src = src
            }
        })
    }
    #render(side = this.#side, request) {
        if (!this.#isPresentationCurrent(request)) return []
        if (this.#scrollMode) {
            return this.#renderScrollMode(undefined, request)
        }
        if (!side) return []
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        // for unfolded devices with slightly taller height than width also use landscape layout
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width * 1.2
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        let scale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || this.#center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || this.#center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1

        scale *= this.#scaleFactor
        this.#totalScaleFactor = scale

        const renderPromises = []
        const transform = ({frame, styles}) => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            const iframeScale = onZoom ? scale : 1
            const zoomedOut = this.#scaleFactor < 1.0
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                flexShrink: '0',
                display: zoomedOut ? 'flex' : 'block',
                marginBlock: zoomedOut ? undefined : 'auto',
                alignItems: zoomedOut ? 'center' : undefined,
                justifyContent: zoomedOut ? 'center' : undefined,
                ...styles,
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }

            if (!request || !frame.blank && (!portrait || frame === target))
                renderPromises.push(this.#renderFrameOverlayer(frame, scale, request))

            const container= element.parentNode?.host
            if (!container) return
            const containerWidth = container.clientWidth
            const containerHeight = container.clientHeight
            container.scrollLeft = (element.clientWidth - containerWidth) / 2

            return {
                width: element.clientWidth,
                height: element.clientHeight,
                containerWidth,
                containerHeight,
            }
        }
        if (this.#center) {
            const dimensions = transform({frame: this.#center, styles: { marginInline: 'auto' }})
            if (!dimensions) return renderPromises
            const {width, height, containerWidth, containerHeight} = dimensions
            this.#isOverflowX = width > containerWidth
            this.#isOverflowY = height > containerHeight
        } else {
            const leftDimensions = transform({frame: left, styles: { marginInlineStart: 'auto' }})
            const rightDimensions = transform({frame: right, styles: { marginInlineEnd: 'auto' }})
            if (!leftDimensions || !rightDimensions) return renderPromises
            const {width: leftWidth, height: leftHeight, containerWidth, containerHeight} = leftDimensions
            const {width: rightWidth, height: rightHeight} = rightDimensions
            this.#isOverflowX = leftWidth + rightWidth > containerWidth
            this.#isOverflowY = Math.max(leftHeight, rightHeight) > containerHeight
        }
        return renderPromises
    }
    async #renderFrameOverlayer(frame, scale, request) {
        if (!this.#isPresentationCurrent(request)) return false
        const generation = (frame.renderGeneration ?? 0) + 1
        frame.renderGeneration = generation
        const doc = frame.iframe.contentDocument
        const index = frame.iframe.dataset.sectionIndex != null
            ? parseInt(frame.iframe.dataset.sectionIndex) : undefined
        if (frame.onZoom) {
            try {
                const outcome = await frame.onZoom({ doc, scale, pageColors: this.#pageColors,
                    signal: request?.controller.signal ?? this.#lifetime.signal })
                if (!this.#isPresentationCurrent(request)) return false
                if (outcome?.status === 'failed') throw outcome.error
                if (outcome?.status === 'cancelled') return false
            } catch (error) {
                console.warn('Failed to render fixed-layout page', index, error)
                if (request && this.#isPresentationCurrent(request)) throw error
                return false
            }
        }
        if (!this.#isPresentationCurrent(request)
            || frame.renderGeneration !== generation || !frame.iframe.isConnected) return false
        if (index == null || !doc) return false
        let overlayer = this.#overlayers.get(index)
        if (!overlayer || overlayer.element.parentElement !== frame.element) {
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc, index,
                    attach: created => {
                        overlayer = created
                        this.#overlayers.set(index, created)
                        frame.element.append(created.element)
                    },
                },
            }))
        }
        if (overlayer) {
            Object.assign(overlayer.element.style, {
                position: 'absolute',
                top: `${frame.iframe.offsetTop}px`,
                left: `${frame.iframe.offsetLeft}px`,
                width: `${frame.iframe.clientWidth}px`,
                height: `${frame.iframe.clientHeight}px`,
                transform: frame.iframe.style.transform,
                transformOrigin: frame.iframe.style.transformOrigin,
            })
            overlayer.redraw()
        }
        return true
    }
    async #showSpread({ left, right, center, side, spreadIndex, request, generation }) {
        const current = () => this.#isPresentationCurrent(request)
            && this.#spreadGeneration === generation
        if (!current()) return false
        this.#left = null
        this.#right = null
        this.#center = null

        const cacheKey = spreadIndex !== undefined ? `spread-${spreadIndex}` : null
        const prerendered = cacheKey ? this.#prerenderedSpreads.get(cacheKey) : null

        if (prerendered) {
            this.#spreadAccessTime.set(cacheKey, Date.now())
            if (prerendered.center) {
                this.#center = prerendered.center
            } else {
                this.#left = prerendered.left
                this.#right = prerendered.right
            }
        } else {
            if (center) {
                const frame = await this.#createFrame({ ...center, request })
                if (!current()) { frame?.element?.remove(); return false }
                if (!frame) return false
                this.#center = frame
                if (cacheKey) {
                    this.#prerenderedSpreads.set(cacheKey, { center: this.#center })
                    this.#spreadAccessTime.set(cacheKey, Date.now())
                }
            } else {
                const leftFrame = await this.#createFrame({ ...left, request })
                if (!current()) { leftFrame?.element?.remove(); return false }
                const rightFrame = await this.#createFrame({ ...right, request })
                if (!current()) {
                    leftFrame?.element?.remove()
                    rightFrame?.element?.remove()
                    return false
                }
                if (!leftFrame || !rightFrame) return false
                this.#left = leftFrame
                this.#right = rightFrame
                if (cacheKey) {
                    this.#prerenderedSpreads.set(cacheKey, { left: this.#left, right: this.#right })
                    this.#spreadAccessTime.set(cacheKey, Date.now())
                }
            }
        }

        this.#side = center ? 'center' : this.#left?.blank ? 'right'
            : this.#right?.blank ? 'left' : side
        const visibleFrames = center
            ? [this.#center?.element]
            : [this.#left?.element, this.#right?.element]

        Array.from(this.#root.children).forEach(child => {
            const isVisible = visibleFrames.includes(child)
            Object.assign(child.style, {
                position: isVisible ? 'relative' : 'absolute',
                visibility: isVisible ? 'visible' : 'hidden',
                pointerEvents: isVisible ? 'auto' : 'none',
            })
        })

        // Render layout and await any async onZoom callbacks (e.g. PDF text
        // layer rendering) so the document is fully populated before overlayers
        // try to resolve CFIs against it.
        if (!request) {
            const renderPromises = this.#render()
            if (renderPromises.length) await Promise.all(renderPromises)
        }
        if (!current()) return false
        this.#displayedSpread = spreadIndex
        return true
    }
    async #initScrollMode(targetIndex = 0, request) {
        const currentIndex = targetIndex

        // Hide all paginated content
        for (const child of Array.from(this.#root.children)) {
            child.style.display = 'none'
        }

        this.#scrollContainer = document.createElement('div')
        this.#scrollContainer.className = 'scroll-container'
        this.#root.append(this.#scrollContainer)

        const sections = this.book.sections
        const viewport = this.defaultViewport
        const vw = viewport?.width ?? 1000
        const vh = viewport?.height ?? 1400
        this.#scrollPages = sections.map((section, i) => {
            const el = document.createElement('div')
            el.className = 'scroll-page'
            el.dataset.index = i
            this.#scrollContainer.append(el)
            return { el, index: i, section, state: 'idle', frame: null, vpWidth: vw, vpHeight: vh }
        })

        if (request) {
            const page = this.#scrollPages[currentIndex]
            if (page) await this.#loadScrollPage(page, request, false)
            if (!this.#isPresentationCurrent(request)) return
            this.#renderScrollMode(currentIndex, request)
        } else this.#renderScrollMode()

        // Scroll to target position BEFORE setting up the observer
        // so only pages near the target are observed as intersecting
        if (currentIndex >= 0 && currentIndex < this.#scrollPages.length) {
            this.#scrollPages[currentIndex].el.scrollIntoView()
            this.#scrollCurrentIndex = currentIndex
        }

        this.addEventListener('scroll', this.#handleScrollEvent)

        // Set up IntersectionObserver after scroll position is established.
        // rootMargin '50%' loads ~1 page buffer above/below the viewport.
        this.#scrollObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue
                const index = parseInt(entry.target.dataset.index)
                const pageData = this.#scrollPages[index]
                if (pageData && pageData.state === 'idle') {
                    this.#loadScrollPage(pageData)
                }
            }
            this.#evictScrollPages()
        }, { root: this, rootMargin: '50% 0px' })

        for (const page of this.#scrollPages) {
            this.#scrollObserver.observe(page.el)
        }
        this.#reportScrollLocation('navigation')
    }
    #handleScrollEvent = () => {
        // A larger viewport can clamp scrollTop before ResizeObserver runs.
        // Keep the last position measured under the old geometry in that case.
        if (this.#scrollViewport?.width === this.clientWidth
            && this.#scrollViewport?.height === this.clientHeight)
            this.#scrollPosition = this.scrollTop
        // Disable iframe interaction during scroll for native smooth scrolling
        this.#setScrollIframeInteraction(false)
        if (this.#scrollIdleTimer) clearTimeout(this.#scrollIdleTimer)
        this.#scrollIdleTimer = setTimeout(() => {
            this.#setScrollIframeInteraction(true)
            if (this.#scrollViewport?.width === this.clientWidth
                && this.#scrollViewport?.height === this.clientHeight) {
                const target = this.#scrollTarget
                if (target) {
                    // A quiet event gap can precede the native scroll's destination.
                    const page = target.page.el.getBoundingClientRect()
                    this.scrollTo({ top: this.scrollTop + page.top
                        - this.getBoundingClientRect().top - this.clientTop
                        + target.offset * page.height, behavior: 'instant' })
                }
                this.#scrollTarget = null
            }
            // Report location only after scroll settles to avoid
            // expensive React re-renders on every frame
            this.#reportScrollLocation()
        }, 150)
    }
    #setScrollIframeInteraction(enabled) {
        this.#scrollContainer?.classList.toggle('scrolling', !enabled)
    }
    async #destroyScrollMode(request) {
        // Use the cached scroll index because by the time attributeChangedCallback
        // fires, the CSS has already switched from block/scroll to flex layout,
        // making #getScrollIndex() return incorrect positions
        const currentIndex = this.#scrollCurrentIndex >= 0
            ? this.#scrollCurrentIndex : this.#getScrollIndex()
        this.removeEventListener('scroll', this.#handleScrollEvent)
        if (this.#scrollObserver) {
            this.#scrollObserver.disconnect()
            this.#scrollObserver = null
        }
        if (this.#scrollIdleTimer) {
            clearTimeout(this.#scrollIdleTimer)
            this.#scrollIdleTimer = null
        }
        // Clean up all scroll page frames and overlayers
        for (const page of this.#scrollPages) {
            this.#teardownScrollPage(page)
        }
        this.#scrollPages = []
        this.#scrollLoadGen.clear()
        this.#scrollCurrentIndex = -1
        this.#scrollViewport = null
        this.#scrollPosition = 0
        this.#scrollTarget = null
        if (this.#scrollContainer) {
            this.#scrollContainer.remove()
            this.#scrollContainer = null
        }

        // Reset scroll position left over from scroll mode
        this.scrollTop = 0
        this.scrollLeft = 0

        // Restore paginated content
        for (const child of Array.from(this.#root.children)) {
            child.style.display = ''
        }

        // Navigate to the page we were on
        if (currentIndex >= 0) {
            if (this.spread !== (this.getAttribute('spread') || this.book.rendition?.spread)) {
                await this.#respread(this.getAttribute('spread'), request, currentIndex)
                return
            }
            const section = this.book.sections[currentIndex]
            if (section) {
                const spread = this.getSpreadOf(section)
                if (spread) {
                    this.#index = -1
                    await this.goToSpread(spread.index, spread.side, 'page', request)
                }
            }
        }
    }
    // Create an iframe directly inside the page placeholder (no reparenting)
    async #createScrollFrame(pageData, srcOption, request) {
        if (!this.#isPresentationCurrent(request)) return null
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const data = srcOptionIsString ? null : srcOption?.data
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom

        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        element.style.position = 'relative'
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        // Place directly in the placeholder — no root append + reparent
        pageData.el.append(element)

        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            const signal = request?.controller.signal ?? this.#lifetime.signal
            const finish = value => {
                signal.removeEventListener('abort', cancel)
                iframe.removeEventListener('load', loaded)
                resolve(value)
            }
            const cancel = () => {
                element.remove()
                finish(null)
            }
            const loaded = () => {
                if (!this.#isPresentationCurrent(request)) return cancel()
                const doc = iframe.contentDocument
                this.#setDocumentStyles(doc)
                iframe.dataset.sectionIndex = pageData.index
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index: pageData.index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                finish({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                })
            }
            iframe.addEventListener('load', loaded, { once: true })
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) return cancel()
            if (data) {
                iframe.srcdoc = data
            } else {
                iframe.src = src
            }
        })
    }
    async #loadScrollPage(pageData, request, render = true) {
        if (pageData.state === 'loading') {
            await pageData.loading
            // A previous request may have cancelled the load we joined.
            if (pageData.state === 'idle' && this.#isPresentationCurrent(request))
                return this.#loadScrollPage(pageData, request, render)
            return
        }
        if (pageData.state !== 'idle' || !this.#isPresentationCurrent(request)) return
        pageData.state = 'loading'

        // Generation counter to detect stale loads
        const gen = (this.#scrollLoadGen.get(pageData.index) || 0) + 1
        this.#scrollLoadGen.set(pageData.index, gen)

        const current = () => this.#isPresentationCurrent(request)
            && this.#scrollLoadGen.get(pageData.index) === gen && this.#scrollMode
        const loading = (async () => {
            try {
                const src = await pageData.section.load?.()
                // Bail if cancelled or mode changed
                if (!current()) {
                    pageData.state = 'idle'
                    return
                }
                if (!src) { pageData.state = 'idle'; return }

                const frame = await this.#createScrollFrame(pageData, src, request)
                // Bail if cancelled during frame creation
                if (!current() || !frame) {
                    frame?.element?.remove()
                    pageData.state = 'idle'
                    return
                }

                pageData.frame = frame
                pageData.state = 'loaded'
                // Update dimensions from actual page viewport
                if (frame.width && frame.height) {
                    pageData.vpWidth = frame.width
                    pageData.vpHeight = frame.height
                }
                if (render) await this.#renderScrollPage(pageData, request)
                if (!current()) return
                const doc = frame.iframe.contentDocument
                if (doc) this.#listenForPageGestures(doc)
            } catch (e) {
                console.warn('Failed to load scroll page', pageData.index, e)
                pageData.state = 'idle'
                if (request && current()) throw e
            }
        })()
        pageData.loading = loading
        try {
            await loading
        } finally {
            if (pageData.loading === loading) pageData.loading = null
        }
    }
    // Remove a loaded scroll page's frame and overlayer
    #teardownScrollPage(pageData) {
        // Bump generation to cancel any in-progress load
        const gen = (this.#scrollLoadGen.get(pageData.index) || 0) + 1
        this.#scrollLoadGen.set(pageData.index, gen)

        if (pageData.frame) {
            const idx = pageData.index
            this.#overlayers.delete(idx)
            pageData.frame.element?.remove()
        }
        pageData.frame = null
        pageData.state = 'idle'
    }
    // Evict the farthest loaded pages when over limit
    #evictScrollPages() {
        const loaded = this.#scrollPages.filter(p => p.state === 'loaded')
        if (loaded.length <= this.#scrollMaxLoaded) return
        const currentIndex = this.#getScrollIndex()
        loaded.sort((a, b) =>
            Math.abs(a.index - currentIndex) - Math.abs(b.index - currentIndex))
        for (const page of loaded.slice(this.#scrollMaxLoaded)) {
            this.#teardownScrollPage(page)
        }
    }
    #renderScrollMode(targetIndex, request) {
        if (!this.#isPresentationCurrent(request)) return []
        const { width: hostWidth, height: hostHeight } = this.getBoundingClientRect()
        if (!hostWidth) return []
        const rendering = []
        // Remember current page so we can restore scroll position after resize
        const resized = this.#scrollViewport
            && (this.#scrollViewport.width !== this.clientWidth
                || this.#scrollViewport.height !== this.clientHeight)
        let target = this.#scrollTarget
        if (!target && this.#scrollViewport && (request || resized)) {
            const position = resized ? this.#scrollPosition : this.scrollTop
            const page = this.#scrollPages[this.#getScrollIndex(position)]
            const bounds = page?.el.getBoundingClientRect()
            if (bounds?.height) target = { page, offset:
                (position - this.scrollTop + this.getBoundingClientRect().top
                    + this.clientTop - bounds.top) / bounds.height }
        }
        const currentIndex = target ? target.page.index : targetIndex >= 0 ? targetIndex
            : this.#getScrollIndex(resized ? this.#scrollPosition : this.scrollTop)
        for (const page of this.#scrollPages) {
            const widthScale = hostWidth / page.vpWidth
            const scale = (this.hasAttribute('page-snap') && this.#zoom !== 'fit-width'
                ? Math.min(widthScale, hostHeight / page.vpHeight)
                : widthScale) * this.#scaleFactor
            page.el.style.width = `${page.vpWidth * scale}px`
            page.el.style.height = `${page.vpHeight * scale}px`
            page.el.style.minHeight = this.hasAttribute('page-snap')
                ? `${this.clientHeight}px` : ''
            if (page.state === 'loaded' && page.frame) {
                if (!request || request.prepared.has(page.frame.iframe.contentDocument))
                    rendering.push(this.#renderScrollPage(page, request))
            }
        }
        this.#updateScrollEndPadding()
        // Restore scroll position to keep current page in view after resize
        if (currentIndex >= 0 && currentIndex < this.#scrollPages.length) {
            if (target) {
                const page = target.page.el.getBoundingClientRect()
                this.scrollTo({ top: this.scrollTop + page.top
                    - this.getBoundingClientRect().top - this.clientTop
                    + target.offset * page.height, behavior: 'instant' })
            } else this.#scrollPages[currentIndex].el.scrollIntoView()
            this.#scrollCurrentIndex = this.#getScrollIndex()
        }
        this.#scrollViewport = { width: this.clientWidth, height: this.clientHeight }
        this.#scrollPosition = this.scrollTop
        this.#syncPageSnapType()
        return rendering
    }
    #scrollBy(distance) {
        const top = Math.max(0, Math.min(this.scrollTop + distance,
            this.scrollHeight - this.clientHeight))
        const page = this.#scrollPages[this.#getScrollIndex(top)]
        if (page) {
            const bounds = page.el.getBoundingClientRect()
            const pageTop = this.scrollTop + bounds.top
                - this.getBoundingClientRect().top - this.clientTop
            this.#scrollTarget = { page, offset: (top - pageTop) / bounds.height }
        }
        this.scrollBy({ top: distance, behavior: 'smooth' })
    }
    #renderScrollPage(pageData, request) {
        if (!this.#isPresentationCurrent(request)) return false
        const { width: hostWidth, height: hostHeight } = this.getBoundingClientRect()
        if (!hostWidth || !pageData.frame) return false
        const { vpWidth: vw, vpHeight: vh, frame } = pageData
        const widthScale = hostWidth / vw
        const scale = (this.hasAttribute('page-snap') && this.#zoom !== 'fit-width'
            ? Math.min(widthScale, hostHeight / vh)
            : widthScale) * this.#scaleFactor

        if (frame.onZoom) {
            Object.assign(frame.iframe.style, {
                width: `${vw * scale}px`,
                height: `${vh * scale}px`,
                transform: 'none',
                display: 'block',
            })
        } else {
            Object.assign(frame.iframe.style, {
                width: `${vw}px`,
                height: `${vh}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                display: 'block',
            })
        }
        Object.assign(frame.element.style, {
            width: `${vw * scale}px`,
            height: `${vh * scale}px`,
        })
        // Update placeholder to match actual page dimensions
        pageData.el.style.width = `${vw * scale}px`
        pageData.el.style.height = `${vh * scale}px`
        pageData.el.style.minHeight = this.hasAttribute('page-snap')
            ? `${this.clientHeight}px` : ''
        if (pageData === this.#scrollPages.at(-1)) this.#updateScrollEndPadding()

        this.#syncPageSnapType()
        return this.#renderFrameOverlayer(frame, scale, request)
    }
    #updateScrollEndPadding() {
        const last = this.#scrollPages.at(-1)?.el
        if (!last || !this.#scrollContainer) return
        // Every page, including a short final page, must be able to reach the
        // same leading edge used by navigation and persisted page-level CFIs.
        const margin = parseFloat(getComputedStyle(last).marginBottom) || 0
        this.#scrollContainer.style.paddingBottom = `${Math.max(0,
            this.clientHeight - last.getBoundingClientRect().height - margin)}px`
    }
    #getScrollIndex(position = this.scrollTop) {
        if (!this.#scrollPages.length) return -1
        // goTo() restores a page at the leading viewport edge. Saving the
        // center page instead advances short landscape pages on every reopen
        // in a tall viewport. Use the same leading edge for both operations.
        const top = this.getBoundingClientRect().top + this.clientTop
            + position - this.scrollTop
        for (const page of this.#scrollPages) {
            const rect = page.el.getBoundingClientRect()
            // Ignore a trailing sub-pixel sliver of the preceding page; in a
            // page gap, the next page is the first visible reading content.
            if (rect.bottom > top + 1) return page.index
        }
        return position > 0 ? this.#scrollPages.length - 1 : 0
    }
    #reportScrollLocation(reason = 'scroll') {
        if (reason === 'scroll' && this.#scrollViewport
            && (this.#scrollViewport.width !== this.clientWidth
                || this.#scrollViewport.height !== this.clientHeight)) return
        const index = this.#getScrollIndex()
        if (index < 0) return
        this.#scrollCurrentIndex = index
        this.#scrollPosition = this.scrollTop
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index, fraction: 0, size: 1 } }))
    }
    #listenForPageGestures(doc) {
        doc.addEventListener('wheel', e => this.handleWheel(e.deltaX, e.deltaY),
            { passive: true })
        doc.addEventListener('touchstart', this.#onPageTouchStart, { passive: true })
        doc.addEventListener('touchmove', this.#onPageTouchMove, { passive: false })
        doc.addEventListener('touchend', this.#onPageTouchEnd)
        doc.addEventListener('touchcancel', this.#onPageTouchCancel)
    }
    #currentPageFitsViewport() {
        const index = this.#getScrollIndex()
        const page = this.#scrollPages.find(page => page.index === index)
        return !!page && page.el.offsetHeight <= this.clientHeight + 1
    }
    #syncPageSnapType() {
        if (this.hasAttribute('page-snap') && !this.#currentPageFitsViewport())
            this.style.scrollSnapType = 'none'
        else this.style.removeProperty('scroll-snap-type')
    }
    #beginPageGesture() {
        this.#scrollTarget = null
        if (!this.hasAttribute('page-snap')) return
        this.style.scrollSnapType = 'none'
    }
    #finishPageGesture = () => {
        if (this.#pageGestureTimer) clearTimeout(this.#pageGestureTimer)
        this.#pageGestureTimer = null
        if (!this.hasAttribute('page-snap') || !this.#scrollPages.length
            || !this.#currentPageFitsViewport()) {
            this.#syncPageSnapType()
            return
        }
        this.style.removeProperty('scroll-snap-type')
        const nearest = this.#scrollPages.reduce((best, page) =>
            Math.abs(page.el.offsetTop - this.scrollTop)
                < Math.abs(best.el.offsetTop - this.scrollTop) ? page : best)
        this.scrollTo({ top: nearest.el.offsetTop, behavior: 'smooth' })
    }
    handleWheel(_deltaX, deltaY) {
        if (!this.#scrollMode) {
            if (!deltaY) return
            this.#pageWheelDelta += deltaY
            if (this.#pageGestureTimer) clearTimeout(this.#pageGestureTimer)
            this.#pageGestureTimer = setTimeout(() => {
                const delta = this.#pageWheelDelta
                this.#pageWheelDelta = 0
                this.#pageGestureTimer = null
                if (delta > 0) this.next()
                else if (delta < 0) this.prev()
            }, 120)
            return
        }
        this.#beginPageGesture()
        this.scrollBy({ top: deltaY, behavior: 'instant' })
        if (this.#pageGestureTimer) clearTimeout(this.#pageGestureTimer)
        if (this.hasAttribute('page-snap'))
            this.#pageGestureTimer = setTimeout(this.#finishPageGesture, 120)
    }
    #onPageTouchStart = e => {
        if (e.touches.length !== 1) return
        const { screenX, screenY } = e.touches[0]
        this.#pageTouch = {
            startX: screenX,
            startY: screenY,
            x: screenX,
            y: screenY,
            startedAt: performance.now(),
        }
        if (this.#scrollMode) this.#beginPageGesture()
    }
    #onPageTouchMove = e => {
        if (!this.#pageTouch || e.touches.length !== 1) return
        const selection = e.currentTarget?.getSelection?.()
        if (selection && !selection.isCollapsed) return
        const { screenX, screenY } = e.touches[0]
        if (this.#scrollMode) {
            e.preventDefault()
            this.scrollBy({ top: this.#pageTouch.y - screenY, behavior: 'instant' })
        }
        this.#pageTouch.x = screenX
        this.#pageTouch.y = screenY
    }
    #onPageTouchEnd = e => {
        if (!this.#pageTouch) return
        const touch = e.changedTouches?.[0]
        if (touch) {
            this.#pageTouch.x = touch.screenX
            this.#pageTouch.y = touch.screenY
        }
        const gesture = this.#pageTouch
        this.#pageTouch = null
        if (this.#scrollMode) {
            this.#finishPageGesture()
            return
        }
        const selection = e.currentTarget?.getSelection?.()
        if (selection && !selection.isCollapsed) return
        const dx = gesture.x - gesture.startX
        const dy = gesture.y - gesture.startY
        const dt = Math.max(1, performance.now() - gesture.startedAt)
        if (Math.abs(dx) <= Math.abs(dy) || Math.abs(dx) <= 30 || Math.abs(dx / dt) <= .2)
            return
        if (dx > 0) this.rtl ? this.next() : this.prev()
        else this.rtl ? this.prev() : this.next()
    }
    #onPageTouchCancel = () => {
        this.#pageTouch = null
        if (this.#scrollMode) this.#finishPageGesture()
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.book = book
        this.defaultViewport = book.rendition?.viewport
        this.rtl = book.dir === 'rtl'

        this.#spread()
        if (this.#scrollMode) this.#initScrollMode()
    }
    #spread(mode) {
        const book = this.book
        const { rendition } = book
        const rtl = this.rtl
        const ltr = !rtl
        this.spread = mode || rendition?.spread

        if (this.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    #respread(spreadMode, request, sectionIndex) {
        if (this.#index === -1 && sectionIndex === undefined) return
        const section = this.book.sections[sectionIndex ?? this.index]
        this.#spread(spreadMode)
        const { index, side } = this.getSpreadOf(section)
        this.#index = -1
        this.#displayedSpread = -1
        this.#preloadCache.clear()
        for (const frames of this.#prerenderedSpreads.values()) {
            if (frames.center) {
                frames.center.element?.remove()
            } else {
                frames.left?.element?.remove()
                frames.right?.element?.remove()
            }
        }
        this.#prerenderedSpreads.clear()
        this.#spreadAccessTime.clear()
        this.#overlayers.clear()
        return this.goToSpread(index, side, 'page', request)
    }
    get index() {
        if (this.#scrollMode) return this.#scrollCurrentIndex >= 0
            ? this.#scrollCurrentIndex : this.#getScrollIndex()
        if (this.#index < 0 || !this.#spreads) return -1
        const spread = this.#spreads[this.#index]
        if (!spread) return -1
        const section = spread.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    get pageColors() {
        return this.#pageColors
    }
    set pageColors(value) {
        this.#interruptPresentation('superseded')
        this.#pageColors = value
        this.#render()
    }
    get scrolled() {
        return this.#scrollMode
    }
    get scrollLocked() {
        return this.#scrollLocked
    }
    set scrollLocked(value) {
        this.#scrollLocked = value
    }
    get isOverflowX() {
        return this.#isOverflowX
    }
    get isOverflowY() {
        return this.#isOverflowY
    }
    get atStart() {
        if (this.#scrollMode) return this.scrollTop <= 0
        return this.#index <= 0
    }
    get atEnd() {
        if (this.#scrollMode) return this.scrollTop + this.clientHeight >= this.scrollHeight - 2
        return this.#index >= this.#spreads.length - 1
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason, request) {
        if (!request) this.#interruptPresentation('superseded')
        if (!this.#isPresentationCurrent(request)
            || index < 0 || index > this.#spreads.length - 1) return
        this.#side = side
        if (index === this.#index) {
            await this.#spreadReady
            if (!request && !this.#destroyed) await Promise.all(this.#render(side))
            return
        }
        this.#index = index
        const generation = ++this.#spreadGeneration
        const current = () => this.#isPresentationCurrent(request)
            && this.#spreadGeneration === generation
        const loading = (async () => {
            const spread = this.#spreads[index]
            const cacheKey = `spread-${index}`
            const cached = this.#preloadCache.get(cacheKey)
            let shown
            if (cached && cached !== 'loading') {
                if (cached.center) {
                    const sectionIndex = this.book.sections.indexOf(spread.center)
                    shown = await this.#showSpread({ center: { index: sectionIndex, src: cached.center },
                        spreadIndex: index, side, request, generation })
                } else {
                    const indexL = this.book.sections.indexOf(spread.left)
                    const indexR = this.book.sections.indexOf(spread.right)
                    const left = { index: indexL, src: cached.left }
                    const right = { index: indexR, src: cached.right }
                    shown = await this.#showSpread({ left, right, side, spreadIndex: index, request, generation })
                }
            } else if (spread.center) {
                const sectionIndex = this.book.sections.indexOf(spread.center)
                const src = await spread.center?.load?.()
                if (!current()) return
                shown = await this.#showSpread({ center: { index: sectionIndex, src },
                    spreadIndex: index, side, request, generation })
            } else {
                const indexL = this.book.sections.indexOf(spread.left)
                const indexR = this.book.sections.indexOf(spread.right)
                const srcL = await spread.left?.load?.()
                if (!current()) return
                const srcR = await spread.right?.load?.()
                if (!current()) return
                const left = { index: indexL, src: srcL }
                const right = { index: indexR, src: srcR }
                shown = await this.#showSpread({ left, right, side, spreadIndex: index, request, generation })
            }
            if (!shown || !current()) return
            if (!request) {
                this.#reportLocation(reason)
                this.#preloadNextSpreads()
            }
        })()
        this.#spreadReady = loading
        try {
            await loading
        } finally {
            if (this.#spreadReady === loading) this.#spreadReady = Promise.resolve()
        }
    }
    #preloadNextSpreads() {
        if (this.#destroyed) return
        this.#cleanupPreloadCache()

        if (this.#numPrerenderedSpreads <= 0) return

        const toPreload = []
        const forwardPreloadCount = Math.max(1, this.#numPrerenderedSpreads - 1)
        const backwardPreloadCount = Math.max(0, this.#numPrerenderedSpreads - forwardPreloadCount)
        for (let distance = 1; distance <= forwardPreloadCount; distance++) {
            const forwardIndex = this.#index + distance
            if (forwardIndex >= 0 && forwardIndex < this.#spreads.length) {
                toPreload.push({ index: forwardIndex, direction: 'forward', distance })
            }
        }
        for (let distance = 1; distance <= backwardPreloadCount; distance++) {
            const backwardIndex = this.#index - distance
            if (backwardIndex >= 0 && backwardIndex < this.#spreads.length) {
                toPreload.push({ index: backwardIndex, direction: 'backward', distance })
            }
        }
        for (const { index: targetIndex, direction } of toPreload) {
            const cacheKey = `spread-${targetIndex}`
            if (this.#prerenderedSpreads.has(cacheKey)) continue
            const spread = this.#spreads[targetIndex]
            if (!spread) continue
            this.#preloadQueue.push({ targetIndex, direction, spread, cacheKey })
        }

        this.#processPreloadQueue()
    }

    async #processPreloadQueue() {
        while (!this.#destroyed && this.#preloadQueue.length > 0
            && this.#activePreloads < this.#maxConcurrentPreloads) {
            const task = this.#preloadQueue.shift()
            if (!task) break

            const { spread, cacheKey, targetIndex } = task
            const current = () => !this.#destroyed && this.#spreads[targetIndex] === spread
            this.#preloadCache.set(cacheKey, 'loading')
            this.#activePreloads++
            Promise.resolve().then(async () => {
                try {
                    if (spread.center) {
                        const src = await spread.center?.load?.()
                        if (!current()) return
                        this.#preloadCache.set(cacheKey, { center: src })

                        const sectionIndex = this.book.sections.indexOf(spread.center)
                        const frame = await this.#createFrame({ index: sectionIndex, src, detached: true })
                        if (!current() || !frame) {
                            frame?.element?.remove()
                            return
                        }

                        this.#prerenderedSpreads.set(cacheKey, { center: frame })
                        this.#spreadAccessTime.set(cacheKey, Date.now())
                        if (frame.onZoom) {
                            const doc = frame.iframe.contentDocument
                            frame.onZoom({ doc, scale: this.#totalScaleFactor,
                                pageColors: this.#pageColors, signal: this.#lifetime.signal })
                        }
                    } else {
                        const srcL = await spread.left?.load?.()
                        if (!current()) return
                        const srcR = await spread.right?.load?.()
                        if (!current()) return
                        this.#preloadCache.set(cacheKey, { left: srcL, right: srcR })

                        const indexL = this.book.sections.indexOf(spread.left)
                        const indexR = this.book.sections.indexOf(spread.right)
                        const leftFrame = await this.#createFrame({ index: indexL, src: srcL, detached: true })
                        if (!current() || !leftFrame) {
                            leftFrame?.element?.remove()
                            return
                        }
                        const rightFrame = await this.#createFrame({ index: indexR, src: srcR, detached: true })
                        if (!current() || !rightFrame) {
                            leftFrame.element?.remove()
                            rightFrame?.element?.remove()
                            return
                        }

                        this.#prerenderedSpreads.set(cacheKey, { left: leftFrame, right: rightFrame })
                        this.#spreadAccessTime.set(cacheKey, Date.now())

                        if (leftFrame.onZoom) {
                            const docL = leftFrame.iframe.contentDocument
                            leftFrame.onZoom({ doc: docL, scale: this.#totalScaleFactor,
                                pageColors: this.#pageColors, signal: this.#lifetime.signal })
                        }
                        if (rightFrame.onZoom) {
                            const docR = rightFrame.iframe.contentDocument
                            rightFrame.onZoom({ doc: docR, scale: this.#totalScaleFactor,
                                pageColors: this.#pageColors, signal: this.#lifetime.signal })
                        }
                    }
                } catch {
                    this.#preloadCache.delete(cacheKey)
                    this.#prerenderedSpreads.delete(cacheKey)
                } finally {
                    this.#activePreloads--
                    this.#processPreloadQueue()
                }
            })
        }
    }
    #cleanupPreloadCache() {
        const maxSpreads = this.#maxCachedSpreads
        if (this.#prerenderedSpreads.size <= maxSpreads) {
            return
        }

        const framesByAge = Array.from(this.#prerenderedSpreads.keys())
            .map(key => ({
                key,
                accessTime: this.#spreadAccessTime.get(key) || 0,
            }))
            .sort((a, b) => a.accessTime - b.accessTime)

        const numToRemove = this.#prerenderedSpreads.size - maxSpreads
        const framesToDelete = framesByAge.slice(0, numToRemove).map(item => item.key)

        if (framesToDelete.length > 0) {
            framesToDelete.forEach(key => {
                const frames = this.#prerenderedSpreads.get(key)
                if (frames) {
                    if (frames.center) {
                        this.#removeOverlayerForFrame(frames.center)
                        frames.center.element?.remove()
                    } else {
                        this.#removeOverlayerForFrame(frames.left)
                        this.#removeOverlayerForFrame(frames.right)
                        frames.left?.element?.remove()
                        frames.right?.element?.remove()
                    }
                }

                this.#prerenderedSpreads.delete(key)
                this.#spreadAccessTime.delete(key)
                this.#preloadCache.delete(key)
            })
        }
    }
    #removeOverlayerForFrame(frame) {
        if (!frame?.iframe) return
        const idx = frame.iframe.dataset.sectionIndex != null
            ? parseInt(frame.iframe.dataset.sectionIndex) : undefined
        if (idx != null) this.#overlayers.delete(idx)
    }
    async select(target) {
        await this.goTo(target)
        // TODO
    }
    async goTo(target) {
        this.#interruptPresentation('superseded')
        this.#scrollTarget = null
        const resolved = await target
        if (this.#destroyed) return
        if (this.#scrollMode) {
            const page = this.#scrollPages[resolved.index]
            if (page) {
                page.el.scrollIntoView()
                this.#scrollCurrentIndex = resolved.index
                // No native scroll event fires when already at this position.
                this.#reportScrollLocation('navigation')
            }
            return
        }
        const { book } = this
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }
    async next(distance) {
        this.#interruptPresentation('superseded')
        if (this.#scrollMode) {
            this.#scrollBy(distance || this.clientHeight)
            return
        }
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev(distance) {
        this.#interruptPresentation('superseded')
        if (this.#scrollMode) {
            this.#scrollBy(-(distance || this.clientHeight))
            return
        }
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    nextSection() {
        this.#scrollTarget = null
        if (!this.#scrollMode) return
        const currentIndex = this.#getScrollIndex()
        const nextIndex = Math.min(currentIndex + 1, this.#scrollPages.length - 1)
        this.#scrollPages[nextIndex]?.el.scrollIntoView({ behavior: 'smooth' })
        this.#scrollCurrentIndex = nextIndex
    }
    prevSection() {
        this.#scrollTarget = null
        if (!this.#scrollMode) return
        const currentIndex = this.#getScrollIndex()
        const prevIndex = Math.max(currentIndex - 1, 0)
        this.#scrollPages[prevIndex]?.el.scrollIntoView({ behavior: 'smooth' })
        this.#scrollCurrentIndex = prevIndex
    }
    async pan(dx, dy) {
        if (this.#scrollMode) {
            this.#scrollTarget = null
            this.scrollBy({ top: dy, left: dx, behavior: 'auto' })
            return
        }
        if (this.#scrollLocked) return
        this.#scrollLocked = true

        const transform = frame => {
            let { element, iframe } = frame
            if (!iframe || !element) return

            const scrollableContainer = element.parentNode.host
            scrollableContainer.scrollLeft += dx
            scrollableContainer.scrollTop += dy
        }

        transform(this.#center ?? this.#right ?? {})
        this.#scrollLocked = false
    }
    getContents({ includeHidden = false } = {}) {
        if (this.#scrollMode) {
            return this.#scrollPages
                .filter(p => p.state === 'loaded' && p.frame?.iframe)
                .map(p => ({
                    doc: p.frame.iframe.contentDocument,
                    index: p.index,
                    overlayer: this.#overlayers.get(p.index),
                }))
        }
        return Array.from(this.#root.querySelectorAll('iframe'))
            .filter(frame => {
                const parent = frame.parentElement
                return includeHidden || (parent && parent.style.visibility !== 'hidden')
            })
            .map(frame => {
                const index = frame.dataset.sectionIndex != null
                    ? parseInt(frame.dataset.sectionIndex) : undefined
                return {
                    doc: frame.contentDocument,
                    index,
                    overlayer: index != null ? this.#overlayers.get(index) : undefined,
                }
            })
    }
    pinchZoom(ratio) {
        const frames = this.#center
            ? [this.#center]
            : [this.#left, this.#right]
        for (const frame of frames) {
            if (!frame?.element || frame.element.style.visibility === 'hidden') continue
            frame.element.style.transform = `scale(${ratio})`
            frame.element.style.transformOrigin = 'center'
        }
    }
    pinchEnd() {
        for (const frame of [this.#center, this.#left, this.#right]) {
            if (!frame?.element) continue
            frame.element.style.removeProperty('transform')
            frame.element.style.removeProperty('transform-origin')
        }
    }
    get size() {
        return this.clientHeight
    }
    get viewSize() {
        return this.#scrollMode ? this.scrollHeight : this.clientHeight
    }
    get start() {
        return this.#scrollMode ? this.scrollTop : 0
    }
    get end() {
        return this.#scrollMode ? this.scrollTop + this.clientHeight : this.clientHeight
    }
    get page() {
        if (this.#scrollMode) return this.#scrollCurrentIndex >= 0
            ? this.#scrollCurrentIndex : this.#getScrollIndex()
        return this.#index
    }
    get pages() {
        if (this.#scrollMode) return this.#scrollPages.length
        return this.#spreads?.length ?? 0
    }
    get containerPosition() {
        return 0
    }
    get sideProp() {
        return this.#scrollMode ? 'height' : 'width'
    }
    destroy() {
        this.#scrollTarget = null
        this.#interruptPresentation('cancelled')
        this.#destroyed = true
        this.#lifetime.abort()
        this.#spreadGeneration++
        this.#preloadQueue = []
        if (this.#pageGestureTimer) clearTimeout(this.#pageGestureTimer)
        this.#observer.unobserve(this)
        if (this.#scrollMode) {
            this.removeEventListener('scroll', this.#handleScrollEvent)
            if (this.#scrollObserver) {
                this.#scrollObserver.disconnect()
                this.#scrollObserver = null
            }
            if (this.#scrollIdleTimer) {
                clearTimeout(this.#scrollIdleTimer)
                this.#scrollIdleTimer = null
            }
            for (const page of this.#scrollPages) {
                this.#teardownScrollPage(page)
            }
            this.#scrollPages = []
            this.#scrollLoadGen.clear()
            if (this.#scrollContainer) {
                this.#scrollContainer.remove()
                this.#scrollContainer = null
            }
        }
        for (const frames of this.#prerenderedSpreads.values()) {
            if (frames.center) {
                frames.center.element?.remove()
            } else {
                frames.left?.element?.remove()
                frames.right?.element?.remove()
            }
        }
        this.#prerenderedSpreads.clear()
        this.#preloadCache.clear()
        this.#spreadAccessTime.clear()
        this.#overlayers.clear()
    }
}

customElements.define('foliate-fxl', FixedLayout)
