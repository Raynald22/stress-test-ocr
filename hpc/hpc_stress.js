// HPC service stress test — QA-run, no repo code needed.
//
// The HPC API is SYNCHRONOUS: one HTTP request returns the full result. So
// UNLIKE the OCR suite (which measures end-to-end async job time), here we
// measure classic web-service load: request latency (p95) and error rate under
// a sustained arrival rate. This is a real "requests per second" test.
//
// Two modes (-e MODE=...):
//   MODE=read   (default) — hammer the GET list/read endpoints from targets.json.
//                Safe & repeatable: read-only, changes nothing. Use this to find
//                the read throughput ceiling of the API + Postgres.
//   MODE=upload           — hammer POST /excel/upload with a sample .xlsx. This
//                is the HEAVY path (parse Excel -> MinIO write -> DB insert),
//                the HPC analogue of an OCR job. WRITES DATA — only run against a
//                dev/throwaway environment. Needs a real template (see targets).
//
// Run:
//   # read load: 50 req/s for 5 min
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc \
//          -e MODE=read -e RATE=50 -e UNIT=1s -e DURATION=5m hpc_stress.js
//
//   # upload load: 2 uploads/s for 3 min (heavy)
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc \
//          -e MODE=upload -e RATE=2 -e UNIT=1s -e DURATION=3m hpc_stress.js
//
// targets.json (copy of targets.example.json) must sit next to this file.

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('load');

// ---- config (all overridable via -e ENV=...) --------------------------------
const BASE_URL   = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-hpc').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const MODE       = __ENV.MODE || 'read';             // 'read' | 'upload'
const DURATION   = __ENV.DURATION || '5m';
const RATE       = Number(__ENV.RATE || (MODE === 'upload' ? 2 : 50)); // req per UNIT
const UNIT       = __ENV.UNIT || '1s';
const MAX_VUS    = Number(__ENV.MAX_VUS || 100);
const PRE_VUS    = Number(__ENV.PRE_VUS || Math.min(MAX_VUS, 20));
// SLO gates — tune to your target. Reads should be fast; uploads are heavy.
const P95_MS       = Number(__ENV.P95_MS || (MODE === 'upload' ? 10000 : 800));
const MAX_FAIL_PCT = Number(__ENV.MAX_FAIL_PCT || 0.01);

// A 404 is a legitimate answer for a get_by_id probe (record simply absent), so
// don't let those inflate the built-in http_req_failed rate. 2xx/3xx + 404 are
// "expected"; anything else (esp. 5xx) counts as a transport failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 404));

const TARGETS = new SharedArray('targets', () => [JSON.parse(open('./targets.json'))])[0];
const READ_ENDPOINTS = TARGETS.read_endpoints || [];
const GET_BY_ID      = TARGETS.get_by_id || [];
const UPLOAD_CFG     = TARGETS.upload || {};

// Load the sample file once (only needed for upload mode).
const UPLOAD_BIN = (MODE === 'upload' && UPLOAD_CFG.sample_xlsx)
  ? new SharedArray('xlsx', () => [open(`./${UPLOAD_CFG.sample_xlsx}`, 'b')])[0]
  : null;

// ---- custom metrics ---------------------------------------------------------
const readLatency   = new Trend('hpc_read_ms', true);
const uploadLatency = new Trend('hpc_upload_ms', true);
const reqFailed     = new Rate('hpc_req_failed');    // non-2xx (excludes documented 404 on get_by_id)
const reqDone       = new Counter('hpc_requests');

// ---- scenario ---------------------------------------------------------------
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
    [MODE === 'upload' ? 'hpc_upload_ms' : 'hpc_read_ms']: [`p(95)<${P95_MS}`],
    hpc_req_failed: [`rate<${MAX_FAIL_PCT}`],
    http_req_failed: ['rate<0.05'],
  },
};

function headers() {
  const h = {};
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

// ---- one iteration ----------------------------------------------------------
export default function () {
  reqDone.add(1);

  if (MODE === 'upload') {
    if (!UPLOAD_BIN) {
      console.error('MODE=upload but no upload.sample_xlsx in targets.json');
      reqFailed.add(true);
      return;
    }
    const name = UPLOAD_CFG.sample_xlsx.split('/').pop();
    const fd = {
      file: http.file(UPLOAD_BIN, name,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      createdBy: UPLOAD_CFG.created_by || 'qa-loadtest',
      id_rekam: UPLOAD_CFG.id_rekam || 'loadtest',
    };
    const res = http.post(`${BASE_URL}/api/v1/excel/upload`, fd,
      { headers: headers(), tags: { name: 'excel_upload' } });
    uploadLatency.add(res.timings.duration);
    const ok = check(res, { 'upload -> 200': (r) => r.status === 200 });
    reqFailed.add(!ok);
    return;
  }

  // MODE=read — mix of list endpoints and (if provided) get-by-id
  // ~1 in 5 iterations hits a get-by-id target when configured.
  const useById = GET_BY_ID.length > 0 && Math.random() < 0.2;
  if (useById) {
    const t = randomItem(GET_BY_ID);
    const res = http.get(`${BASE_URL}${t.base}/${t.id}`,
      { headers: headers(), tags: { name: 'get_by_id' } });
    readLatency.add(res.timings.duration);
    // 200 (found) and 404 (not found) are BOTH correct behaviour here — only
    // 5xx / timeouts count as failures.
    const ok = check(res, {
      'get_by_id -> 200 or 404': (r) => r.status === 200 || r.status === 404,
    });
    reqFailed.add(!ok);
    return;
  }

  if (READ_ENDPOINTS.length === 0) {
    console.error('no read_endpoints in targets.json');
    reqFailed.add(true);
    return;
  }
  const path = randomItem(READ_ENDPOINTS);
  const res = http.get(`${BASE_URL}${path}`,
    { headers: headers(), tags: { name: 'list' } });
  readLatency.add(res.timings.duration);
  const ok = check(res, {
    'list -> 200': (r) => r.status === 200,
    'list has success:true': (r) => {
      try { return r.json('success') === true; } catch (_) { return false; }
    },
  });
  reqFailed.add(!ok);
}
