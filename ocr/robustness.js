// Robustness test — feeds MALFORMED files through the real pipeline and checks
// the service degrades *gracefully*. A broken PDF must end as a terminal job
// (FAILED, ideally) with the service still responsive — never a hang, never a
// crashed worker, never a job stuck in PROCESSING forever.
//
// Prereq: seed the bad corpus first, which writes keys_bad.json:
//   python seed_min_io_keys.py --bad --endpoint MINIO:9000 \
//          --access-key KEY --secret-key SECRET --bucket ocr
//
// Run:
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-ocr \
//          -e AUTH_TOKEN=xxxxx robustness.js
//
// Each entry in keys_bad.json is submitted as one job. We assert per-file that
// the job REACHED A TERMINAL STATE within MAX_WAIT (i.e. did not hang). We also
// report how each defect resolved (FAILED vs SUCCESS vs TIMEOUT) so QA can spot
// anything that silently "succeeded" on garbage — a red flag worth a bug.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('robustness');

const BASE_URL   = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-ocr').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const MAX_WAIT_S = Number(__ENV.MAX_WAIT_S || 300);
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 3);

const BAD = new SharedArray('bad_files', () => JSON.parse(open('./keys_bad.json')));

// one iteration per bad file
export const options = {
  scenarios: {
    robustness: { executor: 'per-vu-iterations', vus: 1, iterations: BAD.length, maxDuration: '1h' },
  },
  thresholds: {
    // the hard rule: nothing may hang. Every job must reach a terminal state.
    robustness_hang: ['rate<0.01'],
  },
};

const hangRate      = new Rate('robustness_hang');          // job never reached terminal
const gracefulFail  = new Counter('robustness_failed');     // ended FAILED (expected)
const suspectPass   = new Counter('robustness_success');    // ended SUCCESS on junk (suspicious)
// A job can end status=SUCCESS while still carrying a non-empty per-document
// `errors` array and an empty `result` (confirmed against the real server,
// e.g. EMPTY_DOCUMENT — "no readable text"). That's the service correctly
// detecting the problem internally but not surfacing it as a terminal
// FAILED — split that out from a genuine "SUCCESS on garbage" case.
const successNoErrors = new Counter('robustness_success_clean');   // SUCCESS, no errors array — genuinely suspicious
const successWithErrors = new Counter('robustness_success_flagged'); // SUCCESS, but errors[] present — status/errors mismatch

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

export default function () {
  const f = BAD[__ITER % BAD.length];
  const groupOf = { invoice: 'invoices', packing_list: 'packing_lists', bill_of_lading: 'bill_of_lading' };
  const body = { invoices: [], packing_lists: [], bill_of_lading: [] };
  body[groupOf[f.doc_type] || 'invoices'].push({ filename: f.filename, min_io_key: f.min_io_key });

  const create = http.post(`${BASE_URL}/ocr/create`, JSON.stringify(body), { headers: headers() });
  // create should still be accepted (202) — extension + blob exist; the file is
  // only "bad" on the inside, which the worker discovers.
  check(create, { [`[${f.defect}] create accepted or cleanly rejected`]: (r) => r.status === 202 || r.status >= 400 });
  if (create.status !== 202) { return; }  // cleanly rejected at the door — fine

  let jobId;
  try { jobId = create.json('data.job_id'); } catch (_) { return; }

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

  const hung = (status !== 'SUCCESS' && status !== 'FAILED');
  hangRate.add(hung);
  if (status === 'FAILED') gracefulFail.add(1);

  let note = '';
  if (status === 'SUCCESS') {
    suspectPass.add(1);
    const hasErrors = finalData && Array.isArray(finalData.errors) && finalData.errors.length > 0;
    if (hasErrors) {
      successWithErrors.add(1);
      note = ` (errors[]: ${finalData.errors.map((e) => e.code).join(',')} — status/errors mismatch)`;
    } else {
      successNoErrors.add(1);
      note = ' (no errors[] at all — genuinely suspicious)';
    }
  }

  check(status, {
    [`[${f.defect}] reached terminal state (no hang)`]: (s) => s === 'SUCCESS' || s === 'FAILED',
  });
  console.log(`  ${f.defect.padEnd(22)} -> ${hung ? 'HANG/TIMEOUT ⚠' : status}${note}`);
}
