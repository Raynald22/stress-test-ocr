// LNSW Data Service stress test — QA-run.
//
// SYNCHRONOUS service, so this is a classic latency + throughput (req/s) test,
// same family as the HPC suite (not the async OCR one). Uses an open model
// (constant-arrival-rate): requests keep arriving at a fixed rate regardless of
// completion, which is what surfaces the point where latency blows up.
//
// Modes (-e MODE=...):
//   MODE=referensi (default) — hammer GET /referensi/* (Redis-cached). Read-only.
//                Best for finding the cached read ceiling + checking cache pays off.
//   MODE=domain             — hammer GET domain endpoints (pengajuan/barang/...).
//                Read-only, but hits Postgres directly (no cache) — heavier.
//   MODE=review             — hammer GET /review-dan-submit?idPermohonan=<uuid>. Read-only
//                but an aggregate query (statistik kelengkapan across sections).
//                Needs valid idPermohonan UUIDs in targets.json (review_dan_submit.id_permohonans).
//   MODE=bundle             — POST /ssm-impor-api-bundle-post with the sample
//                bundle. HEAVY WRITE (insert across many tables in one tx). This
//                is the path HPC calls. WRITES DATA every request — dev only.
//
// Run:
//   # cached reads: 100 req/s for 5 min
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-data-service \
//          -e MODE=referensi -e RATE=100 -e UNIT=1s -e DURATION=5m stress.js
//
//   # heavy bundle writes: 3 req/s for 3 min (dev only!)
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-data-service \
//          -e MODE=bundle -e RATE=3 -e UNIT=1s -e DURATION=3m stress.js
//
// targets.json (copy of targets.example.json) must sit next to this file.

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('load');

// ---- config -----------------------------------------------------------------
const BASE_URL = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-data-service').replace(/\/+$/, '');
const API_KEY  = __ENV.API_KEY || '';
const MODE     = __ENV.MODE || 'referensi';          // 'referensi' | 'domain' | 'review' | 'bundle'
const DURATION = __ENV.DURATION || '5m';
const RATE     = Number(__ENV.RATE || (MODE === 'bundle' ? 3 : 100));
const UNIT     = __ENV.UNIT || '1s';
const MAX_VUS  = Number(__ENV.MAX_VUS || 150);
const PRE_VUS  = Number(__ENV.PRE_VUS || Math.min(MAX_VUS, 30));
// SLO gates — reads should be fast, bundle writes are heavy. Tune to your target.
const P95_MS       = Number(__ENV.P95_MS || (MODE === 'bundle' ? 8000 : ((MODE === 'domain' || MODE === 'review') ? 1500 : 500)));
const MAX_FAIL_PCT = Number(__ENV.MAX_FAIL_PCT || 0.01);

const TARGETS = new SharedArray('targets', () => [JSON.parse(open('./targets.json'))])[0];
const REFERENSI = TARGETS.referensi_endpoints || [];
const DOMAIN    = TARGETS.domain_endpoints || [];
const REVIEW    = TARGETS.review_dan_submit || {};
const REVIEW_IDS = REVIEW.id_permohonans || [];
const BUNDLE    = TARGETS.bundle || {};
const BUNDLE_BODY = (MODE === 'bundle' && BUNDLE.payload)
  ? new SharedArray('bundle', () => [open(`./${BUNDLE.payload}`)])[0]
  : null;

// ---- metrics ----------------------------------------------------------------
const readLatency  = new Trend('ds_read_ms', true);
const writeLatency = new Trend('ds_write_ms', true);
const reqFailed    = new Rate('ds_req_failed');
const reqDone      = new Counter('ds_requests');

export const options = {
  scenarios: {
    arrival: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: UNIT,
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    [MODE === 'bundle' ? 'ds_write_ms' : 'ds_read_ms']: [`p(95)<${P95_MS}`],
    ds_req_failed: [`rate<${MAX_FAIL_PCT}`],
    http_req_failed: ['rate<0.05'],
  },
};

function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (API_KEY) h['API-KEY'] = API_KEY;
  return h;
}

export default function () {
  reqDone.add(1);

  if (MODE === 'bundle') {
    if (!BUNDLE_BODY) {
      console.error('MODE=bundle but no bundle.payload in targets.json');
      reqFailed.add(true);
      return;
    }
    const res = http.post(`${BASE_URL}${BUNDLE.path}`, BUNDLE_BODY,
      { headers: headers({ 'Content-Type': 'application/json' }), tags: { name: 'bundle_post' } });
    writeLatency.add(res.timings.duration);
    const ok = check(res, { 'bundle POST -> 2xx': (r) => r.status >= 200 && r.status < 300 });
    reqFailed.add(!ok);
    if (!ok) console.error(`bundle POST ${res.status}: ${String(res.body).slice(0, 200)}`);
    return;
  }

  // review mode: GET /review-dan-submit?idPermohonan=<valid uuid> (endpoint requires it)
  if (MODE === 'review') {
    if (REVIEW_IDS.length === 0) {
      console.error('MODE=review needs review_dan_submit.id_permohonans in targets.json (valid idPermohonan UUIDs from dev)');
      reqFailed.add(true);
      return;
    }
    const id = randomItem(REVIEW_IDS);
    const res = http.get(`${BASE_URL}${REVIEW.path || '/api/v1/review-dan-submit'}?idPermohonan=${id}`,
      { headers: headers(), tags: { name: 'review' } });
    readLatency.add(res.timings.duration);
    const ok = check(res, {
      'review -> 200': (r) => r.status === 200,
      'review has success:true': (r) => { try { return r.json('success') === true; } catch (_) { return false; } },
    });
    reqFailed.add(!ok);
    if (!ok) console.error(`review idPermohonan=${id} -> ${res.status}: ${String(res.body).slice(0, 200)}`);
    return;
  }

  const pool = MODE === 'domain' ? DOMAIN : REFERENSI;
  if (pool.length === 0) {
    console.error(`no ${MODE}_endpoints in targets.json`);
    reqFailed.add(true);
    return;
  }
  const path = randomItem(pool);
  const res = http.get(`${BASE_URL}${path}`,
    { headers: headers(), tags: { name: MODE } });
  readLatency.add(res.timings.duration);
  const ok = check(res, {
    'GET -> 200': (r) => r.status === 200,
    'has success:true': (r) => {
      try { return r.json('success') === true; } catch (_) { return false; }
    },
  });
  reqFailed.add(!ok);
}
