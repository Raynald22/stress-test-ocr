// E2E BC2.0 — NEGATIVE test. Independent bad-input/bad-auth checks against
// each service in the chain (data-service, HPC, OCR) — NOT the happy-path
// journey. One VU, one pass. Rule (same as negative.js in every other suite
// in this repo): a bad request must NEVER 500/hang — it should come back
// with a sane 4xx. Downstream hops are probed with IDs that were never
// produced by a real chain, so this does not depend on journey_excel.js/
// journey_ocr.js having run first.
//
// Read-only-ish: the malformed POSTs are expected to be rejected before
// anything is written; this does not intentionally create real data.
//
//   k6 run -e SSO_TOKEN=<bearer> negative.js
//
// config.json (copy of config.example.json) must sit next to this file.

import http from 'k6/http';
import { check, group } from 'k6';
import { Rate } from 'k6/metrics';
import { makeSummary } from './summary.js';
import { CFG, DS, HPC, OCR, headers, jsonHeaders } from './lib.js';

export const handleSummary = makeSummary('negative');

const FAKE_ID = '00000000-0000-0000-0000-000000000000';

// true = a request that should never happen (server blew up on bad input)
const server5xx = new Rate('e2e_negative_5xx');
// true = status wasn't in the expected set (not necessarily a 5xx, but not
// the sane 4xx either — worth a look even if it doesn't fail the run)
const unexpected = new Rate('e2e_negative_unexpected_status');

export const options = {
  scenarios: { negative: { executor: 'per-vu-iterations', vus: 1, iterations: 1 } },
  thresholds: {
    e2e_negative_5xx: ['rate==0'],
  },
};

function noAuthHeaders() {
  return { 'Accept-Language': 'id' };
}
function badAuthHeaders() {
  return { 'Accept-Language': 'id', Authorization: 'Bearer invalid.garbage.token' };
}

function assertStatus(res, allowed, label) {
  const is5xx = res.status >= 500 || res.status === 0;
  server5xx.add(is5xx);
  const okShape = allowed.includes(res.status);
  unexpected.add(!okShape);
  check(res, { [`${label}: expected [${allowed.join(',')}], got ${res.status}`]: () => okShape });
  if (is5xx) {
    console.error(`[NEGATIVE][SERVER ERROR] ${label} -> ${res.status} ${String(res.body).slice(0, 200)}`);
  } else if (!okShape) {
    console.warn(`[NEGATIVE][unexpected] ${label} -> ${res.status}`);
  }
}

export default function () {
  group('auth_no_token', () => {
    const res = http.get(`${DS}/api/v1/referensi/jenis-pib`, { headers: noAuthHeaders() });
    assertStatus(res, [401, 403], 'GET /referensi/jenis-pib (no token)');
  });

  group('auth_bad_token', () => {
    const res = http.get(`${DS}/api/v1/referensi/jenis-pib`, { headers: badAuthHeaders() });
    assertStatus(res, [401, 403], 'GET /referensi/jenis-pib (garbage token)');
  });

  group('permohonan_malformed_json', () => {
    const res = http.post(`${DS}/api/v1/permohonan`, '{not valid json', { headers: jsonHeaders() });
    assertStatus(res, [400, 422], 'POST /permohonan (malformed json)');
  });

  group('permohonan_missing_fields', () => {
    const res = http.post(`${DS}/api/v1/permohonan`, JSON.stringify({}), { headers: jsonHeaders() });
    assertStatus(res, [400, 422], 'POST /permohonan (empty body)');
  });

  group('excel_upload_no_file', () => {
    const res = http.post(`${HPC}/api/v1/excel/upload`, { createdBy: 'qa-e2e-negative' }, { headers: headers() });
    assertStatus(res, [400, 422], 'POST /excel/upload (no file field)');
  });

  group('excel_upload_wrong_type', () => {
    const fd = { file: http.file('this is not an xlsx file', 'not_really.xlsx', 'text/plain'), createdBy: 'qa-e2e-negative' };
    const res = http.post(`${HPC}/api/v1/excel/upload`, fd, { headers: headers() });
    assertStatus(res, [400, 415, 422], 'POST /excel/upload (wrong file content)');
  });

  group('ocr_create_empty_body', () => {
    const res = http.post(`${OCR}/ocr/create`, JSON.stringify({}), { headers: jsonHeaders() });
    assertStatus(res, [400, 422], 'POST /ocr/create (empty body)');
  });

  group('pengajuan_unknown_id', () => {
    const res = http.get(`${DS}/api/v1/pengajuan?id_permohonan=${FAKE_ID}`, { headers: headers() });
    assertStatus(res, [200, 404], 'GET /pengajuan?id_permohonan (unknown id)');
  });

  group('review_unknown_id', () => {
    const res = http.get(`${DS}/api/v1/review-dan-submit?idHeader=${FAKE_ID}`, { headers: headers() });
    assertStatus(res, [200, 400, 404], 'GET /review-dan-submit (unknown id)');
  });

  group('ocr_getdata_unknown_job', () => {
    const res = http.get(`${OCR}/ocr/getData/${FAKE_ID}`, { headers: headers() });
    assertStatus(res, [400, 404], 'GET /ocr/getData/{id} (unknown job)');
  });

  group('ocr_submit_unknown_job', () => {
    const res = http.post(`${OCR}/ocr/submit/${FAKE_ID}`, JSON.stringify({ jenisDokumen: CFG.jenis_dokumen, idPermohonan: FAKE_ID, idRekam: 'e2e-negative' }), { headers: jsonHeaders() });
    assertStatus(res, [400, 404], 'POST /ocr/submit/{id} (unknown job)');
  });

  group('bad_route', () => {
    const res = http.get(`${DS}/api/v1/definitely-not-a-real-route`, { headers: headers() });
    assertStatus(res, [404], 'GET /definitely-not-a-real-route');
  });
}
