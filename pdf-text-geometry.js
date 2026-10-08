const MAX_TOKENS = 2048

const tokenize = text => text.normalize('NFKC').toLowerCase()
    .replace(/[‘’ʼ]/gu, "'").replace(/ß/gu, 'ss').replace(/ς/gu, 'σ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:'[\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu) ?? []

const validBox = (word, page) => Number.isInteger(word.line) && word.line >= 0
    && [word.x, word.y, word.width, word.height].every(Number.isFinite)
    && word.x >= 0 && word.y >= 0 && word.width > 0 && word.height > 0
    && word.x + word.width <= page.width && word.y + word.height <= page.height

// Only use correspondences shared by every optimal ordered alignment. Choosing
// one LCS path would silently attach repeated words to an arbitrary occurrence.
const uniqueMatches = (source, recognized) => {
    const n = source.length
    const m = recognized.length
    const stride = m + 1
    const prefix = new Uint16Array((n + 1) * stride)
    const suffix = new Uint16Array((n + 1) * stride)
    for (let i = 0; i < n; i++) {
        const row = (i + 1) * stride
        const previous = i * stride
        for (let j = 0; j < m; j++) prefix[row + j + 1] = source[i] === recognized[j]
            ? prefix[previous + j] + 1
            : Math.max(prefix[previous + j + 1], prefix[row + j])
    }
    for (let i = n - 1; i >= 0; i--) {
        const row = i * stride
        const next = (i + 1) * stride
        for (let j = m - 1; j >= 0; j--) suffix[row + j] = source[i] === recognized[j]
            ? suffix[next + j + 1] + 1
            : Math.max(suffix[next + j], suffix[row + j + 1])
    }

    const best = prefix[n * stride + m]
    const matches = new Int32Array(n).fill(-1)
    if (!best) return matches
    for (let i = 0; i < n; i++) {
        const row = i * stride
        const next = (i + 1) * stride
        let optional = false
        for (let j = 0; j <= m; j++) {
            if (prefix[row + j] + suffix[next + j] === best) {
                optional = true
                break
            }
        }
        if (optional) continue
        let candidate = -1
        for (let j = 0; j < m; j++) {
            if (source[i] !== recognized[j]
                || prefix[row + j] + 1 + suffix[next + j + 1] !== best) continue
            if (candidate !== -1) {
                candidate = -1
                break
            }
            candidate = j
        }
        matches[i] = candidate
    }
    return matches
}

// OCR pixels and the destination viewport must use the same page orientation.
// Boxes are normalized; PDF strings and text-item order remain intact.
export const alignPDFTextGeometry = (items, recognizedPage) => {
    const spans = items.filter(item => typeof item?.str === 'string')
        .map(item => tokenize(item.str))
    const source = spans.flat()
    const result = { boxes: spans.map(() => null), matchedWords: 0, totalWords: source.length }
    if (!source.length || source.length > MAX_TOKENS || recognizedPage?.version !== 1
        || !Number.isFinite(recognizedPage.width) || recognizedPage.width <= 0
        || !Number.isFinite(recognizedPage.height) || recognizedPage.height <= 0
        || !Array.isArray(recognizedPage.words)) return result

    const words = recognizedPage.words.map(word => ({
        source: word,
        tokens: typeof word?.text === 'string' ? tokenize(word.text) : [],
    }))
    const recognized = words.flatMap((word, index) => word.tokens.map((text, token) => ({
        text, word: index, token,
    })))
    if (!recognized.length || recognized.length > MAX_TOKENS) return result
    const matches = uniqueMatches(source, recognized.map(token => token.text))

    let offset = 0
    for (let index = 0; index < spans.length; index++) {
        const span = spans[index]
        const start = offset
        offset += span.length
        if (!span.length) continue
        const first = matches[start]
        if (first < 0 || !span.every((_, token) => matches[start + token] === first + token)) continue
        const from = recognized[first]
        const to = recognized[first + span.length - 1]
        if (from.token !== 0 || to.token !== words[to.word].tokens.length - 1) continue

        const line = words[from.word].source.line
        let left = Infinity
        let top = Infinity
        let right = -Infinity
        let bottom = -Infinity
        let valid = true
        for (let wordIndex = from.word; wordIndex <= to.word; wordIndex++) {
            const { source: word, tokens } = words[wordIndex]
            if (!tokens.length || !validBox(word, recognizedPage) || word.line !== line) {
                valid = false
                break
            }
            left = Math.min(left, word.x)
            top = Math.min(top, word.y)
            right = Math.max(right, word.x + word.width)
            bottom = Math.max(bottom, word.y + word.height)
        }
        if (!valid) continue
        result.boxes[index] = {
            x: left / recognizedPage.width,
            y: top / recognizedPage.height,
            width: (right - left) / recognizedPage.width,
            height: (bottom - top) / recognizedPage.height,
        }
        result.matchedWords += span.length
    }
    return result
}
