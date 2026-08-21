// E2E BC2.0 — SPIKE test. Same chain as journey_excel.js/journey_ocr.js, but
// VUs jump sharply from a low baseline to a burst, then back down — checks
// whether the chain (and especially data-service's insert/lock path) degrades
// gracefully under a sudden concurrency spike, or falls over.
//
// MODE=excel (default) or MODE=ocr.
//
// ⚠️ WRITES DATA. Kept small/short by default on purpose (few dozen rows) —
// raise SPIKE_VUS/SPIKE_DURATION only with dev's knowledge.
//
//   k6 run -e SSO_TOKEN=<bearer> spike.js
//   k6 run -e SSO_TOKEN=<bearer> -e SPIKE_VUS=30 -e SPIKE_DURATION=1m spike.js
//
// config.json (copy of config.example.json) must sit next to this file.

import { makeSummary } from './summary.js';
import { CFG, runExcelJourney, runOcrJourney } from './lib.js';

export const handleSummary = makeSummary('spike');

const MODE     = __ENV.MODE || 'excel';
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

const BASE_VUS  = Number(__ENV.BASE_VUS || 1);
const SPIKE_VUS = Number(__ENV.SPIKE_VUS || 15);
const SPIKE_DUR = __ENV.SPIKE_DURATION || '30s';
const RAMP      = __ENV.SPIKE_RAMP || '5s';
const HOLD_PRE  = __ENV.HOLD_BEFORE || '30s';
const HOLD_POST = __ENV.HOLD_AFTER || '30s';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: BASE_VUS,
      stages: [
        { duration: HOLD_PRE, target: BASE_VUS },
        { duration: RAMP, target: SPIKE_VUS },
        { duration: SPIKE_DUR, target: SPIKE_VUS },
        { duration: RAMP, target: BASE_VUS },
        { duration: HOLD_POST, target: BASE_VUS },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    e2e_journey_failed: [`rate<${Number(__ENV.MAX_FAIL_PCT || 0.10)}`],
    e2e_journey_ms: [`p(95)<${Number(__ENV.P95_MS || 30000)}`],
  },
};

export default function () {
  if (MODE === 'ocr') {
    runOcrJourney({ JENIS, CREATED, OCR_FILES, POLL_S, MAX_WAIT });
  } else {
    runExcelJourney({ JENIS, CREATED, XLSX_BIN, XLSX_NAME });
  }
}
