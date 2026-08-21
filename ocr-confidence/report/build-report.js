#!/usr/bin/env node
// Converts a captured k6 ocr-confidence run log into a formatted Excel (.xlsx)
// and Word (.docx) report.
//
// Why this exists as a separate step (not done inside k6 itself): k6 runs
// handleSummary() in a JS runtime that does NOT share state with the runtime
// that executed the VU code (verified empirically) — so any per-document
// detail collected during the run is invisible by the time handleSummary
// could write a file. confidence.js works around that by emitting one
// `REPORT_ROW <json>` line per document via console.log — this script reads
// that back out of the captured run log (k6 wraps console output as
// `msg="..."` with Go %q escaping, which happens to be JSON-string-escaping
// compatible, so it's unescaped via JSON.parse('"' + ... + '"')) and turns
// it into the two files.
//
// Usage:
//   k6 run -e SSO_TOKEN=<bearer> confidence.js > run.log 2>&1   (or | tee run.log)
//   node build-report.js run.log [output-basename]
//
// Output: ../results/<basename>.xlsx and ../results/<basename>.docx
// (basename defaults to a timestamp if not given).

'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, ShadingType,
} = require('docx');

const NOTES = [
  '"Implied grounding" adalah hasil balikan aljabar dari skor akhir ' +
  '(confident_score = round(sqrt(grounding * completeness) * 100, 1)), BUKAN angka asli dari backend. ' +
  '"completeness" dihitung ulang di sini dari daftar field bisnis yang sama persis dipakai ocr-service ' +
  '(app/store/document_mapping.py), jadi itu akurat; "grounding" dibalikin secara matematis dari situ, ' +
  'ada sedikit error karena pembulatan di source.',
  'Breakdown per-field mana yang gak "grounded" (gak match teks OCR asli) gak bisa direkonstruksi dari luar ' +
  'sama sekali -- ocr-service cuma nyimpen confident_score sebagai satu angka akhir, hasil hitungan ' +
  'per-field-nya langsung dijumlah lalu dibuang (dicek langsung ke source, bukan dugaan). Gak ada API/DB/log ' +
  'yang nyimpen raw_text atau breakdown per-field.',
  'Kalau butuh breakdown per-field yang presisi (buat tuning yang lebih detail), itu perlu perubahan di ' +
  'ocr-service sendiri -- expose raw_text atau simpen hasil per-field _is_grounded() di endpoint debug/verbose. ' +
  'Di luar yang bisa dikerjain dari suite QA ini.',
  'Gak ada threshold "aman"/"gak aman" resmi dari backend untuk skor ini -- baca README.md folder ocr-confidence/ buat detail.',
];

// ---- 1. parse the k6 log --------------------------------------------------

function parseLogFile(logPath) {
  const text = fs.readFileSync(logPath, 'utf8');
  const rows = [];
  const re = /msg="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let unescaped;
    try { unescaped = JSON.parse('"' + m[1] + '"'); } catch (e) { continue; }
    if (!unescaped.startsWith('REPORT_ROW ')) continue;
    const jsonPart = unescaped.slice('REPORT_ROW '.length);
    try { rows.push(JSON.parse(jsonPart)); } catch (e) {
      console.error('  (skip unparsable REPORT_ROW line: ' + e.message + ')');
    }
  }
  return rows;
}

// ---- 2. normalize into a flat shape for tabulation ------------------------

const STATUS_LABEL = {
  scored: 'Scored',
  no_record: 'Selesai, tapi tidak ada record tersimpan',
  no_score_field: 'Selesai, tapi field confident_score tidak ada',
  upload_failed: 'Gagal di step upload',
  ocr_create_failed: 'Gagal di step ocr/create',
  timeout: 'Timeout (tidak mencapai status terminal)',
  auto_detect: 'Auto-detect',
};
function statusLabel(status) {
  if (STATUS_LABEL[status]) return STATUS_LABEL[status];
  if (String(status).startsWith('job_')) return 'Job berakhir: ' + status.slice(4);
  return status;
}

function normalizeScored(file, configuredType, resolvedType, jobId, r) {
  const c = r.completeness;
  return {
    file, configuredType, resolvedType, status: 'scored', jobId,
    score: r.score,
    completenessPct: c && c.ratio !== null ? c.ratio * 100 : null,
    filledCount: c ? c.filled.length : null,
    totalCount: c ? c.fieldNames.length : null,
    emptyFields: c ? c.empty : [],
    groundingPct: r.grounding,
    fields: c ? c.fieldNames.map((name) => ({ name, value: r.rawRecord ? r.rawRecord[name] : undefined, filled: !c.empty.includes(name) })) : [],
    raw: r.rawRecord,
    autoAttempts: null,
    ambiguous: false,
  };
}

