// ocr-confidence — records the OCR `confident_score` for each configured
// document. NOT a load test: one VU PER document, each doing one OCR job,
// all running CONCURRENTLY (not looped sequentially in a single VU — with
// enough documents that adds up past an SSO token's ~1h lifetime; see the
// comment above `options` for the reasoning). Also deliberately not batched
// like e2e-bc20/journey_ocr.js — batching multiple docs into one OCR job
// would make it unclear which score belongs to which file.
//
// Ground truth on confident_score (from ocr-service source, app/scoring/
// validator.py — not guessed from the frontend):
//   - Computed IN-HOUSE by ocr-service itself (geometric mean of how many
//     fields got filled × how many of those values are literally found in
//     the raw OCR text) — NOT a score reported by the underlying OCR/LLM
//     engines (MinerU/Docling/Qwen). Formula:
//       confident_score = round(sqrt(grounding * completeness) * 100, 1)
//   - Scale 0-100. Always a number once a record exists (never null — 0.0
//     if nothing was checkable). Only appears in GET /ocr/getData/{job_id}
//     AFTER status reaches completed/SUCCESS; before that `result` is `{}`.
//   - Path: data.result.<invoices|packing_lists|bill_of_lading>[].confident_score
//   - There is NO threshold/gating tied to this score anywhere in
//     ocr-service today (confirmed by a full grep — no config, no env var,
//     no code path reads it to pass/fail/retry anything). It's advisory
//     data only, meant to inform manual/human review downstream. So: it is
//     NOT currently tunable — there's nothing to tune. If -e MIN_CONFIDENCE
//     is set below, that's a QA-defined watch value, not a backend rule.
//
// Setup: cp config.example.json config.json, fill in `documents` (path,
// doc_type, dokumen label) — ideally real documents, since synthetic ones
// may score oddly on the grounding check.
//
//   k6 run -e SSO_TOKEN=<bearer> confidence.js
//   k6 run -e SSO_TOKEN=<bearer> confidence.js 2>&1 | grep OCR_CONFIDENCE
//   k6 run -e SSO_TOKEN=<bearer> -e MIN_CONFIDENCE=70 confidence.js   # optional QA watch value
//
// ⚠️ Uploads real files + creates real OCR jobs + writes data via data-service.
// Dev/throwaway env only.

import http from 'k6/http';
import { group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { makeSummary } from './summary.js';

const CFG = JSON.parse(open('./config.json'));
const SSO_TOKEN = __ENV.SSO_TOKEN || '';
const DS  = (__ENV.DATA_SERVICE_URL || CFG.base_urls.data_service).replace(/\/+$/, '');
const OCR = (__ENV.OCR_URL || CFG.base_urls.ocr).replace(/\/+$/, '');
const CREATED = CFG.created_by || 'qa-ocr-confidence';
const POLL_S   = Number(__ENV.POLL_INTERVAL_S || CFG.poll_interval_s || 3);
const MAX_WAIT = Number(__ENV.MAX_WAIT_S || CFG.max_wait_s || 300);
const MIN_CONFIDENCE = Number(__ENV.MIN_CONFIDENCE || 0); // 0 = watch disabled

const DOC_GROUP = { invoice: 'invoices', packing_list: 'packing_lists', bill_of_lading: 'bill_of_lading' };

// open every configured document once at init
const ALL_DOCUMENTS = (CFG.documents || []).map((d) => ({
  bin: open(`./${d.path}`, 'b'),
  name: d.path.split('/').pop(),
  path: d.path,
  docType: d.doc_type || 'invoice',
  dokumen: d.dokumen || 'Dokumen OCR',
}));

// Batching (-e BATCH_SIZE=N -e BATCH_INDEX=i): submitting everything at once
// is safe on OUR side (parallel VUs don't accumulate client-side wait — see
// the maxDuration comment below), but ocr-service's own real capacity is
// limited regardless of how many jobs we submit at once — it's backed by ONE
// shared Ollama/MinerU host, worker pool caps at 4, and the service's own
// sizing assumption is a ~2 documents/minute drain rate (ocr-service .env
// comments, RATE_LIMIT_DOCS_PER_MIN). Sending a large batch in one go just
// makes the tail of the batch sit in ocr-service's internal queue longer
// (showing up as false "Timeout" rows if MAX_WAIT_S isn't generous enough),
// not process any faster. BATCH_SIZE/BATCH_INDEX let you split `documents`
// into smaller chunks run one at a time (each with a fresh SSO_TOKEN if
// needed) instead of hammering the queue with everything simultaneously.
// Default (no batching): BATCH_SIZE = all documents, BATCH_INDEX = 0.
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || ALL_DOCUMENTS.length || 1);
const BATCH_INDEX = Number(__ENV.BATCH_INDEX || 0);
const TOTAL_BATCHES = Math.max(1, Math.ceil(ALL_DOCUMENTS.length / BATCH_SIZE));
const DOCUMENTS = ALL_DOCUMENTS.slice(BATCH_INDEX * BATCH_SIZE, (BATCH_INDEX + 1) * BATCH_SIZE);
if (DOCUMENTS.length === 0) {
  throw new Error(`[ocr-confidence] BATCH_INDEX=${BATCH_INDEX} is out of range — ` +
    `${ALL_DOCUMENTS.length} document(s) in config.json, BATCH_SIZE=${BATCH_SIZE} ` +
    `gives ${TOTAL_BATCHES} batch(es) (valid BATCH_INDEX: 0..${TOTAL_BATCHES - 1}).`);
}
console.log(`[ocr-confidence] batch ${BATCH_INDEX + 1}/${TOTAL_BATCHES}: ` +
  `${DOCUMENTS.length} document(s) — ${DOCUMENTS.map((d) => d.name).join(', ')}`);

