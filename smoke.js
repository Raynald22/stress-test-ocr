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

const BASE_URL   = (__ENV.BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
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
  while ((Date.now() - start) / 1000 < MAX_WAIT_S) {
    sleep(POLL_INTERVAL_S);
    const res = http.get(`${BASE_URL}/ocr/getData/${jobId}`, { headers: headers() });
    if (res.status !== 200) { console.log(`  getData -> ${res.status}`); continue; }
    status = res.json('data.status');
    const progress = res.json('data.progress');
    console.log(`  status=${status} progress=${progress}`);
    if (status === 'SUCCESS' || status === 'FAILED') break;
  }

  check(status, { 'job reached SUCCESS': (s) => s === 'SUCCESS' });
  console.log(`done in ${((Date.now() - start) / 1000).toFixed(1)}s — final status=${status}`);
}