// Turns the raw REPORT_ROW list into one normalized row per document
// (auto-detect docs collapse to their winning attempt, with the full
// attempt comparison kept on .autoAttempts for its own sheet/section).
function normalizeRows(rawRows) {
  return rawRows.map((row) => {
    const file = row.doc ? row.doc.path : '(unknown)';
    const configuredType = row.doc ? row.doc.docType : '(unknown)';

    if (row.status === 'auto_detect') {
      if (row.winner) {
        const norm = normalizeScored(file, configuredType, row.winner.docType, row.winner.jobId, row.winner);
        norm.status = 'auto_detect';
        norm.ambiguous = !!row.ambiguous;
        norm.autoAttempts = row.attempts;
        return norm;
      }
      return {
        file, configuredType, resolvedType: null, status: 'auto_detect_failed', jobId: null,
        score: null, completenessPct: null, groundingPct: null, emptyFields: [], fields: [], raw: null,
        autoAttempts: row.attempts, ambiguous: false,
      };
    }

    if (row.status === 'scored') {
      return normalizeScored(file, configuredType, configuredType, row.jobId, row);
    }

    return {
      file, configuredType, resolvedType: configuredType, status: row.status, jobId: row.jobId || null,
      score: null, completenessPct: null, groundingPct: null, emptyFields: [], fields: [], raw: row.rawRecord || null,
      autoAttempts: null, ambiguous: false, note: pollNote(row),
    };
  });
}

// For timeouts specifically, confidence.js also records what it actually
// observed while polling (last job status seen, how many polls, how many
// got a non-200) -- surface that instead of leaving the row blank, since
// "timeout" alone doesn't say whether the job was genuinely still
// processing or something else was silently going wrong.
function pollNote(row) {
  if (row.status !== 'timeout') return '';
  const parts = [];
  if (row.pollCount !== undefined) parts.push(`${row.pollCount} polling, ${row.non200Count || 0} non-200`);
  if (row.lastSeenStatus) parts.push(`status terakhir="${row.lastSeenStatus}"`);
  if (row.lastHttpStatus !== undefined && row.lastHttpStatus !== null) parts.push(`http terakhir=${row.lastHttpStatus}`);
  return parts.join(', ');
}

// ---- 3. Excel --------------------------------------------------------------