const ocrConfidence = new Trend('ocr_confidence_score', true);
const ocrLowConfidence = new Rate('ocr_low_confidence'); // only meaningful if MIN_CONFIDENCE > 0
const jobFailed = new Rate('ocr_job_failed');

// Documents in THIS BATCH run ONE PER VU, IN PARALLEL (see default() below)
// — not looped sequentially in a single VU. Sequential-in-one-VU was the
// original design, but with enough documents (especially auto-detect ones,
// 3x the work each) client-side wait alone adds up past an SSO token's ~1h
// lifetime (documented the hard way — 9 documents, 2 auto-detect, took ~85
// minutes sequential). Running them concurrently removes that client-side
// accumulation. It does NOT remove ocr-service's own queueing (see the
// BATCH_SIZE comment above) — that's what batching is for instead.
//
// maxDuration only needs to cover one VU's worst case now: a normal document
// (1 attempt) or, if any document in this batch is auto-detect, up to 3
// attempts.
const HAS_AUTO = DOCUMENTS.some((d) => d.docType === 'auto');
const ATTEMPTS_PER_DOC = HAS_AUTO ? 3 : 1;
const MAX_DURATION_S = Math.max(300, ATTEMPTS_PER_DOC * (MAX_WAIT + 120) + 60); // +120s per attempt for upload/create overhead, +60s buffer

export const options = {
  scenarios: {
    confidence: {
      executor: 'per-vu-iterations',
      vus: Math.max(1, DOCUMENTS.length),
      iterations: 1,
      maxDuration: `${MAX_DURATION_S}s`,
    },
  },
};

function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (SSO_TOKEN) h['Authorization'] = `Bearer ${SSO_TOKEN}`;
  h['Accept-Language'] = 'id';
  return h;
}
function jsonHeaders(extra) {
  return headers(Object.assign({ 'Content-Type': 'application/json' }, extra || {}));
}

// tolerant field extractor (same convention as e2e-bc20/lib.js pick())
function pick(body, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = body;
    let ok = true;
    for (const part of parts) {
      if (cur == null) { ok = false; break; }
      cur = cur[part];
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
}

const TERMINAL = new Set(['success', 'failed', 'completed', 'error']);

// data-service's upload/file endpoint validates Content-Type strictly (only
// application/pdf + a handful of image types are allowed) — http.file()
// defaults to application/octet-stream if not told otherwise, which gets a
// flat 400 "Tipe file tidak didukung". Guess from the extension instead.
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  tif: 'image/tiff', tiff: 'image/tiff',
};
function guessMime(filename) {
  const ext = String(filename).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/pdf';
}

