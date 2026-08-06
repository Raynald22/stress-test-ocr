// OCR service stress test — QA-run, no repo code needed.
//
// Models the service's ASYNC contract: one iteration = submit one job
// (POST /ocr/create) then poll GET /ocr/getData/{job_id} until the job reaches
// a terminal state (SUCCESS / FAILED). What we measure is the *end-to-end job
// completion time* and the failure rate under sustained submission — not raw
// HTTP throughput, because the real bottleneck is the OCR+LLM worker, not the
// API server.
//
// Run:
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-ocr \
//          -e AUTH_TOKEN=xxxxx \
//          -e MODE=arrival -e SUBMIT_RATE=6 -e DURATION=10m \
//          ocr_stress.js
//
// keys.json (produced by seed_min_io_keys.py) must sit next to this file.
// See README.md for the full runbook.

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { makeSummary } from './summary.js';

// Saves a timestamped report into ./results/ when the run finishes.
export const handleSummary = makeSummary('load');

// ---- config (all overridable via -e ENV=...) --------------------------------
const BASE_URL   = (__ENV.BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const MODE       = __ENV.MODE || 'arrival';          // 'arrival' (open) | 'vus' (closed)
const DURATION   = __ENV.DURATION || '5m';
const SUBMIT_RATE = Number(__ENV.SUBMIT_RATE || 6);  // jobs submitted per SUBMIT_UNIT
const SUBMIT_UNIT = __ENV.SUBMIT_UNIT || '1m';       // ...per this window
const VUS         = Number(__ENV.VUS || 5);          // closed-model concurrency
const MAX_VUS     = Number(__ENV.MAX_VUS || 50);     // ceiling for arrival model
const FILES_PER_JOB = Number(__ENV.FILES_PER_JOB || 1);
const POLL_INTERVAL_S = Number(__ENV.POLL_INTERVAL_S || 3);
const MAX_WAIT_S      = Number(__ENV.MAX_WAIT_S || 300); // give up polling a job after this
// p95 end-to-end budget (ms) and max acceptable job failure rate — tune to SLO.
const P95_E2E_MS   = Number(__ENV.P95_E2E_MS || 180000);
const MAX_FAIL_PCT = Number(__ENV.MAX_FAIL_PCT || 0.05);

// ---- test data --------------------------------------------------------------
// Each entry: { filename, min_io_key, doc_type }  (doc_type ∈ invoice|packing_list|bill_of_lading)
const KEYS = new SharedArray('min_io_keys', () => JSON.parse(open('./keys.json')));

// ---- custom metrics ---------------------------------------------------------
const jobE2E        = new Trend('ocr_job_e2e_ms', true);      // submit -> terminal
const submitLatency = new Trend('ocr_submit_ms', true);       // POST /ocr/create only
const jobFailed     = new Rate('ocr_job_failed');             // FAILED or timed-out
const jobsSubmitted = new Counter('ocr_jobs_submitted');
const jobsDone      = new Counter('ocr_jobs_completed');
const pollCount     = new Trend('ocr_polls_per_job');

// ---- scenarios --------------------------------------------------------------
const scenarios = MODE === 'vus'
  ? {                                   // closed model: N users looping submit->wait
      closed: {
        executor: 'constant-vus',
        vus: VUS,
        duration: DURATION,
      },
    }
  : {                                   // open model: submit at a fixed rate regardless
      arrival: {                        // of completion — this is what surfaces backpressure
        executor: 'constant-arrival-rate',
        rate: SUBMIT_RATE,
        timeUnit: SUBMIT_UNIT,
        duration: DURATION,
        preAllocatedVUs: Math.min(MAX_VUS, VUS * 2),
        maxVUs: MAX_VUS,
      },
    };

export const options = {
  scenarios,
  thresholds: {
    ocr_job_e2e_ms: [`p(95)<${P95_E2E_MS}`],
    ocr_job_failed: [`rate<${MAX_FAIL_PCT}`],
    http_req_failed: ['rate<0.10'],     // transport/5xx level, separate from job outcome
  },
};

// ---- helpers ----------------------------------------------------------------
function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

// Group N keys into the {invoices, packing_lists, bill_of_lading} body shape.
function buildBody(keys) {
  const body = { invoices: [], packing_lists: [], bill_of_lading: [] };
  const groupOf = { invoice: 'invoices', packing_list: 'packing_lists', bill_of_lading: 'bill_of_lading' };
  for (const k of keys) {
    const g = groupOf[k.doc_type] || 'invoices';
    body[g].push({ filename: k.filename, min_io_key: k.min_io_key });
  }
  return body;
}

// ---- one job = one iteration ------------------------------------------------
export default function () {
  const keys = [];
  for (let i = 0; i < FILES_PER_JOB; i++) keys.push(randomItem(KEYS));

  let jobId = null;

  group('submit', () => {
    const res = http.post(`${BASE_URL}/ocr/create`, JSON.stringify(buildBody(keys)),
      { headers: headers(), tags: { name: 'ocr_create' } });
    submitLatency.add(res.timings.duration);
    jobsSubmitted.add(1);

    const ok = check(res, {
      'create -> 202': (r) => r.status === 202,
      'create returns job_id': (r) => {
        try { return !!r.json('data.job_id'); } catch (_) { return false; }
      },
    });
    if (ok) jobId = res.json('data.job_id');
  });

  if (!jobId) {                 // couldn't even queue the job -> count as failed, move on
    jobFailed.add(true);
    return;
  }

  group('poll', () => {
    const start = Date.now();
    let polls = 0;
    let terminal = null;        // 'SUCCESS' | 'FAILED' | null(=timeout)

    while ((Date.now() - start) / 1000 < MAX_WAIT_S) {
      sleep(POLL_INTERVAL_S);
      polls++;
      const res = http.get(`${BASE_URL}/ocr/getData/${jobId}`,
        { headers: headers(), tags: { name: 'ocr_getData' } });
      if (res.status !== 200) continue;   // transient; keep polling

      let status;
      try { status = res.json('data.status'); } catch (_) { continue; }
      if (status === 'SUCCESS' || status === 'FAILED') { terminal = status; break; }
    }

    const elapsed = Date.now() - start;
    pollCount.add(polls);
    jobE2E.add(elapsed);
    jobsDone.add(1);

    const failed = terminal !== 'SUCCESS';   // FAILED or polling timeout both count
    jobFailed.add(failed);
    check(terminal, {
      'job reached SUCCESS': (t) => t === 'SUCCESS',
      'job did not time out': (t) => t !== null,
    });
  });
}
