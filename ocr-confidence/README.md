# OCR Confidence Score

Folder ini **cuma buat satu hal**: jalanin dokumen lewat OCR, **catet
`confident_score`-nya per dokumen**, dan bikinin **laporan** (skor + response
mentah + penjelasan kenapa skornya segitu) buat bahan tuning dev. Bukan load
test, bukan bagian dari `e2e-bc20/` (itu suite lain, fokusnya rantai
lintas-service buat 1 dokumen BC2.0) — ini berdiri sendiri, khusus buat
ngukur kualitas ekstraksi.

---

## Ground truth soal `confident_score`

Dicek langsung dari source `ocr-service` (`app/scoring/validator.py`), bukan
dugaan:

- **Dihitung in-house oleh `ocr-service` sendiri** — bukan skor dari OCR/LLM
  engine di baliknya (MinerU/Docling buat baca teks, Qwen via Ollama buat
  ekstraksi field; skor bukan dari situ). Formulanya:

  ```
  completeness = (jumlah field keisi) / (jumlah total field di row itu)
  grounding    = (persentase isi field yang beneran ketemu literal di raw OCR text)
  confident_score = round( sqrt(grounding * completeness) * 100, 1 )
  ```

  Geometric mean (bukan rata-rata biasa) sengaja dipilih biar row yang
  kebanyakan kosong gak bisa dapet skor "lumayan" cuma karena sedikit field
  yang keisi itu match sempurna — condong ke over-flag buat direview manual,
  bukan under-flag.

- **Skala 0-100**, **selalu angka** begitu row-nya ada (gak pernah `null` —
  balik `0.0` kalau emang gak ada yang bisa dicek).
- Muncul di `GET /ocr/getData/{job_id}` → path
  `data.result.<invoices|packing_lists|bill_of_lading>[].confident_score`
  — **cuma setelah status `completed`/`SUCCESS`**. Sebelum itu, `result`
  balik `{}` total (bukan array kosong per tipe dokumen).
- `result` juga bisa tetep `{}` walau status udah `SUCCESS`, kalau semua
  row di-skip backend (mis. ada field wajib yang kosong) — itu kondisi
  normal, bukan job gagal. Script ini bedain dua kasus itu di log-nya.

### Bisa ditunning?

**Enggak — karena emang belum ada apa-apa buat ditune.** Udah dicek grep
penuh ke seluruh `ocr-service` (code + config + `.env`) buat `threshold`,
`min_confidence`, `CONFIDENCE_THRESHOLD`, dst — **nol hasil**. Skor ini
murni data informatif buat keputusan review manual (HITL) di sisi konsumen;
gak pernah dipakai backend buat nge-gate `POST /ocr/submit`, retry, atau
apa pun. Karena algoritmanya kode in-house (bukan skor API pihak ketiga),
secara teknis tim backend OCR **bisa** nambahin threshold kalau mereka mau
— tapi itu fitur baru yang belum ada, di luar scope folder QA ini.

---

## Setup

```bash
cd ocr-confidence
cp config.example.json config.json
```

Isi `documents` di `config.json` — daftar dokumen yang mau dites, tiap entry:
`path` (relatif ke folder ini), `doc_type` (`invoice`/`packing_list`/
`bill_of_lading`/`auto`), `dokumen` (label buat upload, mis. `"Invoice (INV)"`).
Ada 1 contoh (`samples/invoice_sample.pdf`) buat starter — **idealnya diganti
dokumen asli**, soalnya dokumen sintetis bisa dapet skor aneh di pengecekan
grounding (isinya emang didesain minimal).

### Mode auto-detect (`doc_type: "auto"`)

Buat dokumen yang jenisnya gak jelas dari nama file (mis. hasil scan dengan
nama generik, gak ada text layer buat dibaca manual) — tandain
`"doc_type": "auto"` di `config.json`, gak usah nebak sendiri:

```json
{ "path": "samples/dokumen_gak_jelas.pdf", "doc_type": "auto", "dokumen": "Dokumen (belum diketahui jenisnya)" }
```

Script bakal upload dokumennya **sekali**, terus coba ekstrak ke **ketiga**
kemungkinan jenis (`invoice`, `packing_list`, `bill_of_lading`) — 3x
`POST /ocr/create` beda pakai `min_io_key` yang sama. Jenis yang
**completeness-nya paling tinggi** (field bisnis paling banyak keisi)
dianggap jenis yang bener, karena kalau jenisnya salah, extractor nyari
field yang emang gak ada di dokumen itu dan hasilnya kosong/rendah.

Laporan Excel/Word-nya nunjukin **ketiga percobaan** (bukan cuma yang menang)
biar transparan itu hasil perbandingan empiris. Kalau completeness dua
kandidat teratas mepet (beda <15 poin persen), ditandain **⚠️ AMBIGU** — gak
maksain pilih salah satu, minta dicek manual.

