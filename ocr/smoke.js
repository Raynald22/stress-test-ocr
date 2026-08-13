// Single-job end-to-end smoke test. Run this FIRST, before ocr_stress.js, to
// confirm the target env + your keys.json actually work (right URL, auth,
// min_io_keys really exist in MinIO, worker is consuming). If this fails, the
// load run will just be a wall of red — fix the smoke first.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-ocr \
//          -e AUTH_TOKEN=xxxxx smoke.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('smoke');

const BASE_URL   = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-ocr').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const MAX_WAIT_S = Number(__ENV.MAX_WAIT_S || 300);
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 3);

const KEYS = new SharedArray('min_io_keys', () => JSON.parse(open('./keys.json')));

export const options = { vus: 1, iterations: 1 };

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

// Job metadata keys we expect on every getData response regardless of doc
// type. Confirmed against the real server response (2026-08-13): a job can
// end status=SUCCESS while still carrying a non-empty `errors` array and an
// empty `result` (e.g. EMPTY_DOCUMENT — "no readable text"). So `errors`,
// `error`, and `result` need explicit handling, not just "any non-meta field
// counts as content" — that heuristic would have been fooled by `errors`
// being present and non-empty.
const META_FIELDS = new Set([
  'status', 'progress', 'job_id', 'doc_type', 'filename', 'stage',
  'document_index', 'document_total', 'current_file', 'document_count',
  'processing_time_ms', 'created_at', 'updated_at', 'min_io_key', 'message',
]);
function hasExtractedContent(data) {
  if (!data || typeof data !== 'object') return false;
  // Explicit per-document failure signal takes priority: a non-empty
  // `errors` array means at least one document did NOT get extracted,
  // regardless of what the top-level `status` says.
  if (Array.isArray(data.errors) && data.errors.length > 0) return false;
  if (data.error) return false;
  // `result` is where the actual extracted fields live; prefer it when
  // present, but fall back to the generic scan for older/other doc-type
  // shapes that may not use a `result` wrapper.
  if ('result' in data) {
    const r = data.result;
    if (r === null || r === undefined) return false;
    if (typeof r === 'object') return Object.keys(r).length > 0;
  }
  return Object.keys(data).some((k) => {
    if (META_FIELDS.has(k) || k === 'result' || k === 'errors') return false;
    const v = data[k];
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true; // number/bool present counts as content
  });
}

export default function () {
  // health first
  const health = http.get(`${BASE_URL}/health`, { headers: headers() });
  check(health, { 'GET /health -> 200': (r) => r.status === 200 });

  const k = KEYS[0];
  const groupOf = { invoice: 'invoices', packing_list: 'packing_lists', bill_of_lading: 'bill_of_lading' };
  const body = { invoices: [], packing_lists: [], bill_of_lading: [] };
  body[groupOf[k.doc_type] || 'invoices'].push({ filename: k.filename, min_io_key: k.min_io_key });

  const create = http.post(`${BASE_URL}/ocr/create`, JSON.stringify(body), { headers: headers() });
  const ok = check(create, {
    'POST /ocr/create -> 202': (r) => r.status === 202,
    'has job_id': (r) => { try { return !!r.json('data.job_id'); } catch (_) { return false; } },
  });
  if (!ok) { console.error(`create failed: ${create.status} ${create.body}`); return; }

  const jobId = create.json('data.job_id');
  console.log(`job_id=${jobId} — polling up to ${MAX_WAIT_S}s...`);

  const start = Date.now();
  let status = null;
  let finalData = null;
  while ((Date.now() - start) / 1000 < MAX_WAIT_S) {
    sleep(POLL_INTERVAL_S);
    const res = http.get(`${BASE_URL}/ocr/getData/${jobId}`, { headers: headers() });
    if (res.status !== 200) { console.log(`  getData -> ${res.status}`); continue; }
    status = res.json('data.status');
    const progress = res.json('data.progress');
    console.log(`  status=${status} progress=${progress}`);
    if (status === 'SUCCESS' || status === 'FAILED') { finalData = res.json('data'); break; }
  }

  check(status, { 'job reached SUCCESS': (s) => s === 'SUCCESS' });

  // "SUCCESS" only means the pipeline didn't error — it doesn't mean the OCR
  // actually read anything useful off the page. Flag the empty-result case
  // separately since it's the kind of silent failure a plain status check
  // would miss.
  if (status === 'SUCCESS') {
    const extracted = hasExtractedContent(finalData);
    check(extracted, { 'SUCCESS job has non-empty extracted data': () => extracted });
    if (!extracted) {
      console.error(`  WARNING: job ${jobId} ended SUCCESS but no extracted fields `
        + `were found beyond job metadata — check the response schema/content `
        + `manually. data=${JSON.stringify(finalData)}`);
    }
  }

  console.log(`done in ${((Date.now() - start) / 1000).toFixed(1)}s — final status=${status}`);
}
