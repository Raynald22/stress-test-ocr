# OCR Confidence Score

Folder ini **cuma buat satu hal**: jalanin dokumen lewat OCR, **catet
`confident_score`-nya per dokumen**, dan bikinin **laporan** (skor + response
mentah + penjelasan kenapa skornya segitu) buat bahan tuning dev. Bukan load
test, bukan bagian dari `e2e-bc20/` (itu suite lain, fokusnya rantai
lintas-service buat 1 dokumen BC2.0) — ini berdiri sendiri, khusus buat
ngukur kualitas ekstraksi.

---

## Cara testing — langkah demi langkah

Ringkasan praktis buat yang baru pertama kali pakai. Tiap langkah dijelasin
lebih detail di section-section di bawah — ini cuma alur cepatnya.

### 0. Setup (sekali aja)

```bash
cd ocr-confidence
cp config.example.json config.json      # kalau belum ada config.json
cd report && npm install && cd ..        # sekali aja, buat generate laporan nanti
```

Butuh **k6** ter-install ([panduan instalasi](https://grafana.com/docs/k6/latest/set-up/install-k6/)) dan **Node.js**.

### 1. Siapin dokumen

- Taruh file dokumen (PDF asli, bukan hasil generate) di `samples/`.
- Edit `documents` di `config.json` — 1 baris per dokumen:
  ```json
  { "path": "samples/nama_file.pdf", "doc_type": "invoice", "dokumen": "Invoice (INV)" }
  ```
  `doc_type`: `invoice` / `packing_list` / `bill_of_lading` — atau `auto`
  kalau gak yakin jenisnya (lihat section "Mode auto-detect" di bawah).

### 2. Siapin SSO token

Ambil token bearer dev yang fresh (tanya tim yang pegang akses dev/SSO).
**Token cuma tahan ~1 jam** — jangan diambil jauh-jauh hari sebelum run.
Jangan pernah taruh token di file manapun, cuma dipake langsung pas run
(`-e SSO_TOKEN=...`).

### 3. Jalanin

**Dokumen sedikit (≤ 6, gak ada `auto`)** — langsung semua sekaligus:

```bash
k6 run -e SSO_TOKEN=<token-dev> confidence.js > run.log 2>&1
```

**Dokumen banyak (> 6, atau ada beberapa `auto`)** — pecah jadi batch (lihat
section "Batch" di bawah kenapa ini penting, bukan cuma soal jumlah):

```bash
k6 run -e SSO_TOKEN=<token-dev> -e BATCH_SIZE=4 -e BATCH_INDEX=0 confidence.js > run-batch0.log 2>&1
k6 run -e SSO_TOKEN=<token-dev> -e BATCH_SIZE=4 -e BATCH_INDEX=1 confidence.js > run-batch1.log 2>&1
# ...ulangi, naikin BATCH_INDEX, sampai semua batch kelar
```

Tunggu sampai selesai (ada progress bar di terminal). Kalau layar diem lama,
itu normal — OCR beneran butuh waktu, bukan macet (lihat "Kebanyakan hasilnya
'Timeout'" di section Troubleshooting kalau ragu).

### 4. Bikin laporan

```bash
node report/build-report.js run.log
# atau, kalau tadi batch:
node report/build-report.js run-batch0.log run-batch1.log
```

### 5. Baca hasilnya

Buka `results/confidence-report-<timestamp>.xlsx` (atau `.docx`) — sheet
**Summary** adalah yang pertama dicek: kolom **Status**, **Score**,
**Completeness %**. Baris merah = gagal/belum kescore, ijo/kuning = udah
dapet skor. Kalau ada yang **Timeout**, cek kolom **Detail**-nya dulu sebelum
panik (lihat section troubleshooting di bawah).

File `.xlsx`/`.docx` inilah yang dikasih ke dev sebagai bahan tuning.

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

## Mode auto-detect (`doc_type: "auto"`)

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

---

## Paralel & Batch — kenapa, dan kapan perlu batch

Satu dokumen = satu OCR job sendiri (**beda dari `e2e-bc20/journey_ocr.js`**
yang nggabung semua dokumen 1 submission jadi 1 job — di sini sengaja
dipisah biar skornya jelas ketauan punya dokumen mana).

**Semua dokumen diproses PARALEL, bukan satu-satu** — 1 VU per dokumen,
jalan bareng (`vus = jumlah dokumen`). Ini sengaja, biar total waktu run
gak numpuk jadi jumlah semua dokumen (yang gampang ngelewatin umur token SSO
~1 jam kalau dokumennya banyak) — total waktu jadi kira-kira cuma setara
**dokumen paling lambat**, bukan jumlah semuanya. Contoh: 4 dokumen @
`MAX_WAIT_S=900` selesai dalam ~18 menit (bukan berjam-jam), aman jauh di
bawah 1 jam.

`maxDuration` dihitung otomatis (worst case: 1 dokumen sampai `MAX_WAIT_S`,
atau 3x itu kalau ada dokumen `auto` di `config.json`) — jadi run **gak akan
keputus paksa** di tengah.

**Paralel di sisi kita gak berarti paralel di sisi `ocr-service`.** Dicek
langsung ke source-nya: worker pool di backend mulai dari **1 proses**, naik
bertahap sampai maksimal **4**, dan concurrency asli ke Qwen/Ollama (tahap
ekstraksi) dibatasi ke **4 juga** — itu pun ke 1 server Ollama yang dipakai
bareng. Dokumentasi resmi backend-nya sendiri nyebut **drain rate cuma ~2
dokumen/menit**. Jadi ngirim banyak dokumen sekaligus **gak bikin backend-nya
proses lebih cepet** — dokumen di "ujung antrian" cuma nunggu lebih lama,
dan kalau `MAX_WAIT_S` gak cukup gede buat nutupin waktu antri itu, bakal
keliatan sebagai "Timeout" padahal sebenernya cuma masih ngantri. Solusinya:
**batch** — lihat section di bawah.

### Batch (buat dokumen banyak)

Kalau `documents` di `config.json` banyak (mis. >6-8), jangan jalanin
sekaligus — pecah jadi beberapa batch pakai `-e BATCH_SIZE=` dan
`-e BATCH_INDEX=` (0-based):

```bash
k6 run -e SSO_TOKEN=<bearer> -e BATCH_SIZE=4 -e BATCH_INDEX=0 confidence.js > run-batch0.log 2>&1
k6 run -e SSO_TOKEN=<bearer> -e BATCH_SIZE=4 -e BATCH_INDEX=1 confidence.js > run-batch1.log 2>&1
k6 run -e SSO_TOKEN=<bearer> -e BATCH_SIZE=4 -e BATCH_INDEX=2 confidence.js > run-batch2.log 2>&1
```

Script bakal nge-print di awal batch keberapa/dari-berapa dan dokumen mana
aja yang lagi diproses (`[ocr-confidence] batch 1/3: 4 document(s) — ...`).
Kalau `BATCH_INDEX` di luar jangkauan, langsung error jelas (bukan diem-diem
gak ngapa-ngapain).

Token SSO boleh beda-beda tiap batch (ambil fresh sebelum tiap batch kalau
mau aman) — gak masalah, tiap batch itu proses k6 yang independen.

Habis semua batch selesai, gabung semua log-nya jadi **satu laporan**:

```bash
node report/build-report.js run-batch0.log run-batch1.log run-batch2.log
```

---

## Troubleshooting

### Kebanyakan hasilnya "Timeout"

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

### Cek skor per-dokumen langsung dari log (tanpa nunggu laporan)

```bash
grep OCR_CONFIDENCE run.log
```

Contoh baris output:

```
OCR_CONFIDENCE file=samples/invoice_sample.pdf doc_type=invoice job_id=abc-123 score=87.5
```

### Semua pengaturan (`-e NAMA=nilai`)

`POLL_INTERVAL_S`, `MAX_WAIT_S`, `DATA_SERVICE_URL`/`OCR_URL` (override base
URL), `BATCH_SIZE`/`BATCH_INDEX` (lihat section "Batch" di atas).

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
# atau gabung beberapa batch jadi 1 laporan (lihat section "Batch"):
node report/build-report.js run-batch0.log run-batch1.log run-batch2.log
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
  diproses" dari "ada yang error diem-diem" — lihat section "Kebanyakan
  hasilnya 'Timeout'" (Troubleshooting) di atas.

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
