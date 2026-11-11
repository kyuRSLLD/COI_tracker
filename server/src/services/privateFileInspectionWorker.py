"""Private inspection worker. Receives bytes on stdin; never prints file details."""
import io
import logging
import struct
import subprocess
import sys
import warnings
import zlib

MAX_INPUT = 10 * 1024 * 1024
MAX_PIXELS_PER_FRAME = 20_000_000
MAX_TOTAL_PIXELS = 40_000_000
MAX_FRAMES = 20
MAX_PAGES = 30
MAX_PDF_OBJECTS = 10_000


def check_png_envelope(data):
    offset = 8
    while True:
        if offset + 12 > len(data):
            raise ValueError('truncated PNG')
        size = struct.unpack_from('>I', data, offset)[0]
        end = offset + 12 + size
        if end > len(data):
            raise ValueError('truncated PNG chunk')
        kind = data[offset + 4:offset + 8]
        crc = struct.unpack_from('>I', data, end - 4)[0]
        if zlib.crc32(data[offset + 4:end - 4]) & 0xffffffff != crc:
            raise ValueError('PNG CRC')
        if kind == b'IEND':
            if size != 0 or end != len(data):
                raise ValueError('PNG end')
            break
        offset = end


def check_image(data, mime):
    from PIL import Image, ImageFile
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS_PER_FRAME
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    expected = {'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP'}[mime]
    if mime == 'image/png':
        check_png_envelope(data)
    elif mime == 'image/jpeg':
        if not data.endswith(b'\xff\xd9'):
            raise ValueError('JPEG end')
    elif len(data) < 12 or struct.unpack_from('<I', data, 4)[0] + 8 != len(data):
        raise ValueError('WebP RIFF length')
    with Image.open(io.BytesIO(data)) as image:
        if image.format != expected:
            raise ValueError('mismatched image format')
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        if image.format != expected:
            raise ValueError('mismatched image format')
        n = getattr(image, 'n_frames', 1)
        if n < 1 or n > MAX_FRAMES:
            raise ValueError('frame count')
        total = 0
        for frame in range(n):
            image.seek(frame)
            w, h = image.size
            pixels = w * h
            total += pixels
            if w < 1 or h < 1 or pixels > MAX_PIXELS_PER_FRAME or total > MAX_TOTAL_PIXELS:
                raise ValueError('image dimensions')
            image.load()


def check_pdf(data, renderer):
    from pypdf import PdfReader
    from pypdf.generic import ContentStream, IndirectObject, StreamObject
    if not data.rstrip(b'\x00\x09\x0a\x0c\x0d\x20').endswith(b'%%EOF'):
        raise ValueError('PDF end')
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ValueError('encrypted PDF')
    pages = reader.pages
    if not 1 <= len(pages) <= MAX_PAGES:
        raise ValueError('page count')
    ids = {(idnum, generation) for generation, entries in reader.xref.items()
           for idnum, offset in entries.items() if idnum != 0 and offset != 0}
    ids.update((idnum, 0) for idnum in reader.xref_objStm)
    if len(ids) > MAX_PDF_OBJECTS:
        raise ValueError('object count')
    for idnum, generation in ids:
        obj = reader.get_object(IndirectObject(idnum, generation, reader))
        if obj is None:
            raise ValueError('missing object')
        if isinstance(obj, StreamObject):
            obj.get_data()  # force decoding; memory/CPU-limited
    for page in pages:
        box = page.mediabox
        if float(box.width) <= 0 or float(box.height) <= 0:
            raise ValueError('page size')
        contents = page.get_contents()
        if contents is not None:
            ContentStream(contents, reader).operations  # force parse page operators
    # Render every page at bounded resolution; no images are saved or returned.
    result = subprocess.run([renderer, '-scale-to', '256', '-png', '-'], input=data,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0 or result.stderr:
        raise ValueError('PDF renderer rejected input')


def main():
    if len(sys.argv) != 3:
        raise ValueError('arguments')
    logging.disable(logging.CRITICAL)
    mime, renderer = sys.argv[1:]
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not data or len(data) > MAX_INPUT:
        raise ValueError('size')
    if mime == 'application/pdf':
        check_pdf(data, renderer)
    elif mime in ('image/jpeg', 'image/png', 'image/webp'):
        check_image(data, mime)
    else:
        raise ValueError('type')


if __name__ == '__main__':
    try:
        main()
        sys.stdout.write('INSPECTION-PARSE-OK\n')
    except BaseException:
        # No tracebacks or parser diagnostics: they may contain private input.
        sys.exit(1)
