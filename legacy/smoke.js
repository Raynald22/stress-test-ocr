// Legacy Bridge Platform (LBP) single-pass smoke test. Run this FIRST.
// Confirms the env is reachable and the response envelope is the LBP shape
// ({data, correlation_id}), using the health checks + one kirimData validation.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-legacy smoke.js
//
// Auth is OFF by default on the service. If LBP_SECURITY_ENABLED=true, pass:
//   -e API_KEY=<key>   (and optionally -e TENANT=<tenant-code>)
//
// Sample payload lives in ./samples/pengajuan.json.

import http from 'k6/http';
import { check } from 'k6';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('smoke');

const BASE_URL = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-legacy').replace(/\/+$/, '');
const API_KEY  = __ENV.API_KEY || '';
const TENANT   = __ENV.TENANT || '';

const PENGAJUAN = open('./samples/pengajuan.json');

export const options = { vus: 1, iterations: 1 };

function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (API_KEY) h['X-API-Key'] = API_KEY;
  if (TENANT) h['X-Tenant-ID'] = TENANT;
  return h;
}

// LBP success envelope always carries a correlation_id + data field.
function isLbpEnvelope(r) {
  try {
    const b = r.json();
    return b && typeof b.correlation_id === 'string' && b.data !== undefined;
  } catch (_) { return false; }
}

export default function () {
  // 1) liveness / readiness / detail
  check(http.get(`${BASE_URL}/api/v1/health/live`, { headers: headers() }),
    { 'GET /health/live -> 200': (r) => r.status === 200 });
  check(http.get(`${BASE_URL}/api/v1/health/ready`, { headers: headers() }),
    { 'GET /health/ready -> 200 or 503': (r) => r.status === 200 || r.status === 503 });

  const health = http.get(`${BASE_URL}/api/v1/health`, { headers: headers() });
  check(health, {
    'GET /health -> 200': (r) => r.status === 200,
    'health has LBP envelope': (r) => isLbpEnvelope(r),
  });

  // 2) kirimData — sync pengajuan validation. NOTE: a rejected payload still
  //    returns HTTP 200 with the verdict in the body (data.verdict), so we check
  //    the envelope + that a verdict came back, not the HTTP code alone.
  const kirim = http.post(`${BASE_URL}/api/v1/kirimData`, PENGAJUAN,
    { headers: headers({ 'Content-Type': 'application/json' }) });
  console.log(`POST /kirimData -> ${kirim.status}`);
  const ok = check(kirim, {
    'kirimData -> 200': (r) => r.status === 200,
    'kirimData has envelope': (r) => isLbpEnvelope(r),
    'kirimData returned a verdict': (r) => {
      try { const v = r.json('data.verdict'); return v === 'pass' || v === 'fail'; }
      catch (_) { return false; }
    },
  });
  if (!ok) console.error(`kirimData smoke failed: ${kirim.status} ${String(kirim.body).slice(0, 300)}`);

  try { console.log(`kirimData verdict=${kirim.json('data.verdict')} status=${kirim.json('data.status')}`); } catch (_) { /* ignore */ }
}
