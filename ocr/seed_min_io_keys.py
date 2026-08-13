#!/usr/bin/env python3
"""Seed the target MinIO bucket with PDFs and emit keys.json for the k6 scripts.

POST /ocr/create does NOT take file bytes — it takes `min_io_key` references to
objects that ALREADY exist in the shared MinIO bucket (normally put there by
kepabeanan-data-service's upload endpoint). So before any stress run, someone
has to stage files and hand QA the keys. This script does exactly that.

Standalone: depends only on `minio` (pip install minio). It does NOT import the
service code.

Two ways to get keys, pick per your access:
  A) Direct MinIO upload (this script) — fastest, needs bucket credentials.
  B) The "real" path — POST each file to kepabeanan-data-service's upload API
     and collect the returned `data.min_io_key`. Use this if you can't touch
     MinIO directly or want to exercise the true upstream flow. (Not automated
     here; see README.)

Usage:
  # upload real sample PDFs (recommended — realistic OCR timing)
  python seed_min_io_keys.py --source ./samples --doc-type invoice \
      --endpoint localhost:9000 --access-key KEY --secret-key SECRET --bucket ocr

  # or generate N tiny synthetic PDFs if you have no samples handy
  python seed_min_io_keys.py --generate 20 --doc-type invoice \
      --endpoint localhost:9000 --access-key KEY --secret-key SECRET --bucket ocr

Credentials fall back to MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY /
MINIO_BUCKET_NAME / MINIO_USE_SSL env vars (same names as the service's .env).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path


def _build_pdf(objs: list[bytes]) -> bytes:
    """Wrap a list of already-formatted indirect objects (obj 1..N, in order)
    into a complete PDF with a correct xref table and trailer."""
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 %d\n" % (len(objs) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF" % (
        len(objs) + 1, xref_pos)
    return bytes(out)


def _minimal_pdf(text: str) -> bytes:
    """A valid, single-page PDF with one line of text and a correct xref table.
    Enough for the OCR engine to parse; kept tiny so seeding is fast."""
    stream = b"BT /F1 12 Tf 72 720 Td (%s) Tj ET" % text.encode("latin-1", "replace")
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
        b"/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
        b"<</Length %d>>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    return _build_pdf(objs)


def _blank_pdf() -> bytes:
    """A structurally valid, single-page PDF with an EMPTY content stream —
    no text, no drawing operators. Simulates a blank/whited-out scanned page:
    unlike the corrupt/truncated cases, nothing here is malformed, so the
    worker must get all the way through OCR and fail *on content*, not on
    parsing."""
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>",
        b"<</Length 0>>\nstream\n\nendstream",
    ]
    return _build_pdf(objs)


def _many_page_pdf(n_pages: int = 500) -> bytes:
    """A valid PDF with a large page count, each page carrying a tiny bit of
    text. Stresses the parser/pipeline on document *depth* rather than raw
    byte size (unlike oversized.pdf, which is one page padded with bytes)."""
    font_obj = 2 * n_pages + 3
    content_start = 3 + n_pages
    kids = " ".join("%d 0 R" % (3 + i) for i in range(n_pages)).encode()

    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[%s]/Count %d>>" % (kids, n_pages),
    ]
    for i in range(n_pages):
        content_obj = content_start + i
        objs.append(
            b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
            b"/Resources<</Font<</F1 %d 0 R>>>>/Contents %d 0 R>>"
            % (font_obj, content_obj)
        )
    for i in range(n_pages):
        stream = b"BT /F1 10 Tf 72 720 Td (page %d) Tj ET" % (i + 1)
        objs.append(b"<</Length %d>>\nstream\n%s\nendstream" % (len(stream), stream))
    objs.append(b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>")

    return _build_pdf(objs)


def _pdf_escape(s: bytes) -> bytes:
    return s.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _text_lines_pdf(lines: list[str], start_y: int = 750, line_height: int = 14) -> bytes:
    """A valid, single-page PDF that draws each string in `lines` on its own
    row, top to bottom. Used for documents that need real, known text content
    (as opposed to `_minimal_pdf`'s single throwaway line)."""
    parts = [b"BT /F1 11 Tf 72 %d Td" % start_y]
    for i, line in enumerate(lines):
        esc = _pdf_escape(line.encode("latin-1", "replace"))
        if i == 0:
            parts.append(b" (%s) Tj" % esc)
        else:
            parts.append(b" 0 %d Td (%s) Tj" % (-line_height, esc))
    parts.append(b" ET")
    stream = b"".join(parts)
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
        b"/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
        b"<</Length %d>>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    return _build_pdf(objs)


def _ground_truth_invoice(invoice_number: str, total: str, invoice_date: str,
                          n_items: int) -> tuple[bytes, dict]:
    """A structurally normal, VALID invoice PDF (not a defect case) whose
    content we control exactly, so extraction results can be checked against
    known values instead of just "is it non-empty". Also carries more than
    EXTRACTION_MAX_ITEMS (15, per ocr-service .env) line items, to exercise
    the chunked-extraction item cap without needing a real customs document.
    Returns (pdf_bytes, expected_dict) — the expected dict is written into
    the manifest entry so limits.js doesn't need to duplicate these values.

    NOTE: `invoice_date` is required — found the hard way (2026-08-13 run):
    omitting it makes the service extract fine but then skip the DB write
    with code DB_WRITE_SKIPPED ("missing required field: tanggal_invoice"),
    leaving `result` empty even though status stays SUCCESS. Both an English
    and Indonesian label are included since the extractor's expected label
    wasn't documented anywhere QA has access to."""
    lines = [
        "INVOICE",
        f"Invoice Number: {invoice_number}",
        f"Invoice Date: {invoice_date}",
        f"Tanggal Invoice: {invoice_date}",
        f"Total: {total}",
        "Items:",
    ]
    for i in range(1, n_items + 1):
        lines.append(f"{i}. ITEM-{i:03d}  description item number {i}  qty:{i}  price:{1000 * i}")
    pdf = _text_lines_pdf(lines)
    expected = {
        "invoice_number": invoice_number,
        "total": total,
        "invoice_date": invoice_date,
        "item_count_generated": n_items,
        "item_count_max_allowed": 15,  # EXTRACTION_MAX_ITEMS in ocr-service/.env
    }
    return pdf, expected


def _bad_corpus(size_mb: int = 55) -> list[tuple[str, bytes, str]]:
    """Malformed (or content-wise problematic) files the worker/OCR must reject
    *gracefully* (job FAILED with a clear error), not hang or crash on. Each:
    (filename, bytes, defect-label). All keep a .pdf extension so they pass the
    API's extension gate and actually reach the worker — the point is to stress
    the OCR path, not the upload gate. Covers both malformed bytes (corrupt/
    truncated/garbage/empty/oversized/wrong-content-type/encrypted) and valid-
    but-problematic PDFs (blank page with no text, very high page count)."""
    import os
    good = _minimal_pdf("robustness probe")
    tiny_png = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
                b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00"
                b"\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82")

    corpus = [
        ("corrupt_header.pdf", b"NOT-A-PDF-AT-ALL\n" + os.urandom(1024), "corrupt_header"),
        ("truncated.pdf", good[: len(good) // 2], "truncated"),
        ("garbage.pdf", os.urandom(4096), "garbage_bytes"),
        ("empty.pdf", b"", "empty_file"),
        ("image_as_pdf.pdf", tiny_png, "content_type_mismatch"),
        # valid PDF padded past MAX_UPLOAD_SIZE_MB (default 50) with trailing bytes
        ("oversized.pdf", good + b"\n%% pad " + b"0" * (size_mb * 1024 * 1024), "oversized"),
        # structurally valid, but no extractable text — a real "blank scan" case
        ("blank_scan.pdf", _blank_pdf(), "blank_no_text"),
        # structurally valid, 500 pages — stresses parser depth, not byte size
        ("many_pages.pdf", _many_page_pdf(500), "many_pages"),
    ]

    # Encrypted/password-protected PDF — best effort, needs pypdf. Skipped (with a
    # note) if pypdf isn't installed, rather than failing the whole seed run.
    try:
        import io as _io
        from pypdf import PdfReader, PdfWriter
        w = PdfWriter()
        w.append(PdfReader(_io.BytesIO(good)))
        w.encrypt("secret-password")
        buf = _io.BytesIO()
        w.write(buf)
        corpus.append(("encrypted.pdf", buf.getvalue(), "encrypted"))
    except Exception as exc:  # pypdf missing or API change — non-fatal
        print(f"  (skip encrypted.pdf: {exc}; `pip install pypdf` to include it)",
              file=sys.stderr)

    return corpus


def _infer_doc_type(name: str, default: str) -> str:
    low = name.lower()
    if "packing" in low:
        return "packing_list"
    if "lading" in low or low.startswith("bl") or "_bl" in low:
        return "bill_of_lading"
    if "invoice" in low or "inv" in low:
        return "invoice"
    return default


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", help="folder of real PDFs to upload")
    p.add_argument("--generate", type=int, default=0,
                   help="instead of --source, generate this many synthetic PDFs")
    p.add_argument("--bad", action="store_true",
                   help="generate the malformed-file corpus (corrupt/truncated/"
                        "garbage/empty/oversized/image-as-pdf/encrypted) for "
                        "robustness.js; writes keys_bad.json by default")
    p.add_argument("--limits", action="store_true",
                   help="generate one VALID ground-truth invoice PDF (known "
                        "invoice number/total, >15 line items) for limits.js "
                        "correctness + EXTRACTION_MAX_ITEMS checks; writes "
                        "keys_limits.json by default")
    p.add_argument("--doc-type", default="invoice",
                   choices=["invoice", "packing_list", "bill_of_lading"],
                   help="default doc_type; per-file names containing "
                        "'packing'/'lading'/'invoice' override it")
    p.add_argument("--prefix", default="ocr-stress",
                   help="key prefix inside the bucket")
    p.add_argument("--out", default="keys.json", help="output manifest for k6")
    p.add_argument("--endpoint", default=os.getenv("MINIO_ENDPOINT", "localhost:9000"))
    p.add_argument("--access-key", default=os.getenv("MINIO_ACCESS_KEY", ""))
    p.add_argument("--secret-key", default=os.getenv("MINIO_SECRET_KEY", ""))
    p.add_argument("--bucket", default=os.getenv("MINIO_BUCKET_NAME", "ocr"))
    p.add_argument("--secure", action="store_true",
                   default=os.getenv("MINIO_USE_SSL", "false").lower() in ("1", "true", "yes"))
    args = p.parse_args()

    try:
        from minio import Minio
    except ImportError:
        print("ERROR: pip install minio", file=sys.stderr)
        return 2

    client = Minio(args.endpoint, access_key=args.access_key,
                   secret_key=args.secret_key, secure=args.secure)
    if not client.bucket_exists(args.bucket):
        print(f"ERROR: bucket {args.bucket!r} not found at {args.endpoint}", file=sys.stderr)
        return 2

    # --limits is handled separately since its manifest entry carries an
    # `expected` dict (ground-truth values) instead of a `defect` label.
    if args.limits:
        pdf, expected = _ground_truth_invoice(
            invoice_number="INV-2026-QA-0001", total="157500000",
            invoice_date="13-08-2026", n_items=30)
        out_path = args.out if args.out != "keys.json" else "keys_limits.json"
        key = f"{args.prefix}/{uuid.uuid4().hex}-ground_truth_invoice.pdf"
        client.put_object(args.bucket, key, __import__("io").BytesIO(pdf),
                          length=len(pdf), content_type="application/pdf")
        entry = {
            "filename": "ground_truth_invoice.pdf",
            "min_io_key": key,
            "doc_type": "invoice",
            "expected": expected,
        }
        Path(out_path).write_text(json.dumps([entry], indent=2))
        print(f"  uploaded {key} ({len(pdf)} bytes) [ground_truth_invoice]")
        print(f"\nWrote 1 key -> {out_path}")
        print("Now run:  k6 run -e BASE_URL=... limits.js")
        return 0

    # Gather (filename, bytes, defect) triples. defect="" means a normal/good file.
    payloads: list[tuple[str, bytes, str]] = []
    if args.bad:
        payloads = _bad_corpus()
    elif args.source:
        pdfs = sorted(Path(args.source).glob("*.pdf"))
        if not pdfs:
            print(f"ERROR: no *.pdf in {args.source}", file=sys.stderr)
            return 2
        for f in pdfs:
            payloads.append((f.name, f.read_bytes(), ""))
    elif args.generate > 0:
        # Include an invoice-date line (found the hard way, 2026-08-13): the
        # old single-line "STRESS TEST ..." PDF has no date, so every job the
        # service processes ends status=SUCCESS but with errors:[DB_WRITE_
        # SKIPPED] ("missing required field: tanggal_invoice") and an empty
        # result — the job never actually gets persisted. That silently
        # invalidated every prior smoke/load/idempotency run's "success" (the
        # extraction never had anywhere to land). Both an English and
        # Indonesian date label are included for the same reason as
        # _ground_truth_invoice: the extractor's expected label isn't
        # documented anywhere QA has access to.
        for i in range(args.generate):
            name = f"{args.doc_type}_{i:04d}.pdf"
            lines = [
                f"STRESS TEST {args.doc_type} #{i}",
                f"Invoice Number: STRESS-{i:04d}",
                "Invoice Date: 13-08-2026",
                "Tanggal Invoice: 13-08-2026",
            ]
            payloads.append((name, _text_lines_pdf(lines), ""))
    else:
        print("ERROR: pass --source DIR, --generate N, --bad, or --limits", file=sys.stderr)
        return 2

    # --bad defaults its output to keys_bad.json unless the user set --out.
    out_path = args.out
    if args.bad and out_path == "keys.json":
        out_path = "keys_bad.json"

    import io
    manifest = []
    for filename, data, defect in payloads:
        key = f"{args.prefix}/{uuid.uuid4().hex}-{filename}"
        client.put_object(args.bucket, key, io.BytesIO(data), length=len(data),
                          content_type="application/pdf")
        entry = {
            "filename": filename,
            "min_io_key": key,
            "doc_type": _infer_doc_type(filename, args.doc_type),
        }
        if defect:
            entry["defect"] = defect
        manifest.append(entry)
        print(f"  uploaded {key} ({len(data)} bytes){' ['+defect+']' if defect else ''}")

    Path(out_path).write_text(json.dumps(manifest, indent=2))
    print(f"\nWrote {len(manifest)} keys -> {out_path}")
    if args.bad:
        print("Now run:  k6 run -e BASE_URL=... robustness.js")
    else:
        print("Now run:  k6 run -e BASE_URL=... smoke.js")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