// Exact business-field denominator per doc type, taken straight from
// ocr-service's app/store/document_mapping.py (_map_invoice/_map_packing_list/
// _map_bill_of_lading) — the same fields it sums over to compute `completeness`.
// Metadata keys (id, id_job, document_type, path_file, preview_url,
// confident_score, items/entitas/containers) are NOT part of this list.
const BUSINESS_FIELDS = {
  invoice: ['nomor_invoice', 'tanggal_invoice', 'nama_penerbit_invoice', 'alamat_penerbit_invoice',
    'negara_penerbit_invoice', 'consignee', 'mata_uang', 'incoterm'],
  packing_list: ['nomor_invoice', 'tanggal_invoice'],
  bill_of_lading: ['nomor_bill_of_lading', 'tanggal_bill_of_lading', 'jenis_dokumen', 'jenis_pergerakan',
    'pelabuhan_muat', 'negara_pelabuhan_muat', 'pelabuhan_bongkar', 'negara_pelabuhan_bongkar',
    'tempat_penyerahan', 'negara_tempat_penyerahan', 'tempat_penerimaan', 'nama_kapal',
    'nomor_pelayaran', 'tanda_dan_nomor', 'uraian_barang', 'kode_hs', 'berat_kotor',
    'volume_muatan', 'jumlah_kemasan', 'jenis_kemasan'],
};

// Mirrors ocr-service's app/scoring/validator.py _is_empty_leaf(), which is
// what field_confidence() actually uses for the completeness ratio: strings
// are trimmed and "-" counts as empty too (real responses contain
// whitespace-placeholder fields like "  " — see ocr/FINDINGS.md #7), bools
// are never empty, numbers are empty only at exactly 0.
function isEmptyValue(v) {
  if (typeof v === 'string') return v.trim() === '' || v.trim() === '-';
  if (typeof v === 'boolean') return false;
  if (typeof v === 'number') return v === 0;
  return v === null || v === undefined;
}

// Recompute the same `completeness` ocr-service used (# filled / # total
// business fields), since the field values themselves ARE in the response
// even though ocr-service's own completeness/grounding numbers are not.
function computeCompleteness(record, docType) {
  const fieldNames = BUSINESS_FIELDS[docType] || [];
  const filled = [], empty = [];
  for (const name of fieldNames) {
    (isEmptyValue(record[name]) ? empty : filled).push(name);
  }
  const ratio = fieldNames.length > 0 ? filled.length / fieldNames.length : null;
  return { fieldNames, filled, empty, ratio };
}

// Algebraic inverse of ocr-service's formula:
//   confident_score = round(sqrt(grounding * completeness) * 100, 1)
// => grounding ≈ (confident_score/100)^2 / completeness
// Approximate (rounding in the source formula introduces small error), and
// undefined when completeness is 0 (score is then 0 regardless of grounding).
function impliedGrounding(score, completenessRatio) {
  if (!completenessRatio || completenessRatio <= 0) return null;
  const g = Math.pow(score / 100, 2) / completenessRatio;
  return Math.max(0, Math.min(100, g * 100));
}

// Per-document detail for the report. NOTE: this can NOT be collected in a
// module-level array and read back inside handleSummary() — k6 runs
// handleSummary in a separate JS runtime that does not share state with the
// runtime that executed default() (verified empirically; this bit an earlier
// version of this script into silently producing "0 documents" reports every
// time). Emitting one JSON line per document via console.log instead — that
// output IS reliably captured in the run's log — and building the actual
// Excel/Word report from that log afterward with report/build-report.js.
function emitReportRow(row) {
  // row.doc carries the raw file binary (doc.bin, an ArrayBuffer) — strip it,
  // the report only needs path/docType/dokumen, not the file content.
  const docMeta = { name: row.doc.name, path: row.doc.path, docType: row.doc.docType, dokumen: row.doc.dokumen };
  console.log('REPORT_ROW ' + JSON.stringify(Object.assign({}, row, { doc: docMeta })));
}

// Pulls the (single, expected) scored record for one doc type out of a
// terminal getData body, and computes completeness/implied-grounding for it.
// One job here always carries exactly one file, so at most one record.
function extractScoredRecord(docTypeForJob, body) {
  const groupKey = DOC_GROUP[docTypeForJob] || 'invoices';
  const records = pick(body, [`data.result.${groupKey}`, `result.${groupKey}`]);
  if (!Array.isArray(records) || records.length === 0) return { found: false, noScoreField: false };
  const rec = records[0];
  const raw = pick(rec, ['confident_score']);
  const score = Number(raw);
  if (Number.isNaN(score)) return { found: false, noScoreField: true, rawRecord: rec };
  const completeness = computeCompleteness(rec, docTypeForJob);
  const grounding = completeness.ratio !== null ? impliedGrounding(score, completeness.ratio) : null;
  return { found: true, score, completeness, grounding, rawRecord: rec };
}

