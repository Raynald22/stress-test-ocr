// LNSW Data Service single-pass smoke test. Run this FIRST, before stress.js.
// Confirms the env is reachable and the response envelope is the standard
// {success,message,data} shape.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-data-service smoke.js
//
// Service is SYNCHRONOUS (request -> response). No health endpoint exists, so we
// use GET / (landing HTML) and GET /api/docs-json for liveness, then hit one
// referensi and one domain endpoint.
//
// Auth: currently DISABLED on the service. If it gets re-enabled, pass the key:
//   -e API_KEY=1n5w2026#
//
// targets.json (copy of targets.example.json) must sit next to this file.

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('smoke');

const BASE_URL = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-data-service').replace(/\/+$/, '');
const API_KEY  = __ENV.API_KEY || '';            // empty = auth off (current state)
const DO_BUNDLE = (__ENV.BUNDLE || '0') === '1'; // also try one bundle POST (writes data!)

const TARGETS = new SharedArray('targets', () => [JSON.parse(open('./targets.json'))])[0];
const BUNDLE_BODY = DO_BUNDLE && TARGETS.bundle
  ? new SharedArray('bundle', () => [open(`./${TARGETS.bundle.payload}`)])[0]
  : null;

export const options = { vus: 1, iterations: 1 };

function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (API_KEY) h['API-KEY'] = API_KEY;
  return h;
}

function isOkEnvelope(r) {
  try {
    const b = r.json();
    return b && b.success === true && typeof b.message === 'string';
  } catch (_) { return false; }
}

export default function () {
  // 1) landing page (public, HTML)
  const root = http.get(`${BASE_URL}/`, { headers: headers() });
  check(root, { 'GET / -> 200': (r) => r.status === 200 });

  // 2) OpenAPI JSON (public) — proves the app booted & routes are mounted
  const docs = http.get(`${BASE_URL}/api/docs-json`, { headers: headers() });
  check(docs, { 'GET /api/docs-json -> 200': (r) => r.status === 200 });

  // 3) one referensi endpoint (cached read) -> 200 + envelope
  const ref = (TARGETS.referensi_endpoints || [])[0];
  if (ref) {
    const res = http.get(`${BASE_URL}${ref}`, { headers: headers() });
    console.log(`GET ${ref} -> ${res.status}`);
    const ok = check(res, {
      'referensi -> 200': (r) => r.status === 200,
      'referensi has success:true envelope': (r) => isOkEnvelope(r),
    });
    if (!ok) console.error(`referensi smoke failed: ${res.status} ${String(res.body).slice(0, 300)}`);
  }

  // 4) one domain endpoint (DB read) -> 200 + envelope
  const dom = (TARGETS.domain_endpoints || [])[0];
  if (dom) {
    const res = http.get(`${BASE_URL}${dom}`, { headers: headers() });
    console.log(`GET ${dom} -> ${res.status}`);
    check(res, {
      'domain -> 200': (r) => r.status === 200,
      'domain has success:true envelope': (r) => isOkEnvelope(r),
    });
  }

  // 5) optional: one bundle POST (WRITES DATA — dev only)
  if (DO_BUNDLE && BUNDLE_BODY && TARGETS.bundle) {
    const res = http.post(`${BASE_URL}${TARGETS.bundle.path}`, BUNDLE_BODY,
      { headers: headers({ 'Content-Type': 'application/json' }) });
    console.log(`POST ${TARGETS.bundle.path} -> ${res.status}`);
    check(res, {
      'bundle POST -> 2xx': (r) => r.status >= 200 && r.status < 300,
      'bundle POST envelope success:true': (r) => isOkEnvelope(r),
    });
    if (res.status >= 300) {
      console.error(`bundle smoke non-2xx: ${res.status} ${String(res.body).slice(0, 400)}`);
    }
  }
}