**Konsekuensi**: 1 dokumen `auto` = sampai 3x OCR job (lebih lambat + lebih
banyak beban ke OCR service dibanding dokumen yang udah jelas jenisnya) —
jangan pakein ke semua dokumen kalau jenisnya udah ketauan, cukup buat yang
beneran gak jelas.

## Jalanin

**Penting: tangkep OUTPUT LENGKAPNYA ke file** (bukan cuma diliat di layar),
soalnya laporan Excel/Word dibikin dari situ:

```bash
k6 run -e SSO_TOKEN=<bearer> confidence.js > run.log 2>&1
```

Satu dokumen = satu OCR job sendiri (**beda dari `e2e-bc20/journey_ocr.js`**
yang nggabung semua dokumen 1 submission jadi 1 job — di sini sengaja
dipisah biar skornya jelas ketauan punya dokumen mana).

`maxDuration` dihitung otomatis dari jumlah dokumen di `config.json` (worst
case: tiap dokumen non-auto sampai `MAX_WAIT_S`, dokumen `auto` sampai 3x
itu) — jadi run **gak akan keputus paksa** di tengah biarpun banyak dokumen.
Kalau dokumennya banyak/lambat, ini bisa makan waktu lama — sabar, atau
turunin `-e MAX_WAIT_S=90` (default 300) biar dokumen yang macet gak nunggu
kelamaan.

### Kalau kebanyakan hasilnya "Timeout"

OCR pipeline-nya (MinerU/Docling buat baca teks + Qwen via Ollama buat
ekstraksi) itu **self-hosted**, bukan API cloud yang cepet — buat dokumen
scan multi-halaman/multi-MB, proses beneran bisa lebih lama dari
`MAX_WAIT_S` yang dipasang, apalagi kalau lagi ada beban lain ke servernya.
Kalau job **konsisten timeout tepat di batas `MAX_WAIT_S`** (bukan gagal
cepet dengan error), itu tanda kuat dia **beneran masih diproses**, bukan
script-nya yang error.

Kolom **Detail** di laporan (lihat section "Laporan buat dev" di bawah)
bantu misahin dua kemungkinan itu: kalau isinya `status terakhir="processing"`
(atau status non-terminal lain) berarti job-nya emang masih jalan pas
nyerah nunggu — coba lagi dengan `MAX_WAIT_S` lebih gede (mis. 600-900).
Kalau isinya nunjuk banyak `non-200` atau `http terakhir` bukan 200, berarti
ada masalah lain (network/auth/service down) yang perlu dicek terpisah,
bukan soal waktu tunggu doang.

Buat lihat skor tiap dokumen langsung dari log:

```bash
grep OCR_CONFIDENCE run.log
```

Contoh baris output:

```
OCR_CONFIDENCE file=samples/invoice_sample.pdf doc_type=invoice job_id=abc-123 score=87.5
```

Pengaturan (`-e NAMA=nilai`): `POLL_INTERVAL_S`, `MAX_WAIT_S`,
`DATA_SERVICE_URL`/`OCR_URL` (override base URL).

### Watch value opsional (bukan aturan resmi)

```bash
k6 run -e SSO_TOKEN=<bearer> -e MIN_CONFIDENCE=70 confidence.js
```

Nge-track `Rate('ocr_low_confidence')` — proporsi dokumen di bawah angka
itu. **Ini murni angka pantauan yang QA tentuin sendiri**, bukan threshold
dari backend (karena emang gak ada, lihat bagian "Bisa ditunning?" di atas).
Default mati (`MIN_CONFIDENCE=0`).

---

## Laporan buat dev (Excel + Word)

**Kenapa 2 langkah (k6 dulu, baru generate laporan)**: k6 punya keterbatasan
teknis — `handleSummary()` (bagian yang nulis file di akhir run) jalan di
runtime JS yang **beda** dari runtime yang jalanin dokumen satu-satu, jadi
gak bisa langsung "lihat" detail per-dokumen yang udah diproses (dicek
langsung, bukan dugaan — versi awal script ini kena bug ini, laporannya
selalu bilang "0 dokumen" walau proses OCR-nya beneran jalan). Solusinya:
`confidence.js` nyatet tiap dokumen sebagai satu baris JSON di log
(`REPORT_ROW ...`), dan generate laporannya dipisah ke langkah kedua yang
baca log itu.

**Setup sekali** (butuh Node.js):

```bash
cd report
npm install
```

**Generate laporan** (dari folder `ocr-confidence/`, setelah run k6 di atas):

```bash
node report/build-report.js run.log
```

Ini bikin 2 file di `results/`:

- **`confidence-report-<timestamp>.xlsx`** — spreadsheet, 4 sheet:
  - **Summary** — 1 baris per dokumen (score, completeness %, implied
    grounding %, field kosong, status), warna hijau/kuning/merah biar gampang
    di-scan.
  - **Field Detail** — 1 baris per (dokumen, field): nilai + keisi atau
    enggak.
  - **Auto-Detect Attempts** — buat dokumen `doc_type: "auto"`, 1 baris per
    kandidat jenis yang dicoba, ditandain mana yang menang.
  - **Catatan** — batasan-batasan penting (lihat di bawah).
