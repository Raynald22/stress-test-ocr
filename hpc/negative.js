// HPC negative / bad-input test — API level.
//
// Checks the service rejects bad input POLITELY (correct 4xx code) and never
// answers a client mistake with a 500 or a hang. Each case asserts an exact
// expected status based on the handler code (generic_helper.go, fileHandler.go,
// excelHandler.go).
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc negative.js
//
// RESOURCE (default /api/v1/bc20/header) picks which CRUD resource to probe —
// the generic handlers behave identically across bc16/bc20/bc23/ftz01, so one
// representative resource is enough.

import http from 'k6/http';
import { check } from 'k6';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('negative');

const BASE_URL   = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-hpc').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const RESOURCE   = (__ENV.RESOURCE || '/api/v1/bc20/header').replace(/\/+$/, '');

export const options = { vus: 1, iterations: 1 };

function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

// A syntactically valid but almost-certainly-absent UUID -> expect 404, not 500.
const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

// never5xx: a client error must never surface as a server error or hang.
function assertClientError(label, res, expected) {
  const okStatus = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  check(res, {
    [`${label} -> expected ${Array.isArray(expected) ? expected.join('/') : expected} (got ${res.status})`]: () => okStatus,
    [`${label} -> not 5xx`]: (r) => r.status < 500,
    [`${label} -> not a hang (has status)`]: (r) => r.status !== 0,
  });
  if (!okStatus || res.status >= 500) {
    console.error(`${label}: status=${res.status} body=${String(res.body).slice(0, 200)}`);
  }
}

export default function () {
  // --- CRUD id parsing / not-found ---
  assertClientError('GET :id with non-UUID',
    http.get(`${BASE_URL}${RESOURCE}/not-a-uuid`, { headers: headers() }), 400);

  assertClientError('GET :id absent UUID',
    http.get(`${BASE_URL}${RESOURCE}/${ABSENT_UUID}`, { headers: headers() }), 404);

  assertClientError('DELETE :id with non-UUID',
    http.del(`${BASE_URL}${RESOURCE}/not-a-uuid`, null, { headers: headers() }), 400);

  // --- CRUD create with broken body ---
  assertClientError('POST create with malformed JSON',
    http.post(`${BASE_URL}${RESOURCE}`, '{ this is : not json',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  assertClientError('POST create with array where object expected',
    http.post(`${BASE_URL}${RESOURCE}`, '[1,2,3]',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // --- CRUD update without id in body ---
  assertClientError('PUT update with empty array',
    http.put(`${BASE_URL}${RESOURCE}`, '[]',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  assertClientError('PUT update object missing ID field',
    http.put(`${BASE_URL}${RESOURCE}`, '{"nomorAju":"x"}',
      { headers: headers({ 'Content-Type': 'application/json' }) }), 400);

  // --- /file query validation ---
  assertClientError('GET /file with no id or filename',
    http.get(`${BASE_URL}/api/v1/file`, { headers: headers() }), 400);

  assertClientError('GET /file with non-UUID id',
    http.get(`${BASE_URL}/api/v1/file?id=not-a-uuid`, { headers: headers() }), 400);

  assertClientError('DELETE /file with no id or filename',
    http.del(`${BASE_URL}/api/v1/file`, null, { headers: headers() }), 400);

  // --- /excel/upload validation (multipart) ---
  // no file part at all
  assertClientError('POST /excel/upload with no file',
    http.post(`${BASE_URL}/api/v1/excel/upload`, { createdBy: 'qa' }, { headers: headers() }), 400);

  // file present but wrong extension -> 415; also missing required fields
  const notXlsx = http.file('hello, not a spreadsheet', 'evil.txt', 'text/plain');
  assertClientError('POST /excel/upload with .txt file -> unsupported type',
    http.post(`${BASE_URL}/api/v1/excel/upload`,
      { file: notXlsx, createdBy: 'qa', id_rekam: 'neg-1' }, { headers: headers() }), 415);

  // valid-ish name but missing createdBy -> 400
  const fakeXlsx = http.file('PK\x03\x04 not really xlsx', 'x.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assertClientError('POST /excel/upload missing createdBy -> 400',
    http.post(`${BASE_URL}/api/v1/excel/upload`,
      { file: fakeXlsx, id_rekam: 'neg-2' }, { headers: headers() }), 400);

  // --- unknown route -> 404 ---
  assertClientError('GET unknown route',
    http.get(`${BASE_URL}/api/v1/this-route-does-not-exist`, { headers: headers() }), 404);
}
