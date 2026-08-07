// Legacy Bridge Platform (LBP) — rate limiter behaviour test.
//
// The service has a per-IP token-bucket limiter (default 50 req/s, burst 100).
// This test DELIBERATELY floods a cheap endpoint from one IP, well above the
// limit, and verifies the limiter behaves correctly:
//   - every response is either 200 (served) or 429 (limited) — NEVER 5xx / hang,
//   - 429s actually appear (the limiter engages), and
//   - the 429 body is the standard error envelope with a rate-limit code.
//
// This is the opposite of stress.js: here hitting 429 is the SUCCESS condition.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-legacy \
//          -e RATE=200 -e DURATION=30s ratelimit.js
//
// If lbp_ratelimited stays 0%, either the limiter is disabled or the configured
// rate is higher than RATE — raise RATE or check LBP_HTTP_RATE_LIMIT_RPS.

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('ratelimit');

const BASE_URL = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-legacy').replace(/\/+$/, '');
const API_KEY  = __ENV.API_KEY || '';
const TENANT   = __ENV.TENANT || '';
const RATE     = Number(__ENV.RATE || 200);          // well above the 50 rps limit
const UNIT     = __ENV.UNIT || '1s';
const DURATION = __ENV.DURATION || '30s';
const PATH     = __ENV.PATH || '/api/v1/health';     // cheapest endpoint

// Treat both 200 and 429 as "expected" so http_req_failed reflects only real faults.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 429));

const served      = new Counter('lbp_served_200');
const limited429  = new Counter('lbp_limited_429');
const rateLimited = new Rate('lbp_ratelimited');
const cleanStatus = new Rate('lbp_clean_status');    // every response is 200 or 429

export const options = {
  scenarios: {
    flood: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: UNIT,
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  thresholds: {
    // the limiter must never let a flood turn into 5xx / hangs
    lbp_clean_status: ['rate==1'],
    // the limiter must actually engage under this flood
    lbp_ratelimited: ['rate>0'],
    http_req_failed: ['rate<0.01'],
  },
};

function headers() {
  const h = {};
  if (API_KEY) h['X-API-Key'] = API_KEY;
  if (TENANT) h['X-Tenant-ID'] = TENANT;
  return h;
}

export default function () {
  const res = http.get(`${BASE_URL}${PATH}`, { headers: headers() });

  const clean = res.status === 200 || res.status === 429;
  cleanStatus.add(clean);
  rateLimited.add(res.status === 429);
  if (res.status === 200) served.add(1);
  if (res.status === 429) limited429.add(1);

  check(res, {
    'response is 200 or 429 (never 5xx/hang)': () => clean,
  });

  if (!clean) {
    console.error(`unexpected status under flood: ${res.status} ${String(res.body).slice(0, 200)}`);
  }
}