async function buildExcel(rows, outPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ocr-confidence';
  wb.created = new Date();

  // Summary sheet
  const sum = wb.addWorksheet('Summary');
  sum.columns = [
    { header: 'No', key: 'no', width: 4 },
    { header: 'File', key: 'file', width: 42 },
    { header: 'Jenis (config)', key: 'configuredType', width: 14 },
    { header: 'Jenis (dipakai)', key: 'resolvedType', width: 16 },
    { header: 'Status', key: 'status', width: 26 },
    { header: 'Score', key: 'score', width: 9 },
    { header: 'Completeness %', key: 'completenessPct', width: 15 },
    { header: 'Implied Grounding %', key: 'groundingPct', width: 18 },
    { header: 'Field Kosong', key: 'emptyFields', width: 40 },
    { header: 'Job ID', key: 'jobId', width: 38 },
    { header: 'Detail', key: 'note', width: 45 },
  ];
  sum.getRow(1).font = { bold: true };
  sum.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  sum.views = [{ state: 'frozen', ySplit: 1 }];
  sum.autoFilter = { from: 'A1', to: 'K1' };

  rows.forEach((r, i) => {
    const row = sum.addRow({
      no: i + 1,
      file: r.file,
      configuredType: r.configuredType,
      resolvedType: r.resolvedType || '',
      status: statusLabel(r.status) + (r.ambiguous ? ' (AMBIGU)' : ''),
      score: r.score !== null && r.score !== undefined ? r.score : '',
      completenessPct: r.completenessPct !== null ? Number(r.completenessPct.toFixed(1)) : '',
      groundingPct: r.groundingPct !== null && r.groundingPct !== undefined ? Number(r.groundingPct.toFixed(1)) : '',
      emptyFields: (r.emptyFields || []).join(', '),
      jobId: r.jobId || '',
      note: r.note || '',
    });
    const isScored = r.status === 'scored' || r.status === 'auto_detect';
    const fill = isScored
      ? (r.ambiguous ? 'FFFFF2CC' : 'FFE2EFDA')
      : 'FFFCE4E4';
    row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }; });
  });

  // Field Detail sheet
  const fd = wb.addWorksheet('Field Detail');
  fd.columns = [
    { header: 'File', key: 'file', width: 42 },
    { header: 'Jenis', key: 'type', width: 14 },
    { header: 'Field', key: 'field', width: 28 },
    { header: 'Nilai', key: 'value', width: 40 },
    { header: 'Keisi?', key: 'filled', width: 8 },
  ];
  fd.getRow(1).font = { bold: true };
  fd.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  fd.views = [{ state: 'frozen', ySplit: 1 }];
  fd.autoFilter = { from: 'A1', to: 'E1' };
  for (const r of rows) {
    for (const f of r.fields) {
      const row = fd.addRow({ file: r.file, type: r.resolvedType, field: f.name, value: f.value === undefined || f.value === null || f.value === '' ? '(kosong)' : String(f.value), filled: f.filled ? 'Ya' : 'Tidak' });
      if (!f.filled) row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4E4' } }; });
    }
  }

  // Auto-Detect Attempts sheet
  const rowsWithAttempts = rows.filter((r) => r.autoAttempts);
  if (rowsWithAttempts.length) {
    const ad = wb.addWorksheet('Auto-Detect Attempts');
    ad.columns = [
      { header: 'File', key: 'file', width: 42 },
      { header: 'Kandidat', key: 'candidate', width: 14 },
      { header: 'Status', key: 'status', width: 20 },
      { header: 'Completeness %', key: 'completenessPct', width: 15 },
      { header: 'Score', key: 'score', width: 9 },
      { header: 'Terpilih?', key: 'selected', width: 10 },
      { header: 'Job ID', key: 'jobId', width: 38 },
      { header: 'Detail', key: 'note', width: 45 },
    ];
    ad.getRow(1).font = { bold: true };
    ad.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    ad.views = [{ state: 'frozen', ySplit: 1 }];
    ad.autoFilter = { from: 'A1', to: 'H1' };
    for (const r of rowsWithAttempts) {
      for (const a of r.autoAttempts) {
        const c = a.completeness;
        const isSelected = r.resolvedType === a.docType && r.jobId === a.jobId;
        const row = ad.addRow({
          file: r.file,
          candidate: a.docType,
          status: statusLabel(a.status),
          completenessPct: c && c.ratio !== null ? Number((c.ratio * 100).toFixed(1)) : '',
          score: a.status === 'scored' ? a.score : '',
          selected: isSelected ? 'Ya' : '',
          jobId: a.jobId || '',
          note: pollNote(a),
        });
        if (isSelected) row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }; });
      }
    }
  }

  // Notes sheet
  const notes = wb.addWorksheet('Catatan');
  notes.columns = [{ header: 'Catatan penting buat yang baca laporan ini', key: 'note', width: 120 }];
  notes.getRow(1).font = { bold: true };
  notes.getCell('A1').alignment = { wrapText: true };
  for (const n of NOTES) {
    const row = notes.addRow({ note: n });
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    row.height = 60;
  }

  await wb.xlsx.writeFile(outPath);
}

// ---- 4. Word ---------------------------------------------------------------

function statusColor(status) {
  if (status === 'scored' || status === 'auto_detect') return '2E7D32';
  return 'C62828';
}

function fieldsTableDocx(fields) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Field', 'Nilai', 'Keisi?'].map((h) => new TableCell({
      shading: { type: ShadingType.SOLID, color: 'DDEBF7', fill: 'DDEBF7' },
      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
    })),
  });
  const dataRows = fields.map((f) => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph(f.name)] }),
      new TableCell({ children: [new Paragraph(f.filled ? String(f.value) : '(kosong)')] }),
      new TableCell({
        shading: f.filled ? undefined : { type: ShadingType.SOLID, color: 'FCE4E4', fill: 'FCE4E4' },
        children: [new Paragraph(f.filled ? 'Ya' : 'Tidak')],
      }),
    ],
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

function attemptsTableDocx(attempts, winnerJobId) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Jenis dicoba', 'Completeness', 'Score', 'Status', 'job_id', 'Detail'].map((h) => new TableCell({
      shading: { type: ShadingType.SOLID, color: 'DDEBF7', fill: 'DDEBF7' },
      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
    })),
  });
  const dataRows = attempts.map((a) => {
    const c = a.completeness;
    const compStr = c && c.ratio !== null ? `${(c.ratio * 100).toFixed(1)}% (${c.filled.length}/${c.fieldNames.length})` : '-';
    const isWinner = a.jobId && a.jobId === winnerJobId;
    return new TableRow({
      children: [
        new TableCell({ shading: isWinner ? { type: ShadingType.SOLID, color: 'E2EFDA', fill: 'E2EFDA' } : undefined, children: [new Paragraph(a.docType)] }),
        new TableCell({ children: [new Paragraph(compStr)] }),
        new TableCell({ children: [new Paragraph(a.status === 'scored' ? String(a.score) : '-')] }),
        new TableCell({ children: [new Paragraph(statusLabel(a.status))] }),
        new TableCell({ children: [new Paragraph(a.jobId || '-')] }),
        new TableCell({ children: [new Paragraph(pollNote(a) || '-')] }),
      ],
    });
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] });
}