- **`confidence-report-<timestamp>.docx`** — dokumen Word naratif, 1 section
  per dokumen (score, completeness, implied grounding, tabel field), diakhiri
  section catatan yang sama.

Bisa dipanggil ulang kapan aja dari log yang sama (`run.log` gak berubah
walau OCR job-nya cuma jalan sekali) — mau generate ulang dengan nama file
beda: `node report/build-report.js run.log nama-lain`.

Isi laporan (kedua format sama):

- **Score** — `confident_score` aslinya dari backend.
- **Completeness** — berapa dari field bisnis yang keisi (dihitung ulang di
  sini dari daftar field yang sama persis dipakai `ocr-service`, jadi
  akurat), plus daftar field mana yang kosong.
- **Implied grounding** — angka yang **dibalikin secara aljabar** dari skor
  akhir (`grounding ≈ (score/100)² / completeness`), **bukan** angka asli
  dari backend (backend gak pernah nyimpen/nge-expose grounding secara
  terpisah — cuma hasil gabungannya, `confident_score`). Berguna buat
  misahin dua penyebab skor rendah yang beda:
  - **completeness rendah** → field-nya emang kosong/gak keekstrak (masalah
    di extraction coverage).
  - **completeness tinggi tapi implied grounding rendah** → field udah
    keisi tapi isinya kayaknya gak match teks dokumen aslinya (masalah di
    akurasi ekstraksi, bukan cakupan).
- **Tabel field** — tiap field bisnis, nilainya, keisi atau enggak.
- **Full response mentah** (`data.result.<type>[]` entry apa adanya) — buat
  dev yang mau liat detail lebih lanjut (`items`/`entitas`/`containers`, dsb)
  yang gak masuk tabel completeness.
- Dokumen yang gagal/timeout/gak ada record tersimpan juga masuk laporan,
  ditandain statusnya masing-masing (bukan cuma yang berhasil).
- **Kolom/baris Detail** (khusus dokumen yang timeout) — nunjukin berapa kali
  polling, berapa yang non-200, dan status job terakhir yang keliatan
  (mis. `"processing"`) sebelum nyerah. Bantu misahin "job-nya emang masih
  diproses" dari "ada yang error diem-diem" — lihat section "Kalau
  kebanyakan hasilnya Timeout" di atas.

**Batasan yang ditulis eksplisit di tiap laporan**: breakdown per-field mana
yang gak "grounded" (gak match teks OCR asli) **gak bisa direkonstruksi**
dari API sama sekali — `ocr-service` cuma nyimpen `confident_score` sebagai
1 angka akhir, hasil hitungan per-field-nya langsung dijumlah terus dibuang
(dicek langsung ke source `app/scoring/validator.py`, bukan dugaan). Kalau
dev butuh breakdown per-field yang presisi, itu perlu perubahan di
`ocr-service` sendiri (expose `raw_text` atau simpen hasil per-field) — di
luar yang bisa dikerjain dari suite QA ini.

---

## Cara baca hasilnya

Hasil k6 auto ke `results/` via `summary.js` (`.txt`/`.json`, metrik agregat —
pola sama kayak folder lain di repo ini) — ini kebuat otomatis tiap run.
Laporan Excel/Word (`.xlsx`/`.docx`, detail per-dokumen) **butuh langkah
terpisah** (lihat section "Laporan buat dev" di atas), gak otomatis.

- **`ocr_confidence_score`** (Trend) — distribusi skor sepanjang run
  (avg/min/p95). Ini angka agregat, buat detail per-dokumen liat
  laporan Excel/Word atau baris log di bawah.
- **Baris `OCR_CONFIDENCE ...` di output/log** — ringkasan per-dokumen di
  terminal (k6 metric gak nyimpen ini, makanya di-log terpisah). `score=NONE`
  berarti job sukses tapi gak ada row yang tersimpan (field wajib kosong,
  dsb) — bukan error, tapi worth dicek dokumennya.
- **`ocr_job_failed`** (Rate) — proporsi job yang gagal/timeout (bukan soal
  confidence, soal job-nya sendiri gak nyampe status sukses).
- **`ocr_low_confidence`** (Rate, cuma keisi kalau `MIN_CONFIDENCE` diset) —
  lihat catatan di atas, ini watch-value QA, bukan aturan resmi.

---

## Belum dicakup

- Gak ada re-run otomatis buat dokumen yang sama (cek konsistensi skor
  antar-run) — scope-nya sekarang "catat sekali per dokumen". Kalau nanti
  perlu analisis stabilitas skor, bisa nyusul.
- Gak ada gating pass/fail berbasis confidence — sesuai temuan di atas, gak
  ada dasarnya dari backend buat itu.

---

_Folder ini alat bantu QA/dev, berdiri sendiri, nggak nyampur sama
`e2e-bc20/` atau suite lain._