// Runs ONE OCR job attempt for a given docType against an already-uploaded
// min_io_key. Shared by the normal flow (known doc_type, called once) and
// auto-detect (called once per candidate type, same file/min_io_key each
// time). Returns a plain result object — doesn't touch metrics/reporting
// itself, so callers can decide what to do with single vs. multiple attempts.
function runOcrJob(doc, docTypeForJob, minIoKey, fname) {
  let jobId = null;
  group(`ocr_create_${docTypeForJob}`, () => {
    const body = { invoices: [], packing_lists: [], bill_of_lading: [] };
    (body[DOC_GROUP[docTypeForJob]] || body.invoices).push({ filename: fname, min_io_key: minIoKey });
    const res = http.post(`${OCR}/ocr/create`, JSON.stringify(body), { headers: jsonHeaders(), tags: { hop: 'ocr_create' } });
    if (res.status !== 202 && res.status !== 200) {
      console.error(`[ocr-confidence] ocr/create (${docTypeForJob}) failed for ${doc.path}: ${res.status} ${String(res.body).slice(0, 200)}`);
      return;
    }
    try { jobId = pick(res.json(), ['data.job_id', 'job_id', 'data.id', 'id']); } catch (_) {}
  });
  if (!jobId) return { docType: docTypeForJob, status: 'ocr_create_failed', jobId: null };

  // Track what we actually saw during polling so a timeout isn't a total
  // black box — was the job genuinely still processing (status kept coming
  // back non-terminal, e.g. "processing"/"pending"), or were poll requests
  // themselves failing (non-200, bad JSON)?
  let terminal = null, terminalBody = null;
  let lastSeenStatus = null, lastHttpStatus = null, pollCount = 0, non200Count = 0;
  group(`ocr_poll_${docTypeForJob}`, () => {
    const start = Date.now();
    while ((Date.now() - start) / 1000 < MAX_WAIT) {
      sleep(POLL_S);
      pollCount++;
      const res = http.get(`${OCR}/ocr/getData/${jobId}`, { headers: headers(), tags: { hop: 'ocr_poll' } });
      lastHttpStatus = res.status;
      if (res.status !== 200) { non200Count++; continue; }
      let body;
      try { body = res.json(); } catch (_) { continue; }
      const status = String(pick(body, ['data.status', 'status']) || '').toLowerCase();
      lastSeenStatus = status || '(kosong)';
      if (TERMINAL.has(status)) { terminal = status; terminalBody = body; break; }
    }
  });

  if (terminal === null) {
    console.error(`[ocr-confidence] job ${jobId} (${doc.path}, ${docTypeForJob}) polling detail: ` +
      `${pollCount} polls, ${non200Count} non-200, last http_status=${lastHttpStatus}, last job status="${lastSeenStatus}"`);
    return { docType: docTypeForJob, status: 'timeout', jobId, lastSeenStatus, lastHttpStatus, pollCount, non200Count };
  }
  if (terminal !== 'success' && terminal !== 'completed') return { docType: docTypeForJob, status: 'job_' + terminal, jobId };

  const extracted = extractScoredRecord(docTypeForJob, terminalBody);
  if (!extracted.found) {
    return { docType: docTypeForJob, status: extracted.noScoreField ? 'no_score_field' : 'no_record', jobId, rawRecord: extracted.rawRecord };
  }
  return {
    docType: docTypeForJob, status: 'scored', jobId,
    score: extracted.score, completeness: extracted.completeness, grounding: extracted.grounding, rawRecord: extracted.rawRecord,
  };
}

// If the top two candidate types' completeness are this close, don't trust
// the "winner" outright — flag it for manual review instead.
const AUTO_DETECT_AMBIGUOUS_MARGIN = 0.15;

