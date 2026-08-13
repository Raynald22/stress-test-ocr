// Correctness + business-rule check using a VALID, ground-truth-known
// invoice — not a malformed file. Two things smoke.js's generic "non-empty"
// check can't verify:
//
//   1. Correctness: does the extracted result actually contain the known
//      invoice number / total, or just *something* non-empty?
//   2. EXTRACTION_MAX_ITEMS=15 (ocr-service/.env): the invoice here has 30
//      line items. Does the service cap extraction at 15 without crashing/
//      hanging (the chunked-extraction loop-guard), or does something break?
//
// Prereq: seed the ground-truth file first, which writes keys_limits.json:
//   python seed_min_io_keys.py --limits --endpoint MINIO:9000 \
//          --access-key KEY --secret-key SECRET --bucket ocr
//
// Run:
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-ocr \
//          -e AUTH_TOKEN=xxxxx limits.js
//
// We don't know the service's exact result schema for invoice items (field
// names are the service's business), so checks here are schema-agnostic:
// search the whole extracted `result` tree for the known strings, and find
// the largest array in it as a best-effort guess at "the items list".

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('limits');

const BASE_URL   = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-ocr').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const MAX_WAIT_S = Number(__ENV.MAX_WAIT_S || 300);
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 3);

const ENTRY = new SharedArray('limits_key', () => JSON.parse(open('./keys_limits.json')))[0];

export const options = { vus: 1, iterations: 1 };

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

function deepFindString(obj, needle, seen = new Set()) {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === 'string') return obj.includes(needle);
  if (typeof obj === 'number') return String(obj).includes(needle);
  if (typeof obj !== 'object') return false;
  if (seen.has(obj)) return false;
  seen.add(obj);
  const values = Array.isArray(obj) ? obj : Object.values(obj);
  return values.some((v) => deepFindString(v, needle, seen));
}

// Best-effort guess at "the items array": the largest array anywhere in the
// extracted result tree. Not exact (a schema could have other large arrays),
// but good enough to flag if the item cap is obviously not being enforced.
function deepFindLargestArray(obj, best = { len: -1 }, seen = new Set()) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return best;
  if (seen.has(obj)) return best;
  seen.add(obj);
  if (Array.isArray(obj)) {
    if (obj.length > best.len) best.len = obj.length;
    obj.forEach((v) => deepFindLargestArray(v, best, seen));
  } else {
    Object.values(obj).forEach((v) => deepFindLargestArray(v, best, seen));
  }
  return best;
}

export default function () {
  const groupOf = { invoice: 'invoices', packing_list: 'packing_lists', bill_of_lading: 'bill_of_lading' };
  const body = { invoices: [], packing_lists: [], bill_of_lading: [] };
  body[groupOf[ENTRY.doc_type] || 'invoices'].push({ filename: ENTRY.filename, min_io_key: ENTRY.min_io_key });

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
    if (res.status !== 200) continue;
    try { status = res.json('data.status'); } catch (_) { continue; }
    if (status === 'SUCCESS' || status === 'FAILED') { finalData = res.json('data'); break; }
  }

  check(status, { 'job reached SUCCESS (not hang, not FAILED)': (s) => s === 'SUCCESS' });

  if (status !== 'SUCCESS') {
    console.error(`job ended ${status ?? 'TIMEOUT'} — cannot check correctness/limits. data=${JSON.stringify(finalData)}`);
    return;
  }

  const result = finalData && 'result' in finalData ? finalData.result : finalData;
  const exp = ENTRY.expected;

  const foundInvoiceNumber = deepFindString(result, exp.invoice_number);
  const foundTotal = deepFindString(result, exp.total);
  check(null, {
    'extracted result contains known invoice_number (correctness)': () => foundInvoiceNumber,
    'extracted result contains known total (correctness)': () => foundTotal,
  });
  if (!foundInvoiceNumber || !foundTotal) {
    console.error(`  CORRECTNESS MISMATCH: expected invoice_number=${exp.invoice_number} `
      + `(found=${foundInvoiceNumber}), total=${exp.total} (found=${foundTotal}). `
      + `result=${JSON.stringify(result)}`);
  }

  const largest = deepFindLargestArray(result);
  console.log(`largest array found in result: length=${largest.len} `
    + `(generated ${exp.item_count_generated} items, cap is ${exp.item_count_max_allowed})`);
  if (largest.len < 0) {
    console.error('  WARNING: no array found anywhere in result — cannot verify '
      + 'EXTRACTION_MAX_ITEMS is being enforced. Inspect result manually.');
  } else {
    check(largest.len, {
      [`item array length (${largest.len}) does not exceed EXTRACTION_MAX_ITEMS (${exp.item_count_max_allowed})`]:
        (n) => n <= exp.item_count_max_allowed,
    });
  }

  console.log(`done in ${((Date.now() - start) / 1000).toFixed(1)}s — final status=${status}`);
}
