// E2E BC2.0 — EXCEL journey (no OCR). Reproduces the FE's Excel-based path across
// 3 backends, chaining IDs from one hop to the next:
//
//   1. data-service  POST /api/v1/permohonan                 -> idPermohonan
//   2. HPC           POST /api/v1/excel/upload  (xlsx)       -> header_id (bc20)
//   3. HPC           POST /api/v1/data-service/ssm-impor-bundle  (forwards to data-service)
//   4. data-service  GET  /api/v1/pengajuan?id_permohonan=.. -> idHeader (data-service)
//   5. data-service  GET  /api/v1/review-dan-submit?idHeader=..
//
// Closed model: each VU runs the whole chain end-to-end, then loops. We measure
// EACH hop (e2e_*_ms) and the whole journey (e2e_journey_ms). A journey counts
// as failed if any hop fails. The chain itself lives in lib.js (runExcelJourney)
// so stress.js/spike.js/soak.js/concurrency.js can reuse it under different load
// shapes without duplicating the hop logic.
//
// ⚠️ WRITES DATA to HPC + data-service every run. Dev/throwaway env only.
//
//   k6 run -e SSO_TOKEN=<bearer> -e VUS=5 -e DURATION=3m journey_excel.js
//
// config.json (copy of config.example.json) must sit next to this file.

import { makeSummary } from './summary.js';
import { CFG, runExcelJourney } from './lib.js';

export const handleSummary = makeSummary('journey-excel');

const VUS      = Number(__ENV.VUS || 5);
const DURATION = __ENV.DURATION || '3m';
const JENIS    = __ENV.JENIS_DOKUMEN || CFG.jenis_dokumen;
const CREATED  = CFG.created_by || 'qa-e2e';

// open the BC2.0 template once at init
const XLSX_BIN  = open(`./${CFG.excel.template}`, 'b');
const XLSX_NAME = CFG.excel.template.split('/').pop();

export const options = {
  scenarios: { journey: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  thresholds: {
    e2e_journey_failed: [`rate<${Number(__ENV.MAX_FAIL_PCT || 0.05)}`],
    e2e_journey_ms: [`p(95)<${Number(__ENV.P95_MS || 20000)}`],
  },
};

export default function () {
  runExcelJourney({ JENIS, CREATED, XLSX_BIN, XLSX_NAME });
}
