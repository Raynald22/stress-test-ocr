// E2E BC2.0 — ROBUSTNESS test. Feeds corrupt/malformed files (samples/bad/)
// through the upload hops and checks the chain degrades safely: every bad
// file gets a real HTTP status (no hang) and NONE of them are silently
// accepted as if they were valid (excel/upload returning 200 on garbage,
// or an OCR job on a corrupt doc ending in SUCCESS instead of FAILED/ERROR).
// Same idea as hpc/robustness.js + ocr/robustness.js, run at the journey
// level instead of per-service.
//
// One VU, one pass over a small static corpus — not a load test.
//
//   k6 run -e SSO_TOKEN=<bearer> robustness.js
//
// config.json (copy of config.example.json) must sit next to this file.

import http from 'k6/http';
import { group, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { makeSummary } from './summary.js';
import { CFG, DS, HPC, OCR, headers, jsonHeaders, pick } from './lib.js';

export const handleSummary = makeSummary('robustness');

// true = bad input correctly rejected (or, for OCR, ended in a non-success
// terminal state) — this is the GOOD outcome.
const rejectedProperly = new Rate('e2e_robustness_rejected');
// true = BUG: a bad file was treated as a success somewhere in the chain.
const silentlyAccepted = new Rate('e2e_robustness_silently_accepted');

const POLL_S   = Number(__ENV.POLL_INTERVAL_S || CFG.ocr.poll_interval_s || 3);
const MAX_WAIT = Number(__ENV.MAX_WAIT_S || CFG.ocr.max_wait_s || 300);
const OCR_TERMINAL = new Set(['success', 'failed', 'completed', 'error']);

const BAD_EXCEL = [
  { bin: open('./samples/bad/empty.xlsx', 'b'), name: 'empty.xlsx' },
  { bin: open('./samples/bad/not_really_xlsx.xlsx', 'b'), name: 'not_really_xlsx.xlsx' },
  { bin: open('./samples/bad/truncated.xlsx', 'b'), name: 'truncated.xlsx' },
];
const BAD_OCR_DOCS = [
  { bin: open('./samples/bad/corrupt_doc.pdf', 'b'), name: 'corrupt_doc.pdf' },
];

export const options = {
  scenarios: { robustness: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '10m' } },
  thresholds: {
    e2e_robustness_silently_accepted: ['rate==0'],
  },
};

export default function () {
  group('excel_upload_bad_files', () => {
    for (const f of BAD_EXCEL) {
      const fd = { file: http.file(f.bin, f.name), createdBy: 'qa-e2e-robustness', id_rekam: `e2e-bad-${Date.now()}` };
      const res = http.post(`${HPC}/api/v1/excel/upload`, fd, { headers: headers(), tags: { hop: 'excel_bad' } });

      const hung = res.status === 0;
      const success = res.status === 200;
      const rejected = res.status >= 400 && res.status < 500;

      silentlyAccepted.add(success);
      rejectedProperly.add(rejected);

      if (hung) console.error(`[ROBUSTNESS][HANG?] excel/upload ${f.name} -> no response`);
      else if (success) console.error(`[ROBUSTNESS][BUG] excel/upload accepted bad file '${f.name}' as 200`);
      else if (!rejected) console.warn(`[ROBUSTNESS][unexpected] excel/upload ${f.name} -> ${res.status}`);
    }
  });

  group('ocr_create_bad_docs', () => {
    for (const f of BAD_OCR_DOCS) {
      const upFd = { file: http.file(f.bin, f.name), createBy: 'qa-e2e-robustness', dokumen: 'Invoice (INV)', version_dokumen: 'v1.0' };
      const up = http.post(`${DS}/api/v1/upload/file`, upFd, { headers: headers(), tags: { hop: 'upload_bad' } });

      let key = null;
      if (up.status >= 200 && up.status < 300) {
        try { key = pick(up.json(), ['data.min_io_key', 'data.minio_key', 'data.key', 'data.path', 'min_io_key']); } catch (_) {}
      }
      if (!key) {
        // rejected before it even became an OCR job — that's a valid, safe outcome
        rejectedProperly.add(true);
        console.log(`[ROBUSTNESS] upload/file rejected bad doc '${f.name}' at upload step (status ${up.status})`);
        continue;
      }

      const body = { invoices: [{ filename: f.name, min_io_key: key }], packing_lists: [], bill_of_lading: [] };
      const res = http.post(`${OCR}/ocr/create`, JSON.stringify(body), { headers: jsonHeaders(), tags: { hop: 'ocr_create_bad' } });
      const accepted = res.status === 202 || res.status === 200;
      if (!accepted) {
        rejectedProperly.add(true);
        continue;
      }

      let jobId = null;
      try { jobId = pick(res.json(), ['data.job_id', 'job_id', 'data.id', 'id']); } catch (_) {}
      if (!jobId) {
        console.error(`[ROBUSTNESS][unexpected] ocr/create accepted '${f.name}' (${res.status}) but returned no job_id`);
        continue;
      }

      // job was accepted — it must reach a terminal state, and that state
      // must NOT be a clean success (this is a corrupt document).
      const start = Date.now();
      let terminal = null;
      while ((Date.now() - start) / 1000 < MAX_WAIT) {
        sleep(POLL_S);
        const poll = http.get(`${OCR}/ocr/getData/${jobId}`, { headers: headers(), tags: { hop: 'ocr_poll_bad' } });
        if (poll.status !== 200) continue;
        let status;
        try { status = String(pick(poll.json(), ['data.status', 'status']) || '').toLowerCase(); } catch (_) { continue; }
        if (OCR_TERMINAL.has(status)) { terminal = status; break; }
      }

      if (terminal === null) {
        console.error(`[ROBUSTNESS][HANG] OCR job ${jobId} for '${f.name}' never reached a terminal state within ${MAX_WAIT}s`);
        rejectedProperly.add(false);
      } else if (terminal === 'success' || terminal === 'completed') {
        console.error(`[ROBUSTNESS][BUG] OCR job ${jobId} for corrupt doc '${f.name}' ended '${terminal}' — expected FAILED/ERROR`);
        silentlyAccepted.add(true);
      } else {
        rejectedProperly.add(true);
      }
    }
  });
}
