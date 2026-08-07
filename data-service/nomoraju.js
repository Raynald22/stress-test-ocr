// LNSW Data Service — generateNomorAju concurrency test.
//
// POST /pengajuan/generateNomorAju uses a Postgres sequence + advisory lock to
// hand out a unique 26-digit nomorAju. This test slams it with many concurrent
// callers and checks the lock behaves: every call succeeds (2xx), returns a
// nomorAju, nothing 5xx / times out, and latency stays bounded even while
// requests queue on the advisory lock.
//
// DUPLICATE CHECK (the important one): each success logs `NOMORAJU=<value>`.
// After the run, any duplicate = the lock failed to serialize = BUG:
//
//   k6 run nomoraju.js 2>&1 | grep -o 'NOMORAJU=[0-9]*' | sort | uniq -d
//   # ^ prints nothing if all unique (good); prints the dup value(s) if not.
//
// NOTE: each call burns a sequence value (and may create/reserve data depending
// on service impl) — dev/throwaway env only.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-data-service \
//          -e VUS=30 -e DURATION=20s nomoraju.js

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('nomoraju');

const BASE_URL = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-data-service').replace(/\/+$/, '');
const API_KEY  = __ENV.API_KEY || '';
const VUS      = Number(__ENV.VUS || 30);
const DURATION = __ENV.DURATION || '20s';
const P95_MS       = Number(__ENV.P95_MS || 2000);
const MAX_FAIL_PCT = Number(__ENV.MAX_FAIL_PCT || 0.01);

const TARGETS = new SharedArray('targets', () => [JSON.parse(open('./targets.json'))])[0];
const PATH = (TARGETS.nomoraju && TARGETS.nomoraju.path) || '/api/v1/pengajuan/generateNomorAju';

const latency  = new Trend('nomoraju_ms', true);
const failed   = new Rate('nomoraju_failed');
const issued   = new Counter('nomoraju_issued');

export const options = {
  scenarios: {
    burst: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  thresholds: {
    nomoraju_ms: [`p(95)<${P95_MS}`],
    nomoraju_failed: [`rate<${MAX_FAIL_PCT}`],
    http_req_failed: ['rate<0.05'],
  },
};

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (API_KEY) h['API-KEY'] = API_KEY;
  return h;
}

export default function () {
  const res = http.post(`${BASE_URL}${PATH}`, null, { headers: headers(), tags: { name: 'generateNomorAju' } });
  latency.add(res.timings.duration);

  let nomor = null;
  try { nomor = res.json('data.nomorAju'); } catch (_) { /* ignore */ }

  const ok = check(res, {
    'generateNomorAju -> 2xx': (r) => r.status >= 200 && r.status < 300,
    'returned a nomorAju': () => typeof nomor === 'string' && nomor.length > 0,
    'not 5xx': (r) => r.status < 500,
  });
  failed.add(!ok);

  if (nomor) {
    issued.add(1);
    // logged so a post-run `grep | sort | uniq -d` can detect any collision
    console.log(`NOMORAJU=${nomor}`);
  } else if (res.status >= 500) {
    console.error(`generateNomorAju ${res.status}: ${String(res.body).slice(0, 200)}`);
  }
}
