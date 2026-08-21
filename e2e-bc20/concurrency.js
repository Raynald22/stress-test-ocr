// E2E BC2.0 — CONCURRENCY / race-condition test. N VUs start the SAME chain
// at (almost) the same time, one iteration each, and each successful run logs
// the IDs it got at every hop. Post-run, grep those log lines for duplicate
// idPermohonan/idHeader values — a duplicate means two VUs collided on an ID
// (e.g. a broken sequence/advisory-lock somewhere in the chain), the same
// class of bug data-service/nomoraju.js checks for on the nomorAju generator.
//
// MODE=excel (default — cheap/fast, so the burst is actually concurrent) or
// MODE=ocr (each iteration is slow/async, so "concurrent" is a weaker signal
// here — OCR's own queue will naturally serialize a lot of it).
//
// ⚠️ WRITES DATA — VUS new permohonan rows per run.
//
//   k6 run -e SSO_TOKEN=<bearer> concurrency.js
//   k6 run -e SSO_TOKEN=<bearer> concurrency.js 2>&1 | grep CONCURRENCY_ID
//   # then check for collisions, e.g.:
//   k6 run -e SSO_TOKEN=<bearer> concurrency.js 2>&1 | grep CONCURRENCY_ID \
//     | sed -n 's/.*idPermohonan=\([^ ]*\).*/\1/p' | sort | uniq -d
//
// config.json (copy of config.example.json) must sit next to this file.

import { makeSummary } from './summary.js';
import { CFG, runExcelJourney, runOcrJourney } from './lib.js';

export const handleSummary = makeSummary('concurrency');

const MODE = __ENV.MODE || 'excel';
const VUS  = Number(__ENV.VUS || 20);
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
  // per-vu-iterations starts all VUs together and gives each exactly one
  // iteration — the closest k6 gets to "everyone fires at once".
  scenarios: {
    concurrency: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: Number(__ENV.ITER_PER_VU || 1),
      maxDuration: __ENV.MAX_DURATION || '5m',
    },
  },
  thresholds: {
    e2e_journey_failed: [`rate<${Number(__ENV.MAX_FAIL_PCT || 0.10)}`],
  },
};

export default function () {
  const result = MODE === 'ocr'
    ? runOcrJourney({ JENIS, CREATED, OCR_FILES, POLL_S, MAX_WAIT })
    : runExcelJourney({ JENIS, CREATED, XLSX_BIN, XLSX_NAME });

  if (!result.failed) {
    console.log(`CONCURRENCY_ID vu=${__VU} iter=${__ITER} idPermohonan=${result.idPermohonan} idHeader=${result.idHeaderDs}`);
  }
}
