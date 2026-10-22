import { EPUB } from '../epub.js'
import { BlobReader, TextWriter, ZipReader, configure } from '../vendor/zip.js'

configure({ useWebWorkers: false, useCompressionStream: false })

const assert = (condition, message) => {
    if (!condition) throw new Error(message)
}

const withBook = async (name, inspect) => {
    const response = await fetch(new URL(`./fixtures/${name}.epub`, import.meta.url))
    if (!response.ok) throw new Error(`Failed to read owned ZIP fixture: ${name}`)
    const reader = new ZipReader(new BlobReader(await response.blob()))
    const entries = await reader.getEntries()
    const byName = new Map(entries.map(entry => [entry.filename, entry]))
    const book = new EPUB({
        entries,
        loadText: name => byName.get(name)?.getData(new TextWriter()) ?? null,
        loadBlob: () => { throw new Error('This admission fixture does not request binary assets') },
        getSize: name => byName.get(name)?.uncompressedSize ?? 0,
    })
    try {
        await book.init()
        await inspect(book)
    } finally {
        book.destroy()
        await reader.close()
    }
}

const results = []
const run = async (name, body) => {
    try {
        await body()
        results.push({ name, status: 'passed' })
    } catch (error) {
        results.push({ name, status: 'failed', error: String(error) })
        throw error
    } finally {
        const output = document.getElementById('epub-admission-results')
        if (output) output.textContent = JSON.stringify(results, null, 2)
    }
}

document.documentElement.dataset.epubAdmissionStatus = 'running'
try {
    for (const name of ['normal', 'encoded', 'unicode'])
        await run(`read original ZIP section: ${name}`, () => withBook(name, async book => {
        assert(book.sections.length === 1, 'Expected one reading section')
        const doc = await book.sections[0].createDocument()
        assert(doc.body.textContent.includes('Original owned chapter passage.'),
            'Original reading content must remain usable')
    }))
    await run('reject a missing local spine entry', async () => {
        let error
        try {
            await withBook('missing', () => {
                throw new Error('Missing local content was admitted')
            })
        } catch (caught) { error = caught }
        assert(error instanceof Error && /Missing EPUB content resource/.test(error.message),
            'Expected the actual EPUB admission error for absent local content')
    })
    await run('retain skipping an unresolved manifest id before a valid section', () =>
        withBook('unknown-id', async book => {
            assert(book.sections.length === 1, 'Valid remaining section must stay available')
            const doc = await book.sections[0].createDocument()
            assert(doc.body.textContent.includes('Original owned chapter passage.'),
                'Skipping an unknown manifest id must not remove valid content')
        }))
    await run('retain permitted external spine admission without a local ZIP entry', () =>
        withBook('remote', book => {
            assert(book.sections[0].id === 'https://example.invalid/chapter.xhtml',
                'External URI policy must remain unchanged')
        }))
    document.documentElement.dataset.epubAdmissionStatus = 'passed'
} catch (error) {
    document.documentElement.dataset.epubAdmissionStatus = 'failed'
    throw error
}
