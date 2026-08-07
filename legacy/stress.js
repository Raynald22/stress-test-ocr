// Legacy Bridge Platform (LBP) stress test — QA-run.
//
// Mostly-synchronous endpoints, so this is a latency + throughput test. BUT the
// service has a built-in PER-IP RATE LIMITER (default 50 req/s, burst 100). From
// one k6 box (= one IP), anything sustained above ~50 rps starts returning 429.
// That is the limiter working, NOT the server failing — so this script:
//   - counts 429s separately (lbp_ratelimited) and does NOT treat them as errors,
//   - measures latency only over the requests that actually got served (2xx),
//   - defaults RATE below the limit so you measure real latency out of the box.
// Raise RATE past 50 on purpose to find/confirm the limit (429s will climb).
// To test the limiter itself, use ratelimit.js instead.
//
// Modes (-e MODE=...):
//   kirim    (default) — POST /kirimData (pengajuan validation)
//   vt                 — POST /scanners/vt/execute (VT scan of the payload)
//   xml2json           — POST /transform/xml-to-json
//   json2xml           — POST /transform/json-to-xml
//   health             — GET /health (cheapest; baseline / warm-up)
//
// Run:
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-legacy \
//          -e MODE=kirim -e RATE=40 -e UNIT=1s -e DURATION=3m stress.js
//
// Samples: ./samples/pengajuan.json, ./samples/sample.xml

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('load');

const BASE_URL = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-legacy').replace(/\/+$/, '');
const API_KEY  = __ENV.API_KEY || '';
const TENANT   = __ENV.TENANT || '';
const MODE     = __ENV.MODE || 'kirim';
const DURATION = __ENV.DURATION || '3m';
const RATE     = Number(__ENV.RATE || 40);           // default under the 50 rps limiter
const UNIT     = __ENV.UNIT || '1s';
const MAX_VUS  = Number(__ENV.MAX_VUS || 80);
const PRE_VUS  = Number(__ENV.PRE_VUS || Math.min(MAX_VUS, 20));
const P95_MS       = Number(__ENV.P95_MS || 800);
const MAX_FAIL_PCT = Number(__ENV.MAX_FAIL_PCT || 0.01);

const PENGAJUAN = open('./samples/pengajuan.json');
const SAMPLE_XML = open('./samples/sample.xml');

// 429 is expected behaviour (the limiter), not a transport failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 429));

const latency     = new Trend('lbp_ms', true);       // over served (2xx) requests
const reqFailed   = new Rate('lbp_req_failed');       // non-2xx AND non-429
const rateLimited = new Rate('lbp_ratelimited');      // share of requests hitting 429
const reqDone     = new Counter('lbp_requests');

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
    lbp_ms: [`p(95)<${P95_MS}`],
    lbp_req_failed: [`rate<${MAX_FAIL_PCT}`],
    http_req_failed: ['rate<0.05'],
  },
};

function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (API_KEY) h['X-API-Key'] = API_KEY;
  if (TENANT) h['X-Tenant-ID'] = TENANT;
  return h;
}

function doRequest() {
  switch (MODE) {
    case 'health':
      return http.get(`${BASE_URL}/api/v1/health`, { headers: headers(), tags: { name: 'health' } });
    case 'vt':
      return http.post(`${BASE_URL}/api/v1/scanners/vt/execute`,
        JSON.stringify({ payload: JSON.parse(PENGAJUAN) }),
        { headers: headers({ 'Content-Type': 'application/json' }), tags: { name: 'vt' } });
    case 'xml2json':
      return http.post(`${BASE_URL}/api/v1/transform/xml-to-json`, SAMPLE_XML,
        { headers: headers({ 'Content-Type': 'application/xml' }), tags: { name: 'xml2json' } });
    case 'json2xml':
      return http.post(`${BASE_URL}/api/v1/transform/json-to-xml`, PENGAJUAN,
        { headers: headers({ 'Content-Type': 'application/json' }), tags: { name: 'json2xml' } });
    case 'kirim':
    default:
      return http.post(`${BASE_URL}/api/v1/kirimData`, PENGAJUAN,
        { headers: headers({ 'Content-Type': 'application/json' }), tags: { name: 'kirim' } });
  }
}

export default function () {
  reqDone.add(1);
  const res = doRequest();

  const limited = res.status === 429;
  rateLimited.add(limited);

  if (limited) {
    // served by the limiter, not the app — don't count as latency or failure
    check(res, { 'rate-limited response is a clean 429': (r) => r.status === 429 });
    return;
  }

  latency.add(res.timings.duration);
  const ok = check(res, { 'served -> 2xx': (r) => r.status >= 200 && r.status < 300 });
  reqFailed.add(!ok);
  if (!ok) console.error(`${MODE} ${res.status}: ${String(res.body).slice(0, 200)}`);
}
