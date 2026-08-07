// LNSW Data Service negative / bad-input test — API level.
//
// Checks the service rejects bad input POLITELY (correct 4xx) and never answers
// a client mistake with a 500 or a hang. The global AllExceptionsFilter maps bad
// UUIDs / validation / even DB constraint violations to 4xx, so the hard rule
// everywhere is: NOT 5xx.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-data-service negative.js
//
// Auth is currently disabled; pass -e API_KEY=1n5w2026# if it gets re-enabled.

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('negative');

const BASE_URL = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-data-service').replace(/\/+$/, '');
const API_KEY  = __ENV.API_KEY || '';

const TARGETS = new SharedArray('targets', () => [JSON.parse(open('./targets.json'))])[0];
const BUNDLE_PATH = (TARGETS.bundle && TARGETS.bundle.path) || '/api/v1/ssm-impor-api-bundle-post';

export const options = { vus: 1, iterations: 1 };

function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (API_KEY) h['API-KEY'] = API_KEY;
  return h;
}

// The hard rule is "never 5xx / never hang"; the expected 4xx is a softer check.
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
  // bad UUID in query -> ParseUUIDPipe -> 400
  assertClientError('GET /pengajuan?idHeader=not-a-uuid',
    http.get(`${BASE_URL}/api/v1/pengajuan?idHeader=not-a-uuid`, { headers: headers() }), 400);

  // PUT requires idHeader -> missing -> 400
  assertClientError('PUT /pengajuan without idHeader',
    http.put(`${BASE_URL}/api/v1/pengajuan`, '{}',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // bundle POST with malformed JSON -> 400
  assertClientError('POST bundle malformed JSON',
    http.post(`${BASE_URL}${BUNDLE_PATH}`, '{ not: valid json',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // bundle POST with empty object -> no section -> 400
  assertClientError('POST bundle empty object',
    http.post(`${BASE_URL}${BUNDLE_PATH}`, '{}',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // referensi/kurs requires kodeKurs -> missing. Must be a clean 4xx, not 5xx.
  assertClientError('GET /referensi/kurs without kodeKurs',
    http.get(`${BASE_URL}/api/v1/referensi/kurs`, { headers: headers() }), [400, 404]);

  // unknown route -> 404
  assertClientError('GET unknown route',
    http.get(`${BASE_URL}/api/v1/this-route-does-not-exist`, { headers: headers() }), 404);

  // upload without file part -> 400
  assertClientError('POST /upload/file without file',
    http.post(`${BASE_URL}/api/v1/upload/file`, { createBy: 'qa' }, { headers: headers() }), 400);
}
