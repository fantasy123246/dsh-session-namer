"""Decompress one session log to plain JSONL for offline replay.

`session.v4.jsonl.zstd` is a concatenation of independent zstd frames — one per
persisted append batch — so a single-frame decompressor (node's
`zstdDecompressSync`) stops after the header. `zstandard`'s stream_reader walks
every frame, which is why this step lives in Python.
"""
import io
import sys

import zstandard

src = sys.argv[1]
dst = sys.argv[2]
with open(src, "rb") as fh:
    blob = fh.read()
text = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(blob)).read()
with open(dst, "wb") as out:
    out.write(text)
print("ok", len(text), "bytes")
