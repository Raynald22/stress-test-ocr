// E2E BC2.0 — OCR smart-form journey. Reproduces the FE's OCR-based path, the
// full document-to-form chain across data-service + OCR:
//
//   1. data-service  POST /api/v1/permohonan                 -> idPermohonan
//   2. data-service  POST /api/v1/upload/file (per doc)      -> min_io_key
//   3. OCR           POST /ocr/create {invoices/pl/bl}       -> job_id
//   4. OCR           GET  /ocr/getData/{job_id} (poll)       -> terminal (SUCCESS/FAILED)
//   5. OCR           POST /ocr/submit/{job_id}               -> builds BC2.0 bundle -> data-service
//   6. data-service  GET  /api/v1/pengajuan?id_permohonan=.. -> idHeader
//   7. data-service  GET  /api/v1/review-dan-submit?idPermohonan=..
//
// This path includes the ASYNC OCR job (step 4 polls until done), so one journey
// can take tens of seconds to minutes — VUS stays small. Closed model: each VU
// runs the whole chain, then loops. Per-hop metrics + full journey time. The
// chain itself lives in lib.js (runOcrJourney) so stress.js/spike.js/soak.js/
// concurrency.js can reuse it under different load shapes without duplicating
// the hop logic.
//
// ⚠️ WRITES DATA + runs real OCR. Dev/throwaway env only.
//
//   k6 run -e SSO_TOKEN=<bearer> -e VUS=2 -e DURATION=10m journey_ocr.js
//
// config.json (copy of config.example.json) must sit next to this file.

import { makeSummary } from './summary.js';
import { CFG, runOcrJourney } from './lib.js';

export const handleSummary = makeSummary('journey-ocr');

const VUS      = Number(__ENV.VUS || 2);
const DURATION = __ENV.DURATION || '10m';
const JENIS    = __ENV.JENIS_DOKUMEN || CFG.jenis_dokumen;
const CREATED  = CFG.created_by || 'qa-e2e';
const POLL_S   = Number(__ENV.POLL_INTERVAL_S || CFG.ocr.poll_interval_s || 3);
const MAX_WAIT = Number(__ENV.MAX_WAIT_S || CFG.ocr.max_wait_s || 300);

// open all OCR sample files once at init
const OCR_FILES = (CFG.ocr.files || []).map((f) => ({
  bin: open(`./${f.path}`, 'b'),
  name: f.path.split('/').pop(),
  type: f.type || 'invoices',
  dokumen: f.dokumen || 'Dokumen OCR',
}));

export const options = {
  scenarios: { journey: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  thresholds: {
    e2e_journey_failed: [`rate<${Number(__ENV.MAX_FAIL_PCT || 0.10)}`],
    e2e_journey_ms: [`p(95)<${Number(__ENV.P95_MS || 180000)}`],
  },
};

export default function () {
  runOcrJourney({ JENIS, CREATED, OCR_FILES, POLL_S, MAX_WAIT });
}
