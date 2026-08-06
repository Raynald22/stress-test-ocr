// HPC service single-pass smoke test. Run this FIRST, before hpc_stress.js, to
// confirm the target env is reachable and the response envelope is what we
// expect (right URL, service up, read endpoints returning the standard
// {success,message,data} shape). If this fails, the load run will just be a
// wall of red — fix the smoke first.
//
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc smoke.js
//
// The HPC API is SYNCHRONOUS (request -> response), unlike the async OCR
// service — so here we just check status codes + the JSON envelope, no polling.
//
// targets.json (copy of targets.example.json, trimmed by dev/QA) must sit next
// to this file.

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('smoke');

const BASE_URL   = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-hpc').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';           // usually empty; set only if a gateway needs it
const DO_UPLOAD  = (__ENV.UPLOAD || '0') === '1';    // also try one Excel upload

const TARGETS = new SharedArray('targets', () => [JSON.parse(open('./targets.json'))])[0];

export const options = { vus: 1, iterations: 1 };

function headers() {
  const h = {};
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

// The standard success envelope from pkg/response.Response
function isOkEnvelope(r) {
  try {
    const b = r.json();
    return b && b.success === true && typeof b.message === 'string';
  } catch (_) { return false; }
}

export default function () {
  // 1) health endpoint (registered at root, returns 200 with empty body)
  const health = http.get(`${BASE_URL}/healthz`, { headers: headers() });
  check(health, { 'GET /healthz -> 200': (r) => r.status === 200 });

  // 2) root info endpoint -> JSON {message, version, docs}
  const root = http.get(`${BASE_URL}/`, { headers: headers() });
  check(root, {
    'GET / -> 200': (r) => r.status === 200,
    'GET / returns running message': (r) => {
      try { return String(r.json('message') || '').toLowerCase().includes('running'); }
      catch (_) { return false; }
    },
  });

  // 3) first read endpoint -> 200 + standard envelope with a data field
  const path = (TARGETS.read_endpoints || [])[0];
  if (path) {
    const res = http.get(`${BASE_URL}${path}`, { headers: headers() });
    console.log(`GET ${path} -> ${res.status}`);
    const ok = check(res, {
      'read endpoint -> 200': (r) => r.status === 200,
      'read endpoint has success:true envelope': (r) => isOkEnvelope(r),
      'read endpoint has data field': (r) => {
        try { return r.json('data') !== undefined; } catch (_) { return false; }
      },
    });
    if (!ok) console.error(`read smoke failed: ${res.status} ${String(res.body).slice(0, 300)}`);
  } else {
    console.warn('no read_endpoints in targets.json — skipping read check');
  }

  // 4) optional: one Excel upload happy-path (needs a REAL template from dev)
  if (DO_UPLOAD && TARGETS.upload && TARGETS.upload.sample_xlsx) {
    const u = TARGETS.upload;
    let bin;
    try { bin = open(`./${u.sample_xlsx}`, 'b'); }
    catch (e) { console.error(`cannot open sample xlsx ${u.sample_xlsx}: ${e}`); return; }

    const fd = {
      file: http.file(bin, u.sample_xlsx.split('/').pop(),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      createdBy: u.created_by || 'qa-smoke',
      id_rekam: u.id_rekam || 'smoke-0001',
    };
    const res = http.post(`${BASE_URL}/api/v1/excel/upload`, fd, { headers: headers() });
    console.log(`POST /excel/upload -> ${res.status}`);
    check(res, {
      'upload -> 200': (r) => r.status === 200,
      'upload envelope success:true': (r) => isOkEnvelope(r),
      'upload returned header_id or summaries': (r) => {
        try {
          const d = r.json('data');
          return d && (d.header_id !== undefined || d.summaries !== undefined || d.barang_ids !== undefined);
        } catch (_) { return false; }
      },
    });
    if (res.status !== 200) {
      console.error(`upload smoke non-200 (may be a schema-mismatch template, check with dev): `
        + `${res.status} ${String(res.body).slice(0, 400)}`);
    }
  }
}
