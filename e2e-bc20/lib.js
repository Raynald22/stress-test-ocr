// Shared helpers + metrics for the E2E BC2.0 journeys.
// Config is read from ./config.json by default (copy of config.example.json).
// Pass -e ENV=<name> to use ./configs/<name>.json instead (one profile per
// environment — see configs/example.json), or -e CONFIG_FILE=<path> to point
// at an arbitrary file. The SSO token is NEVER read from any config file —
// pass it via -e SSO_TOKEN=... at runtime, same regardless of ENV.

import http from 'k6/http';
import { group, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const CFG_PATH = __ENV.ENV ? `./configs/${__ENV.ENV}.json` : (__ENV.CONFIG_FILE || './config.json');
export const CFG = JSON.parse(open(CFG_PATH));
export const SSO_TOKEN = __ENV.SSO_TOKEN || '';

export const DS  = (__ENV.DATA_SERVICE_URL || CFG.base_urls.data_service).replace(/\/+$/, '');
export const HPC = (__ENV.HPC_URL || CFG.base_urls.hpc).replace(/\/+$/, '');
export const OCR = (__ENV.OCR_URL || CFG.base_urls.ocr).replace(/\/+$/, '');

// ---- shared metrics ---------------------------------------------------------
// per-hop latency (ms)
export const T = {
  permohonan:  new Trend('e2e_permohonan_ms', true),
  upload:      new Trend('e2e_upload_ms', true),
  excel:       new Trend('e2e_excel_upload_ms', true),
  bundle:      new Trend('e2e_bundle_ms', true),
  ocr_create:  new Trend('e2e_ocr_create_ms', true),
  ocr_poll:    new Trend('e2e_ocr_poll_ms', true),   // submit->terminal (whole OCR job)
  ocr_submit:  new Trend('e2e_ocr_submit_ms', true),
  pengajuan:   new Trend('e2e_pengajuan_ms', true),
  review:      new Trend('e2e_review_ms', true),
};
export const journeyMs     = new Trend('e2e_journey_ms', true);   // full chain start->review
export const journeyFailed = new Rate('e2e_journey_failed');       // any hop failed
export const journeysDone  = new Counter('e2e_journeys');
export const hopFailed     = new Rate('e2e_hop_failed');           // per-request failure

// ---- helpers ----------------------------------------------------------------
export function headers(extra) {
  const h = Object.assign({}, extra || {});
  if (SSO_TOKEN) h['Authorization'] = `Bearer ${SSO_TOKEN}`;
  h['Accept-Language'] = 'id';
  return h;
}

export function jsonHeaders(extra) {
  return headers(Object.assign({ 'Content-Type': 'application/json' }, extra || {}));
}

// unique idRekam per journey run
export function newIdRekam() {
  return `e2e-${__VU}-${__ITER}-${Date.now()}`;
}

// tolerant field extractor across envelope shapes ({data:{...}} / flat / arrays)
export function pick(body, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = body;
    let ok = true;
    for (const part of parts) {
      if (cur == null) { ok = false; break; }
      if (part === '[0]') { cur = Array.isArray(cur) ? cur[0] : undefined; }
      else { cur = cur[part]; }
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
}

// record a hop: timing + pass/fail check. Returns { ok, res }.
export function hop(trend, res, okCond, label) {
  trend.add(res.timings.duration);
  const ok = okCond(res);
  hopFailed.add(!ok);
  if (!ok) {
    console.error(`[HOP FAIL] ${label} -> ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  return ok;
}

function finishJourney(t0, failed, ids) {
  journeyMs.add(Date.now() - t0);
  journeyFailed.add(failed);
  journeysDone.add(1);
  return Object.assign({ failed, ms: Date.now() - t0 }, ids);
}

// ---- journey runners ---------------------------------------------------------
// Reusable chain implementations, shared by journey_excel.js/journey_ocr.js and
// every other script that just wants to run the same chain under a different
// load shape (stress.js, spike.js, soak.js, concurrency.js). Each returns the
// IDs collected along the way (useful for concurrency/ID-collision checks).

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// o: { JENIS, CREATED, XLSX_BIN, XLSX_NAME }
export function runExcelJourney(o) {
  const { JENIS, CREATED, XLSX_BIN, XLSX_NAME } = o;
  const t0 = Date.now();
  const idRekam = newIdRekam();
  let idPermohonan = null, headerIdHpc = null, idHeaderDs = null;
  let failed = false;

  group('1_permohonan', () => {
    const body = { jenisDokumen: JENIS, idJobOcr: null, waktuKirim: new Date().toISOString(), nomorPermohonan: '' };
    const res = http.post(`${DS}/api/v1/permohonan`, JSON.stringify(body), { headers: jsonHeaders(), tags: { hop: 'permohonan' } });
    const ok = hop(T.permohonan, res, (r) => r.status >= 200 && r.status < 300, 'POST /permohonan');
    if (ok) { try { idPermohonan = pick(res.json(), ['data.idPermohonan', 'idPermohonan', 'data.id', 'id']); } catch (_) {} }
    if (!ok || !idPermohonan) failed = true;
  });
  if (failed) return finishJourney(t0, true, { idPermohonan, headerIdHpc, idHeaderDs });

  group('2_excel_upload', () => {
    const fd = { file: http.file(XLSX_BIN, XLSX_NAME, XLSX_MIME), createdBy: CREATED, id_rekam: idRekam };
    const res = http.post(`${HPC}/api/v1/excel/upload`, fd, { headers: headers(), tags: { hop: 'excel' } });
    const ok = hop(T.excel, res, (r) => r.status === 200, 'POST /excel/upload');
    if (ok) { try { headerIdHpc = pick(res.json(), ['data.header_id', 'data.headerId', 'header_id']); } catch (_) {} }
    if (!ok || !headerIdHpc) failed = true;
  });
  if (failed) return finishJourney(t0, true, { idPermohonan, headerIdHpc, idHeaderDs });

  group('3_bundle_forward', () => {
    const body = { idHeader: headerIdHpc, id_dokumen: JENIS, idRekam: idRekam, idPermohonan: idPermohonan };
    const res = http.post(`${HPC}/api/v1/data-service/ssm-impor-bundle`, JSON.stringify(body), { headers: jsonHeaders(), tags: { hop: 'bundle' } });
    const ok = hop(T.bundle, res, (r) => r.status >= 200 && r.status < 300, 'POST /data-service/ssm-impor-bundle');
    if (!ok) failed = true;
  });
  if (failed) return finishJourney(t0, true, { idPermohonan, headerIdHpc, idHeaderDs });

  group('4_pengajuan', () => {
    const res = http.get(`${DS}/api/v1/pengajuan?id_permohonan=${encodeURIComponent(idPermohonan)}`, { headers: headers(), tags: { hop: 'pengajuan' } });
    const ok = hop(T.pengajuan, res, (r) => r.status === 200, 'GET /pengajuan?id_permohonan');
    if (ok) { try { idHeaderDs = pick(res.json(), ['data.idHeader', 'data.[0].idHeader', 'data.headerAju.[0].idHeader', 'data.[0].headerAju.[0].idHeader']); } catch (_) {} }
    if (!ok) failed = true;   // idHeaderDs may be null if none created yet — review still attempted below if present
  });

  if (idHeaderDs) {
    group('5_review', () => {
      const res = http.get(`${DS}/api/v1/review-dan-submit?idPermohonan=${encodeURIComponent(idPermohonan)}`, { headers: headers(), tags: { hop: 'review' } });
      const ok = hop(T.review, res, (r) => r.status === 200, 'GET /review-dan-submit');
      if (!ok) failed = true;
    });
  }

  return finishJourney(t0, failed, { idPermohonan, headerIdHpc, idHeaderDs });
}

const OCR_TERMINAL = new Set(['success', 'failed', 'completed', 'error']);

// o: { JENIS, CREATED, OCR_FILES, POLL_S, MAX_WAIT }
export function runOcrJourney(o) {
  const { JENIS, CREATED, OCR_FILES, POLL_S, MAX_WAIT } = o;
  const t0 = Date.now();
  const idRekam = newIdRekam();
  let idPermohonan = null, jobId = null, idHeaderDs = null;
  const body = { invoices: [], packing_lists: [], bill_of_lading: [] };
  let failed = false;

  group('1_permohonan', () => {
    const b = { jenisDokumen: JENIS, idJobOcr: null, waktuKirim: new Date().toISOString(), nomorPermohonan: '' };
    const res = http.post(`${DS}/api/v1/permohonan`, JSON.stringify(b), { headers: jsonHeaders(), tags: { hop: 'permohonan' } });
    const ok = hop(T.permohonan, res, (r) => r.status >= 200 && r.status < 300, 'POST /permohonan');
    if (ok) { try { idPermohonan = pick(res.json(), ['data.idPermohonan', 'idPermohonan', 'data.id', 'id']); } catch (_) {} }
    if (!ok || !idPermohonan) failed = true;
  });
  if (failed) return finishJourney(t0, true, { idPermohonan, jobId, idHeaderDs });

  group('2_upload_files', () => {
    for (const f of OCR_FILES) {
      const fd = { file: http.file(f.bin, f.name), createBy: CREATED, dokumen: f.dokumen, version_dokumen: 'v1.0' };
      const res = http.post(`${DS}/api/v1/upload/file`, fd, { headers: headers(), tags: { hop: 'upload' } });
      const ok = hop(T.upload, res, (r) => r.status >= 200 && r.status < 300, 'POST /upload/file');
      let key = null, fname = f.name;
      if (ok) { try { const d = res.json(); key = pick(d, ['data.min_io_key', 'data.minio_key', 'data.key', 'data.path', 'min_io_key']); fname = pick(d, ['data.filename', 'data.file_name', 'filename']) || f.name; } catch (_) {} }
      if (!key) { failed = true; break; }
      (body[f.type] || body.invoices).push({ filename: fname, min_io_key: key });
    }
  });
  if (failed) return finishJourney(t0, true, { idPermohonan, jobId, idHeaderDs });

  group('3_ocr_create', () => {
    const res = http.post(`${OCR}/ocr/create`, JSON.stringify(body), { headers: jsonHeaders(), tags: { hop: 'ocr_create' } });
    const ok = hop(T.ocr_create, res, (r) => r.status === 202 || r.status === 200, 'POST /ocr/create');
    if (ok) { try { jobId = pick(res.json(), ['data.job_id', 'job_id', 'data.id', 'id']); } catch (_) {} }
    if (!ok || !jobId) failed = true;
  });
  if (failed) return finishJourney(t0, true, { idPermohonan, jobId, idHeaderDs });

  // 4. poll OCR until terminal — measured as one span (submit->terminal)
  group('4_ocr_poll', () => {
    const start = Date.now();
    let terminal = null;
    while ((Date.now() - start) / 1000 < MAX_WAIT) {
      sleep(POLL_S);
      const res = http.get(`${OCR}/ocr/getData/${jobId}`, { headers: headers(), tags: { hop: 'ocr_poll' } });
      if (res.status !== 200) continue;
      let status;
      try { status = String(pick(res.json(), ['data.status', 'status']) || '').toLowerCase(); } catch (_) { continue; }
      if (OCR_TERMINAL.has(status)) { terminal = status; break; }
    }
    T.ocr_poll.add(Date.now() - start);
    if (terminal !== 'success' && terminal !== 'completed') {
      console.error(`[HOP FAIL] OCR job ${jobId} ended '${terminal}' (not success)`);
      failed = true;
    }
  });
  if (failed) return finishJourney(t0, true, { idPermohonan, jobId, idHeaderDs });

  group('5_ocr_submit', () => {
    const b = { jenisDokumen: JENIS, idPermohonan: idPermohonan, idRekam: idRekam };
    const res = http.post(`${OCR}/ocr/submit/${jobId}`, JSON.stringify(b), { headers: jsonHeaders(), tags: { hop: 'ocr_submit' } });
    const ok = hop(T.ocr_submit, res, (r) => r.status >= 200 && r.status < 300, 'POST /ocr/submit');
    if (!ok) failed = true;
  });
  if (failed) return finishJourney(t0, true, { idPermohonan, jobId, idHeaderDs });

  group('6_pengajuan', () => {
    const res = http.get(`${DS}/api/v1/pengajuan?id_permohonan=${encodeURIComponent(idPermohonan)}`, { headers: headers(), tags: { hop: 'pengajuan' } });
    const ok = hop(T.pengajuan, res, (r) => r.status === 200, 'GET /pengajuan?id_permohonan');
    if (ok) { try { idHeaderDs = pick(res.json(), ['data.idHeader', 'data.[0].idHeader', 'data.headerAju.[0].idHeader', 'data.[0].headerAju.[0].idHeader']); } catch (_) {} }
    if (!ok) failed = true;
  });

  if (idHeaderDs) {
    group('7_review', () => {
      const res = http.get(`${DS}/api/v1/review-dan-submit?idPermohonan=${encodeURIComponent(idPermohonan)}`, { headers: headers(), tags: { hop: 'review' } });
      const ok = hop(T.review, res, (r) => r.status === 200, 'GET /review-dan-submit');
      if (!ok) failed = true;
    });
  }

  return finishJourney(t0, failed, { idPermohonan, jobId, idHeaderDs });
}
