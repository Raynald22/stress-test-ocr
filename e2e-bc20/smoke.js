// E2E BC2.0 smoke — validates the 3 backends are reachable and the SSO token
// works, BEFORE running the write-heavy journeys. Read-only: it does NOT create
// any pengajuan. Run this first.
//
//   k6 run -e SSO_TOKEN=<bearer> smoke.js
//
// If the token is missing/invalid you'll see 401s here — fix that before running
// journey_excel.js / journey_ocr.js.

import http from 'k6/http';
import { check } from 'k6';
import { makeSummary } from './summary.js';
import { CFG, DS, HPC, OCR, headers, SSO_TOKEN } from './lib.js';

export const handleSummary = makeSummary('smoke');
export const options = { vus: 1, iterations: 1 };

export default function () {
  if (!SSO_TOKEN) {
    console.warn('SSO_TOKEN kosong — kalau backend dev butuh auth, semua bakal 401. '
      + 'Kasih lewat -e SSO_TOKEN=<bearer>.');
  }

  // HPC reachable (health is public)
  check(http.get(`${HPC}/healthz`, { headers: headers() }),
    { 'HPC /healthz -> 200': (r) => r.status === 200 });

  // OCR reachable (health is public)
  check(http.get(`${OCR}/health`, { headers: headers() }),
    { 'OCR /health -> 200': (r) => r.status === 200 });

  // data-service reachable + SSO token valid (this endpoint needs auth)
  const ident = http.get(`${DS}/api/v1/permohonan/identitas`, { headers: headers() });
  console.log(`GET data-service /permohonan/identitas -> ${ident.status}`);
  check(ident, {
    'data-service reachable (not 0/5xx)': (r) => r.status !== 0 && r.status < 500,
    'SSO token accepted (not 401)': (r) => r.status !== 401,
  });
  if (ident.status === 401) {
    console.error('401 dari data-service — token SSO nggak valid/nggak ada. '
      + 'Journey bakal gagal. Perbaiki token dulu.');
  }

  // data-service referensi (cached read) — confirms envelope + version prefix
  const ref = http.get(`${DS}/api/v1/referensi/jenis-pib`, { headers: headers() });
  check(ref, {
    'referensi/jenis-pib -> 200': (r) => r.status === 200,
    'referensi envelope success:true': (r) => { try { return r.json('success') === true; } catch (_) { return false; } },
  });

  console.log(`Base URLs — DS=${DS} HPC=${HPC} OCR=${OCR}`);
}
