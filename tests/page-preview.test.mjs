import assert from 'node:assert/strict'
import test from 'node:test'
import { PreviewResources, validatePreviewRequest, fitPreview } from '../page-preview.js'

test('preview dimensions stay bounded and preserve the page aspect ratio', () => {
    const bounds = validatePreviewRequest(0, 1, { width: 2000, height: 2000 })
    assert.deepEqual(bounds, { width: 512, height: 512 })
    assert.deepEqual(fitPreview(1200, 1800, bounds), {
        width: 341, height: 512, scale: 512 / 1800,
    })
    assert.throws(() => validatePreviewRequest(1, 1, bounds), RangeError)
    assert.throws(() => validatePreviewRequest(0, 1, { width: Infinity, height: 200 }), RangeError)
})

test('releasing one preview preserves another preview of the same page', async () => {
    const previews = new PreviewResources()
    const first = previews.open()
    const second = previews.open()
    const page = new Blob(['page content'])
    const firstURL = first.createURL(page)
    const secondURL = second.createURL(page)
    first.release()
    first.release()
    await assert.rejects(fetch(firstURL))
    assert.equal(await (await fetch(secondURL)).text(), 'page content')
    second.release()
    await assert.rejects(fetch(secondURL))
})

test('aborting a preview revokes its result and prevents late URL creation', async () => {
    const previews = new PreviewResources()
    const controller = new AbortController()
    const scope = previews.open(controller.signal)
    const url = scope.createURL(new Blob(['page content']))
    controller.abort()
    await assert.rejects(fetch(url))
    assert.throws(() => scope.createURL(new Blob(['late page'])), { name: 'AbortError' })
    assert.throws(() => previews.open(controller.signal), { name: 'AbortError' })
})

test('closing a book revokes every outstanding preview and rejects new requests', async () => {
    const previews = new PreviewResources()
    const first = previews.open()
    const second = previews.open()
    const urls = [first, second].map(scope => scope.createURL(new Blob(['page content'])))
    previews.destroy()
    previews.destroy()
    for (const url of urls) await assert.rejects(fetch(url))
    assert.throws(() => previews.open(), { name: 'AbortError' })
})

test('cancellation works without newer AbortSignal methods', () => {
    assert.throws(() => validatePreviewRequest(0, 1, {
        width: 120, height: 160, signal: { aborted: true },
    }), { name: 'AbortError' })
})