function buildDocxSections(rows) {
  const children = [];
  children.push(new Paragraph({ text: 'Laporan OCR Confidence Score', heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({ text: `Dibuat: ${new Date().toISOString()}   |   Jumlah dokumen: ${rows.length}` }));

  rows.forEach((r, i) => {
    children.push(new Paragraph({ text: `${i + 1}. ${r.file}`, heading: HeadingLevel.HEADING_1 }));

    if (r.autoAttempts) {
      children.push(new Paragraph({
        text: 'Nama file tidak menunjukkan jenis dokumen dengan jelas -- dicoba ekstrak ke 3 kemungkinan jenis, dibandingkan hasilnya:',
      }));
      children.push(attemptsTableDocx(r.autoAttempts, r.jobId));
      children.push(new Paragraph({ text: '' }));
      if (r.status === 'auto_detect_failed') {
        children.push(new Paragraph({ children: [new TextRun({ text: 'Gagal dideteksi -- tidak ada kandidat yang menghasilkan record ter-score. Cek manual.', bold: true, color: 'C62828' })] }));
        return;
      }
      children.push(new Paragraph({
        children: [new TextRun({ text: `-> Terdeteksi sebagai: ${r.resolvedType}`, bold: true })].concat(
          r.ambiguous ? [new TextRun({ text: '  [AMBIGU -- beda completeness dengan kandidat kedua tipis, cek manual]', bold: true, color: 'C62828' })] : []
        ),
      }));
    }

    if (r.status === 'scored' || r.status === 'auto_detect') {
      children.push(new Paragraph({
        children: [new TextRun({ text: `Score: ${r.score}`, bold: true, size: 28, color: statusColor(r.status) })],
      }));
      children.push(new Paragraph({
        text: `Completeness: ${r.filledCount}/${r.totalCount} field keisi (${r.completenessPct !== null ? r.completenessPct.toFixed(1) : '-'}%)` +
          (r.emptyFields.length ? ` -- kosong: ${r.emptyFields.join(', ')}` : ''),
      }));
      children.push(new Paragraph({
        text: `Implied grounding: ${r.groundingPct !== null && r.groundingPct !== undefined ? '~' + r.groundingPct.toFixed(1) + '%' : 'n/a (completeness 0)'} (dihitung dari formula, bukan angka asli backend -- lihat Catatan di akhir dokumen)`,
      }));
      children.push(fieldsTableDocx(r.fields));
    } else {
      children.push(new Paragraph({
        children: [new TextRun({ text: statusLabel(r.status), bold: true, color: statusColor(r.status) })],
      }));
      if (r.jobId) children.push(new Paragraph({ text: `job_id: ${r.jobId}` }));
      if (r.note) children.push(new Paragraph({ text: `Detail: ${r.note}` }));
    }
    children.push(new Paragraph({ text: '' }));
  });

  children.push(new Paragraph({ text: 'Catatan penting buat yang baca laporan ini', heading: HeadingLevel.HEADING_1 }));
  for (const n of NOTES) {
    children.push(new Paragraph({ text: n, bullet: { level: 0 } }));
  }

  return children;
}

async function buildDocx(rows, outPath) {
  const doc = new Document({
    sections: [{ properties: {}, children: buildDocxSections(rows) }],
  });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
}

// ---- main -------------------------------------------------------------

async function main() {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error('Usage: node build-report.js <run.log> [output-basename]');
    process.exit(1);
  }
  const ts = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
  const basename = process.argv[3] || `confidence-report-${ts}`;
  const resultsDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const rawRows = parseLogFile(logPath);
  if (rawRows.length === 0) {
    console.error(`No REPORT_ROW lines found in ${logPath}. Did the k6 run actually process any documents? ` +
      `(Capture the FULL k6 output, e.g. "k6 run ... confidence.js > run.log 2>&1", not just stderr.)`);
    process.exit(1);
  }
  const rows = normalizeRows(rawRows);

  const xlsxPath = path.join(resultsDir, `${basename}.xlsx`);
  const docxPath = path.join(resultsDir, `${basename}.docx`);
  await buildExcel(rows, xlsxPath);
  await buildDocx(rows, docxPath);

  console.log(`${rows.length} dokumen diproses.`);
  console.log(`Excel: ${xlsxPath}`);
  console.log(`Word:  ${docxPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
