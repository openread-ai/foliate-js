const MAX_PREVIEW_SIZE = 512

export const checkPreviewSignal = signal => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Preview cancelled', 'AbortError')
}

export const validatePreviewRequest = (index, length, { width, height, signal }) => {
    checkPreviewSignal(signal)
    if (!Number.isInteger(index) || index < 0 || index >= length)
        throw new RangeError('Invalid preview page index')
    if (![width, height].every(value => Number.isFinite(value) && value > 0))
        throw new RangeError('Preview dimensions must be positive finite numbers')
    return {
        width: Math.max(1, Math.min(MAX_PREVIEW_SIZE, Math.floor(width))),
        height: Math.max(1, Math.min(MAX_PREVIEW_SIZE, Math.floor(height))),
    }
}

export const fitPreview = (width, height, bounds) => {
    if (![width, height].every(value => Number.isFinite(value) && value > 0))
        throw new Error('Page has no valid preview dimensions')
    const scale = Math.min(bounds.width / width, bounds.height / height, 1)
    return {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
        scale,
    }
}

export class PreviewResources {
    #scopes = new Set()
    #destroyed = false
    open(signal) {
        if (this.#destroyed) throw new DOMException('Book is closed', 'AbortError')
        checkPreviewSignal(signal)
        const controller = new AbortController()
        const cleanups = new Set()
        const release = () => {
            if (controller.signal.aborted) return
            controller.abort()
            signal?.removeEventListener('abort', release)
            for (const cleanup of cleanups) cleanup()
            cleanups.clear()
            this.#scopes.delete(scope)
        }
        const scope = {
            signal: controller.signal,
            release,
            add: cleanup => {
                if (controller.signal.aborted) cleanup()
                else cleanups.add(cleanup)
            },
            createURL: blob => {
                checkPreviewSignal(controller.signal)
                const url = URL.createObjectURL(blob)
                cleanups.add(() => URL.revokeObjectURL(url))
                return url
            },
        }
        this.#scopes.add(scope)
        signal?.addEventListener('abort', release, { once: true })
        return scope
    }
    destroy() {
        this.#destroyed = true
        for (const scope of this.#scopes) scope.release()
    }
}

export const canvasPreview = async (canvas, scope) => {
    const { width, height } = canvas
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    checkPreviewSignal(scope.signal)
    if (!blob) throw new Error('Failed to encode page preview')
    return { kind: 'image', url: scope.createURL(blob), width, height,
        release: scope.release }
}

export const imagePreview = async (blob, bounds, scope) => {
    checkPreviewSignal(scope.signal)
    const image = new Image()
    const source = URL.createObjectURL(blob)
    const cancel = () => image.removeAttribute('src')
    scope.signal.addEventListener('abort', cancel, { once: true })
    const canvas = document.createElement('canvas')
    try {
        image.src = source
        await image.decode()
        checkPreviewSignal(scope.signal)
        const { width, height } = fitPreview(image.naturalWidth, image.naturalHeight, bounds)
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(image, 0, 0, width, height)
        return await canvasPreview(canvas, scope)
    } finally {
        scope.signal.removeEventListener('abort', cancel)
        image.removeAttribute('src')
        URL.revokeObjectURL(source)
        canvas.width = 0
        canvas.height = 0
    }
}
