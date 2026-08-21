// E2E BC2.0 — SOAK / endurance test. Same chain as journey_excel.js/
// journey_ocr.js, but held at a steady low VU count for a long duration —
// looks for slow degradation (connection pool exhaustion, memory leak, DB
// lock contention creeping up) that a short journey run wouldn't catch.
//
// MODE=excel (default) or MODE=ocr.
//
// ⚠️ WRITES DATA continuously for the whole duration. Default is intentionally
// short (10m) so running this by accident doesn't flood dev — a real soak
// (30m-several hours) needs explicit -e DURATION=... AND coordination with
// dev (DB pool, OCR queue, and just the sheer number of rows created).
//
//   k6 run -e SSO_TOKEN=<bearer> soak.js
//   k6 run -e SSO_TOKEN=<bearer> -e VUS=3 -e DURATION=30m soak.js
//
// config.json (copy of config.example.json) must sit next to this file.

import { makeSummary } from './summary.js';
import { CFG, runExcelJourney, runOcrJourney } from './lib.js';

export const handleSummary = makeSummary('soak');

const MODE     = __ENV.MODE || 'excel';
const VUS      = Number(__ENV.VUS || 3);
const DURATION = __ENV.DURATION || '10m';
const JENIS    = __ENV.JENIS_DOKUMEN || CFG.jenis_dokumen;
const CREATED  = CFG.created_by || 'qa-e2e';
const POLL_S   = Number(__ENV.POLL_INTERVAL_S || CFG.ocr.poll_interval_s || 3);
const MAX_WAIT = Number(__ENV.MAX_WAIT_S || CFG.ocr.max_wait_s || 300);

const XLSX_BIN  = open(`./${CFG.excel.template}`, 'b');
const XLSX_NAME = CFG.excel.template.split('/').pop();
const OCR_FILES = (CFG.ocr.files || []).map((f) => ({
  bin: open(`./${f.path}`, 'b'),
  name: f.path.split('/').pop(),
  type: f.type || 'invoices',
  dokumen: f.dokumen || 'Dokumen OCR',
}));

export const options = {
  scenarios: { soak: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  thresholds: {
    // watch these over time in the results, not just the final rate/p95 —
    // a soak that starts clean and creeps up toward the threshold near the
    // end is exactly the failure mode this test is for.
    e2e_journey_failed: [`rate<${Number(__ENV.MAX_FAIL_PCT || 0.05)}`],
    e2e_journey_ms: [`p(95)<${Number(__ENV.P95_MS || 20000)}`],
  },
};

export default function () {
  if (MODE === 'ocr') {
    runOcrJourney({ JENIS, CREATED, OCR_FILES, POLL_S, MAX_WAIT });
  } else {
    runExcelJourney({ JENIS, CREATED, XLSX_BIN, XLSX_NAME });
  }
}
