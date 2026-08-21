// E2E BC2.0 — BREAKPOINT / stress test. Same chain as journey_excel.js /
// journey_ocr.js (see lib.js runExcelJourney/runOcrJourney), but VUs ramp up
// stage by stage instead of staying flat, so you can see where the chain
// starts failing/slowing down — that point is the capacity limit.
//
// MODE=excel (default, fast/cheap to ramp) or MODE=ocr (slow per-iteration;
// only use for a low-VU ceiling, each OCR job is a real async workload).
//
// ⚠️ WRITES DATA every iteration, and iteration RATE grows with each stage —
// a full default ramp (1→5→10→20→40) over ~15 min can create hundreds of
// permohonan rows in dev. Coordinate with dev before running above the
// defaults, and prefer MODE=excel for the ramp itself.
//
//   k6 run -e SSO_TOKEN=<bearer> stress.js
//   k6 run -e SSO_TOKEN=<bearer> -e STAGE_VUS=1,5,10,20 -e STAGE_MINUTES=1 stress.js
//   k6 run -e SSO_TOKEN=<bearer> -e MODE=ocr -e STAGE_VUS=1,2,4 stress.js
//
// config.json (copy of config.example.json) must sit next to this file.

import { makeSummary } from './summary.js';
import { CFG, runExcelJourney, runOcrJourney } from './lib.js';

export const handleSummary = makeSummary('stress');

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

// stage plan: ramp to each target VUs, hold, ramp to next.
const STAGE_VUS = (__ENV.STAGE_VUS || '1,5,10,20,40').split(',').map(Number);
const STAGE_MIN = Number(__ENV.STAGE_MINUTES || 2);
const RAMP_S    = Number(__ENV.RAMP_SECONDS || 30);

function buildStages(targets) {
  const stages = [];
  for (const t of targets) {
    stages.push({ duration: `${RAMP_S}s`, target: t });
    stages.push({ duration: `${STAGE_MIN}m`, target: t });
  }
  return stages;
}

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: buildStages(STAGE_VUS),
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // these don't abort the run — they just mark in the summary where the
    // chain crossed the line. Look at e2e_journey_ms/e2e_journey_failed over
    // time (or per-stage in the k6 output) to see which VU level was the
    // actual breakpoint.
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
