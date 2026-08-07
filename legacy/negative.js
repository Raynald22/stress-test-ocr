// Legacy Bridge Platform (LBP) negative / bad-input test — API level.
//
// Checks the service rejects bad input POLITELY (correct 4xx) and never answers
// a client mistake with a 500 or a hang. Error envelope is {code, message,
// correlation_id}. Hard rule everywhere: NOT 5xx / NOT a hang.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-legacy negative.js
//
// Auth off by default; pass -e API_KEY=<key> if LBP_SECURITY_ENABLED=true.

import http from 'k6/http';
import { check } from 'k6';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('negative');

const BASE_URL = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-legacy').replace(/\/+$/, '');
const API_KEY  = __ENV.API_KEY || '';
const TENANT   = __ENV.TENANT || '';

// ~1.1 MB body to trip the 1 MB MaxBodyBytes limit.
const OVERSIZED = `{"blob":"${'x'.repeat(1100000)}"}`;

export const options = { vus: 1, iterations: 1 };

function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (API_KEY) h['X-API-Key'] = API_KEY;
  if (TENANT) h['X-Tenant-ID'] = TENANT;
  return h;
}

function assertClientError(label, res, expected) {
  const okStatus = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  check(res, {
    [`${label} -> expected ${Array.isArray(expected) ? expected.join('/') : expected} (got ${res.status})`]: () => okStatus,
    [`${label} -> not 5xx`]: (r) => r.status < 500,
    [`${label} -> not a hang`]: (r) => r.status !== 0,
  });
  if (res.status >= 500 || res.status === 0) {
    console.error(`${label}: status=${res.status} body=${String(res.body).slice(0, 200)}`);
  }
}

export default function () {
  // kirimData with empty body -> 400
  assertClientError('POST /kirimData empty body',
    http.post(`${BASE_URL}/api/v1/kirimData`, '', { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // kirimData with invalid JSON -> 400
  assertClientError('POST /kirimData invalid JSON',
    http.post(`${BASE_URL}/api/v1/kirimData`, '{ not json', { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // kirimData oversized body (>1MB) -> rejected (4xx). Must not 5xx.
  assertClientError('POST /kirimData oversized body',
    http.post(`${BASE_URL}/api/v1/kirimData`, OVERSIZED, { headers: headers({ 'Content-Type': 'application/json' }) }), [400, 413]);

  // transform/xml-to-json requires an XML Content-Type -> sending JSON -> 400
  assertClientError('POST /transform/xml-to-json with JSON content-type',
    http.post(`${BASE_URL}/api/v1/transform/xml-to-json`, '{"a":1}',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // transform/xml-to-json with correct content-type but malformed XML -> 400
  assertClientError('POST /transform/xml-to-json malformed XML',
    http.post(`${BASE_URL}/api/v1/transform/xml-to-json`, '<root><oops>',
      { headers: headers({ 'Content-Type': 'application/xml' }) }), 400);

  // scanner execute with neither payload nor service_name -> 400
  assertClientError('POST /scanners/vt/execute empty body',
    http.post(`${BASE_URL}/api/v1/scanners/vt/execute`, '{}',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // unknown route -> 404
  assertClientError('GET unknown route',
    http.get(`${BASE_URL}/api/v1/this-route-does-not-exist`, { headers: headers() }), 404);
}
