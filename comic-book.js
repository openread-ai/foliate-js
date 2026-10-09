import { checkPreviewSignal, PreviewResources, validatePreviewRequest, imagePreview } from './page-preview.js'

export const makeComicBook = async ({ entries, loadBlob, getSize, getComment }, file) => {
    const previews = new PreviewResources()
    const cache = new Map()
    const urls = new Map()
    const load = async name => {
        if (cache.has(name)) return cache.get(name)
        const src = URL.createObjectURL(await loadBlob(name))
        const page = URL.createObjectURL(
            new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin: 0"><img src="${src}"></body></html>`], { type: 'text/html' }))
        urls.set(name, [src, page])
        cache.set(name, page)
        return page
    }
    const unload = name => {
        urls.get(name)?.forEach?.(url => URL.revokeObjectURL(url))
        urls.delete(name)
        cache.delete(name)
    }

    const exts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.jxl', '.avif']
    const files = entries
        .map(entry => entry.filename)
        .filter(name => exts.some(ext => name.endsWith(ext)))
        .sort()
    if (!files.length) throw new Error('No supported image files in archive')

    const book = {}
    try {
        const jsonComment = JSON.parse(await getComment() || '')
        const info = jsonComment['ComicBookInfo/1.0']
        if (info) {
            const year = info.publicationYear
            const month = info.publicationMonth
            const mm = month && month >= 1 && month <= 12 ? String(month).padStart(2, '0') : null
            book.metadata = {
                title: info.title || file.name,
                publisher: info.publisher,
                language: info.language || info.lang,
                author: info.credits ? info.credits.map(c => `${c.person} (${c.role})`).join(', ') : '',
                published: year && month ? `${year}-${mm}` : undefined,
            }
        } else {
            book.metadata = { title: file.name }
        }
    } catch {
        book.metadata = { title: file.name }
    }
    book.getCover = () => loadBlob(files[0])
    book.getPagePreview = async (index, options) => {
        const bounds = validatePreviewRequest(index, files.length, options)
        const scope = previews.open(options.signal)
        try {
            return await imagePreview(await loadBlob(files[index]), bounds, scope)
        } catch (error) {
            const aborted = scope.signal.aborted
            scope.release()
            if (aborted) checkPreviewSignal(scope.signal)
            throw error
        }
    }
    book.sections = files.map(name => ({
        id: name,
        load: () => load(name),
        unload: () => unload(name),
        size: getSize(name),
    }))
    book.toc = files.map(name => ({ label: name, href: name }))
    book.rendition = { layout: 'pre-paginated' }
    book.resolveHref = href => ({ index: book.sections.findIndex(s => s.id === href) })
    book.splitTOCHref = href => [href, null]
    book.getTOCFragment = doc => doc.documentElement
    book.destroy = () => {
        previews.destroy()
        for (const arr of urls.values())
            for (const url of arr) URL.revokeObjectURL(url)
    }
    return book
}