function runAutoDetect(doc, minIoKey, fname) {
  const candidates = ['invoice', 'packing_list', 'bill_of_lading'];
  const attempts = candidates.map((t) => runOcrJob(doc, t, minIoKey, fname));
  const scored = attempts.filter((a) => a.status === 'scored').slice()
    .sort((a, b) => b.completeness.ratio - a.completeness.ratio || b.score - a.score);
  const winner = scored[0] || null;
  const ambiguous = scored.length >= 2 && (scored[0].completeness.ratio - scored[1].completeness.ratio) < AUTO_DETECT_AMBIGUOUS_MARGIN;

  if (winner) {
    jobFailed.add(false);
    ocrConfidence.add(winner.score);
    if (MIN_CONFIDENCE > 0) ocrLowConfidence.add(winner.score < MIN_CONFIDENCE);
    console.log(`OCR_CONFIDENCE file=${doc.path} doc_type=${winner.docType} (auto-detected${ambiguous ? ', AMBIGUOUS' : ''}) job_id=${winner.jobId} score=${winner.score}`);
  } else {
    jobFailed.add(true);
    console.error(`[ocr-confidence] auto-detect for ${doc.path}: none of the 3 candidate types produced a scored record`);
  }
  emitReportRow({ doc, status: 'auto_detect', attempts, winner, ambiguous });
}

function handleSingleTypeResult(doc, result) {
  if (result.status === 'scored') {
    jobFailed.add(false);
    ocrConfidence.add(result.score);
    if (MIN_CONFIDENCE > 0) ocrLowConfidence.add(result.score < MIN_CONFIDENCE);
    console.log(`OCR_CONFIDENCE file=${doc.path} doc_type=${doc.docType} job_id=${result.jobId} score=${result.score}`);
    emitReportRow({
      doc, jobId: result.jobId, status: 'scored',
      score: result.score, completeness: result.completeness, grounding: result.grounding, rawRecord: result.rawRecord,
    });
    return;
  }

  jobFailed.add(true);
  if (result.status === 'no_record') {
    console.log(`OCR_CONFIDENCE file=${doc.path} doc_type=${doc.docType} job_id=${result.jobId} score=NONE (no scored record — likely skipped, e.g. missing required field)`);
  } else if (result.status === 'no_score_field') {
    console.warn(`OCR_CONFIDENCE file=${doc.path} doc_type=${doc.docType} job_id=${result.jobId} score=MISSING (confident_score not found on record)`);
  } else if (result.status !== 'timeout') {
    // timeout already logged with poll diagnostics inside runOcrJob()
    console.error(`[ocr-confidence] job ${result.jobId} (${doc.path}) ended with status '${result.status}' — no confidence to record`);
  }
  emitReportRow({
    doc, jobId: result.jobId, status: result.status, rawRecord: result.rawRecord,
    lastSeenStatus: result.lastSeenStatus, lastHttpStatus: result.lastHttpStatus,
    pollCount: result.pollCount, non200Count: result.non200Count,
  });
}

export default function () {
  // One VU = one document, running concurrently with every other VU (see
  // the maxDuration/scenario comment above for why) — not a sequential loop.
  const doc = DOCUMENTS[(__VU - 1) % DOCUMENTS.length];

  group(`doc_${doc.name}`, () => {
    let minIoKey = null, fname = doc.name;

    group('upload', () => {
      const fd = { file: http.file(doc.bin, doc.name, guessMime(doc.name)), createBy: CREATED, dokumen: doc.dokumen, version_dokumen: 'v1.0' };
      const res = http.post(`${DS}/api/v1/upload/file`, fd, { headers: headers(), tags: { hop: 'upload' }, timeout: '120s' });
      if (res.status < 200 || res.status >= 300) {
        console.error(`[ocr-confidence] upload/file failed for ${doc.path}: ${res.status} ${String(res.body).slice(0, 200)}`);
        return;
      }
      try {
        const d = res.json();
        minIoKey = pick(d, ['data.min_io_key', 'data.minio_key', 'data.key', 'data.path', 'min_io_key']);
        fname = pick(d, ['data.filename', 'data.file_name', 'filename']) || doc.name;
      } catch (_) {}
    });
    if (!minIoKey) { jobFailed.add(true); emitReportRow({ doc, jobId: null, status: 'upload_failed' }); return; }

    if (doc.docType === 'auto') {
      console.log(`[ocr-confidence] ${doc.path} -> uploaded (min_io_key=${minIoKey}), auto-detecting doc_type (3 attempts)...`);
      runAutoDetect(doc, minIoKey, fname);
    } else {
      console.log(`[ocr-confidence] ${doc.path} -> uploaded (min_io_key=${minIoKey}), doc_type=${doc.docType}, polling up to ${MAX_WAIT}s...`);
      const result = runOcrJob(doc, doc.docType, minIoKey, fname);
      handleSingleTypeResult(doc, result);
    }
  });
}

export const handleSummary = makeSummary('confidence');
