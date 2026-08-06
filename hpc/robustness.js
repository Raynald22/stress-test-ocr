// HPC Excel-upload robustness test — bad/edge files.
//
// Sends a corpus of malformed / edge-case .xlsx files to POST /excel/upload and
// checks the service FAILS CLEANLY: every upload must return a real HTTP status
// (no hang / no status 0) within the timeout, bad files must be rejected (>=400),
// and nothing should come back 200/"success" for obvious garbage. A 500 is
// reported loudly (a handled 5xx is tolerable, an unhandled crash is not).
//
// Prep (dev/QA):
//   pip install openpyxl
//   python make_bad_xlsx.py      # writes samples/bad/*.xlsx + bad_manifest.json
//
// Run:
//   k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc robustness.js

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { makeSummary } from './summary.js';

export const handleSummary = makeSummary('robustness');

const BASE_URL   = (__ENV.BASE_URL || 'https://dev-backend.insw.go.id/kepabeanan-hpc').replace(/\/+$/, '');
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const REQ_TIMEOUT = __ENV.REQ_TIMEOUT || '120s';    // generous: oversized/many-rows are slow

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const MANIFEST = new SharedArray('bad_manifest',
  () => JSON.parse(open('./samples/bad_manifest.json')));

// Pre-open every bad file's bytes (k6 requires open() at init time).
const FILES = {};
for (const entry of MANIFEST) {
  FILES[entry.file] = open(`./samples/${entry.file}`, 'b');
}

export const options = {
  vus: 1,
  iterations: MANIFEST.length,
  thresholds: {
    // hard rule: no upload may hang or crash unhandled
    'checks{kind:no_hang}': ['rate==1'],
  },
};

function headers() {
  const h = {};
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

export default function () {
  const entry = MANIFEST[(__ITER) % MANIFEST.length];
  const name = entry.file.split('/').pop();
  const bin = FILES[entry.file];

  const fd = {
    file: http.file(bin, name, XLSX_MIME),
    createdBy: 'qa-robustness',
    id_rekam: `robust-${name}`,
  };

  const res = http.post(`${BASE_URL}/api/v1/excel/upload`, fd,
    { headers: headers(), timeout: REQ_TIMEOUT, tags: { name: 'excel_upload_bad' } });

  console.log(`${name} (${entry.note}) -> ${res.status}`);

  // The one non-negotiable: it answered (no hang).
  check(res, { 'reached a final HTTP status (no hang)': (r) => r.status !== 0 },
    { kind: 'no_hang' });

  // Garbage should be rejected, not silently accepted.
  if (entry.expect_reject) {
    const rejected = res.status >= 400 && res.status < 600;
    check(res, { [`${name}: rejected (>=400)`]: () => rejected });
    if (res.status >= 200 && res.status < 300) {
      console.error(`SUSPICIOUS: bad file ${name} was ACCEPTED (${res.status}) — `
        + `service thinks garbage is valid. Investigate. body=${String(res.body).slice(0, 300)}`);
    }
  }

  // A handled 5xx is tolerable but worth surfacing; an unhandled crash usually
  // shows up as repeated 502/503 or status 0 across cases.
  if (res.status >= 500) {
    console.warn(`${name}: server returned ${res.status} — confirm it's a handled `
      + `error response, not a worker crash. body=${String(res.body).slice(0, 300)}`);
  }
}
