#!/usr/bin/env python3
"""Generate deterministic owned EPUB ZIP fixtures; no network or third-party content."""
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent
for name, href, filename in [
    ('normal', 'chapter.xhtml', 'chapter.xhtml'),
    ('encoded', 'chapter%20one.xhtml', 'chapter one.xhtml'),
    ('unicode', 'chapitres/%C3%A9t%C3%A9%20%E4%B8%80.xhtml', 'chapitres/été 一.xhtml'),
    ('missing', 'missing.xhtml', None),
    ('unknown-id', 'chapter.xhtml', 'chapter.xhtml'),
    ('remote', 'https://example.invalid/chapter.xhtml', None),
]:
    unknown = '<itemref idref="absent-manifest-id"/>' if name == 'unknown-id' else ''
    files = {
        'mimetype': 'application/epub+zip',
        'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'OEBPS/book.opf': f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">owned-{name}-admission-fixture</dc:identifier><dc:title>Admission fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="{href}" media-type="application/xhtml+xml"/></manifest><spine>{unknown}<itemref idref="chapter"/></spine></package>',
    }
    if filename:
        files[f'OEBPS/{filename}'] = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Owned</title></head><body><p>Original owned chapter passage.</p></body></html>'
    with ZipFile(root / f'{name}.epub', 'w', compression=ZIP_STORED) as archive:
        for path, content in files.items():
            info = ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_STORED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content.encode('utf-8'))
