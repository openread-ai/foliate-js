import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { configure, ZipReader, BlobReader, TextWriter, BlobWriter } from '../vendor/zip.js'

const text = '<p>Owned ZIP passage: été 一.</p>'
const archive = zipSync({
    'stored.txt': [strToU8(text), { level: 0 }],
    'été/一.xhtml': [strToU8(text), { level: 6 }],
})

for (const useCompressionStream of [false, true]) {
    test(`read built ZIP without workers, assets or usable native inflate (${useCompressionStream})`, async t => {
        const fetch = t.mock.method(globalThis, 'fetch', () => {
            throw new Error('ZIP reading must not fetch an asset')
        })
        configure({
            useWebWorkers: false,
            useCompressionStream,
            DecompressionStream: class {
                constructor() { throw new Error('Native raw inflate is unavailable') }
            },
        })
        const reader = new ZipReader(new BlobReader(new Blob([archive])))
        try {
            const entries = await reader.getEntries()
            assert.deepEqual(entries.map(entry => entry.filename), ['stored.txt', 'été/一.xhtml'])
            for (const entry of entries) {
                assert.equal(await entry.getData(new TextWriter(), { checkSignature: true }), text)
                const blob = await entry.getData(new BlobWriter('application/xhtml+xml'), {
                    checkSignature: true,
                })
                assert.equal(blob.type, 'application/xhtml+xml')
                assert.equal(await blob.text(), text)
            }
            assert.equal(fetch.mock.callCount(), 0)
        } finally {
            await reader.close()
        }
    })
}
