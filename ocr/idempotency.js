// Idempotency / duplicate-submission check — submits the SAME min_io_key as
// two back-to-back jobs and confirms the service handles it gracefully: no
// 500s, no hang. This does NOT assert a specific dedupe policy (we don't
// know if the service is supposed to dedupe or not) — it only asserts that
// duplicate submission degrades gracefully either way, and surfaces whether
// the two calls got the same job_id or two independent ones so QA can flag
// it if that looks wrong.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-ocr \
//          -e AUTH_TOKEN=xxxxx idempotency.js
//
// keys.json (produced by seed_min_io_keys.py) must sit next to this file.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('idempotency');

const BASE_URL   = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-ocr').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const MAX_WAIT_S = Number(__ENV.MAX_WAIT_S || 300);
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 3);

const KEYS = new SharedArray('min_io_keys', () => JSON.parse(open('./keys.json')));

export const options = { vus: 1, iterations: 1, thresholds: { checks: ['rate>0.9'] } };

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

function submit(k) {
  const groupOf = { invoice: 'invoices', packing_list: 'packing_lists', bill_of_lading: 'bill_of_lading' };
  const body = { invoices: [], packing_lists: [], bill_of_lading: [] };
  body[groupOf[k.doc_type] || 'invoices'].push({ filename: k.filename, min_io_key: k.min_io_key });
  return http.post(`${BASE_URL}/ocr/create`, JSON.stringify(body), { headers: headers() });
}

function pollTerminal(jobId) {
  const start = Date.now();
  let status = null;
  while ((Date.now() - start) / 1000 < MAX_WAIT_S) {
    sleep(POLL_INTERVAL_S);
    const res = http.get(`${BASE_URL}/ocr/getData/${jobId}`, { headers: headers() });
    if (res.status !== 200) continue;
    try { status = res.json('data.status'); } catch (_) { continue; }
    if (status === 'SUCCESS' || status === 'FAILED') break;
  }
  return status;
}

export default function () {
  const k = KEYS[0];

  // fire twice, back-to-back, same min_io_key — no delay between them
  const r1 = submit(k);
  const r2 = submit(k);

  check(r1, { 'submission 1 -> not 5xx': (r) => r.status < 500 });
  check(r2, { 'submission 2 (duplicate) -> not 5xx': (r) => r.status < 500 });

  const accepted1 = r1.status === 202;
  const accepted2 = r2.status === 202;
  check(null, { 'at least one duplicate submission accepted': () => accepted1 || accepted2 });

  if (!accepted1 && !accepted2) {
    console.error(`both submissions rejected: r1=${r1.status} ${r1.body} r2=${r2.status} ${r2.body}`);
    return;
  }

  let id1 = null, id2 = null;
  try { id1 = accepted1 ? r1.json('data.job_id') : null; } catch (_) { /* leave null */ }
  try { id2 = accepted2 ? r2.json('data.job_id') : null; } catch (_) { /* leave null */ }

  const deduped = id1 && id2 && id1 === id2;
  console.log(`job_id[1]=${id1} job_id[2]=${id2} `
    + `(${deduped ? 'server deduped to the same job' : 'processed as separate jobs'})`);

  // Poll whichever job id(s) we got — must reach a terminal state, not hang,
  // regardless of whether the service deduped them into one job or ran two.
  const ids = [...new Set([id1, id2].filter(Boolean))];
  for (const id of ids) {
    const status = pollTerminal(id);
    check(status, { [`job ${id} reached terminal state (no hang)`]: (s) => s === 'SUCCESS' || s === 'FAILED' });
    console.log(`  job ${id} -> ${status ?? 'TIMEOUT/HANG'}`);
  }

  console.log('NOTE: this only checks client-visible behaviour (no 500s, no hang). '
    + 'If the duplicate submissions produced two independent jobs, ask dev/ops to '
    + 'also check the DB for duplicate rows referencing the same min_io_key.');
}
