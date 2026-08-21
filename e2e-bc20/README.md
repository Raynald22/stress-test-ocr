# Stress Test End-to-End BC2.0 (alur FE)

Suite ini nguji **perjalanan lengkap satu dokumen BC2.0** persis kayak yang FE
(`kepabeanan-smart-form`) lakuin — **lintas 3 backend** (data-service, HPC, OCR),
dengan **rantai ID nyambung antar-langkah**. Beda dari suite lain yang per-endpoint;
di sini kita ukur **waktu perjalanan utuh** + **di hop mana putus/melambat**.

Ada **2 cara** nguji, sesuai kebutuhan:

| Cara | Alat | Buat apa | Skala |
|---|---|---|---|
| **Replay alur API** | k6 (folder ini) | Beban berat — reproduksi persis request yang FE kirim | Ratusan/ribuan user |
| **Browser journey** | Playwright (`browser/`) | Validasi sisi FE (render, error JS, langkah UI) | Segelintir user |

Di layer k6, bukan cuma happy-path — folder ini nyakup **semua jenis stress
test** yang biasa dipakai buat nguji suatu alur end-to-end:

| File | Jenis | Ngapain |
|---|---|---|
| `smoke.js` | Smoke | Kejangkau + auth OK, read-only |
| `journey_excel.js` / `journey_ocr.js` | Load (flat) | Journey lengkap, VUS/durasi tetap |
| `negative.js` | Negative | Input/auth salah tiap hop → harus 4xx, jangan 500/hang |
| `robustness.js` | Robustness | File korup lewat upload → harus ditolak rapi, jangan diterima diam-diam |
| `concurrency.js` | Concurrency | Banyak VU mulai barengan → cek ID antar-VU jangan ketuker/kembar |
| `stress.js` | Stress/breakpoint | VUS naik bertahap → cari titik chain mulai jebol |
| `spike.js` | Spike | Lonjakan VUS mendadak → cek degradasi pas beban naik tiba-tiba |
| `soak.js` | Soak/endurance | VUS kecil, durasi panjang → cari leak/degradasi pelan-pelan |

> ⚠️ **Nulis data beneran** di HPC + data-service tiap run (bikin permohonan,
> upload, bundle, dst). **Cuma ke env dev/buangan.** Ini berlaku ke semua
> file di atas kecuali `smoke.js` — dan makin "berat" jenis testnya
> (stress/spike/soak), makin banyak row yang kebikin; lihat warning di tiap
> file/section masing-masing sebelum naikin defaultnya.
> 🔑 **Butuh SSO token** — kasih lewat `-e SSO_TOKEN=<bearer>` (jangan taruh di file).

---

## Dua journey (alur API, k6)

FE punya 2 jalur bikin BC2.0; suite ini nyediain dua-duanya:

### 1. `journey_excel.js` — jalur Excel (tanpa OCR, lebih cepat/stabil)

```
data-service  POST /api/v1/permohonan                 -> idPermohonan
HPC           POST /api/v1/excel/upload  (xlsx)        -> header_id
HPC           POST /api/v1/data-service/ssm-impor-bundle   (forward ke data-service)
data-service  GET  /api/v1/pengajuan?id_permohonan=..  -> idHeader
data-service  GET  /api/v1/review-dan-submit?idPermohonan=..
```

### 2. `journey_ocr.js` — jalur OCR smart-form (termasuk OCR async yang lambat)

```
data-service  POST /api/v1/permohonan                 -> idPermohonan
data-service  POST /api/v1/upload/file (per dokumen)   -> min_io_key
OCR           POST /ocr/create                         -> job_id
OCR           GET  /ocr/getData/{job_id}  (poll sampai selesai)
OCR           POST /ocr/submit/{job_id}                -> build bundle BC2.0 -> data-service
data-service  GET  /api/v1/pengajuan?id_permohonan=..  -> idHeader
data-service  GET  /api/v1/review-dan-submit?idPermohonan=..
```

Model **closed** (`constant-vus`): tiap virtual user jalanin seluruh rantai
berurutan, lalu ngulang. Kalau satu hop gagal, journey dianggap gagal dan
iterasi berhenti (hop sisanya di-skip).

---

## Yang perlu disiapin

- **k6** — https://grafana.com/docs/k6/latest/set-up/install-k6/
- **SSO token** valid dari dev → `-e SSO_TOKEN=<bearer>`.
- **`config.json`** — salin dari contoh, sesuaikan:
  ```bash
  cp config.example.json config.json
  ```
  Isi penting: `jenis_dokumen` (kode BC2.0, mis. `0207501` — tanya dev),
  `excel.template` (file **.xlsx BC2.0 valid dari dev**), `ocr.files` (dokumen
  yang mau di-OCR).
- **Sample file** (di `samples/`):
  - `bc20_template.xlsx` — **PLACEHOLDER**, ganti dengan template BC2.0 asli dari
    dev biar `journey_excel` beneran keparse.
  - `invoice_sample.pdf` — dokumen contoh buat `journey_ocr` (boleh diganti PDF asli).
  - `bad/` — file rusak statis buat `robustness.js` (xlsx kosong, bukan xlsx
    asli, xlsx ke-truncate, PDF korup). Gak perlu diganti, memang sengaja rusak.

---

## Banyak environment (`ENV=`)

Kalau QA perlu nembak ke instance dev lain, atau pakai `jenis_dokumen`/
template Excel yang beda-beda, gak perlu timpa `config.json` tiap kali
ganti target — simpen tiap target sebagai **profil terpisah** di `configs/`:

```bash
cp configs/example.json configs/dev2.json
# edit configs/dev2.json: base_urls / jenis_dokumen / excel.template / ocr.files
```

Lalu pakai lewat `-e ENV=<nama>` — berlaku ke **semua** script di folder ini
(`smoke.js`, `journey_excel.js`/`journey_ocr.js`, `negative.js`,
`robustness.js`, `concurrency.js`, `stress.js`, `spike.js`, `soak.js`), gak
perlu ganti command per-script karena semua baca config lewat titik yang
sama (`CFG` di `lib.js`):

```bash
k6 run -e ENV=dev2 -e SSO_TOKEN=<bearer> smoke.js
k6 run -e ENV=dev2 -e SSO_TOKEN=<bearer> -e VUS=5 -e DURATION=3m journey_excel.js
```

Gak diset `ENV`? Tetap pakai `config.json` di root seperti biasa (default,
gak ada yang berubah). Butuh path config custom di luar konvensi
`configs/<nama>.json`? Ada juga `-e CONFIG_FILE=<path>`.

`excel.template`/`ocr.files[].path` di tiap profil bisa nunjuk ke sample
file yang beda juga (mis. `samples/dev2_template.xlsx`) — gak perlu file
sample terpisah per-environment kecuali emang templatenya beda.

**`SSO_TOKEN` tetap terpisah dari config dan tetap diketik tiap run** lewat
`-e SSO_TOKEN=` — ini gak berubah walau `ENV` beda-beda, karena token
memang selalu ganti dan sengaja gak pernah disimpan di file.

---

## Langkah 1 — Smoke (jalanin duluan, read-only)

```bash
k6 run -e SSO_TOKEN=<bearer> smoke.js
```

Ngecek 3 backend kejangkau + **token SSO diterima** (nggak 401) — tanpa nulis
data apa pun. Kalau di sini 401 atau ada yang nggak 200, beresin dulu (token/URL)
sebelum lanjut ke journey yang nulis data.

## Langkah 2 — Journey Excel (dev only, nulis data)

```bash
k6 run -e SSO_TOKEN=<bearer> -e VUS=5 -e DURATION=3m journey_excel.js
```

## Langkah 3 — Journey OCR (dev only, lambat karena OCR async)

```bash
k6 run -e SSO_TOKEN=<bearer> -e VUS=2 -e DURATION=10m journey_ocr.js
```

Pengaturan (semua `-e NAMA=nilai`): `VUS`, `DURATION`, `JENIS_DOKUMEN`,
`P95_MS`, `MAX_FAIL_PCT`, `DATA_SERVICE_URL` / `HPC_URL` / `OCR_URL` (override
base URL), dan buat OCR: `POLL_INTERVAL_S`, `MAX_WAIT_S`.

---

## Langkah 4 — Negative (input/auth salah, gak nulis data beneran)

```bash
k6 run -e SSO_TOKEN=<bearer> negative.js
```

Satu VU, sekali jalan, isinya 12 pengecekan independen (bukan chain) ke
data-service/HPC/OCR: token kosong/invalid, body rusak/kosong, file bukan
xlsx, ID yang gak pernah ada buat tiap hop lanjutan, route ngasal. Aturan
sama kayak `negative.js` di suite lain: **gak boleh pernah 500 atau hang**,
harus balik 4xx yang masuk akal. Body yang malformed diharapkan ditolak
sebelum sempet nulis apa-apa.

## Langkah 5 — Robustness (file korup lewat upload)

```bash
k6 run -e SSO_TOKEN=<bearer> robustness.js
```

Lewatin beberapa file rusak dari `samples/bad/` (xlsx kosong, bukan xlsx
asli, xlsx ke-truncate, PDF korup) ke hop upload yang relevan. Cek: selalu
ada response jelas (gak hang), dan **gak ada yang diterima diam-diam
seolah sukses** — xlsx rusak harus ditolak `excel/upload`, dokumen korup
harus berakhir `FAILED`/`ERROR` di OCR (bukan `SUCCESS`).

## Langkah 6 — Concurrency (race condition di rantai ID)

```bash
k6 run -e SSO_TOKEN=<bearer> concurrency.js
```

`VUS` (default 20) VU mulai journey Excel barengan, sekali iterasi masing-
masing. Tiap yang sukses nge-log `CONCURRENCY_ID vu=.. idPermohonan=..
idHeader=..`. Habis run, cek ada ID kembar antar-VU (indikasi race di
sequence/lock) — pola sama kayak `data-service/nomoraju.js`:

```bash
k6 run -e SSO_TOKEN=<bearer> concurrency.js 2>&1 | grep CONCURRENCY_ID \
  | sed -n 's/.*idPermohonan=\([^ ]*\).*/\1/p' | sort | uniq -d
```

Kosong = aman. Ada baris keluar = ada `idPermohonan` yang dobel dipake dua VU.

## Langkah 7 — Stress/breakpoint (VUS naik bertahap)

```bash
k6 run -e SSO_TOKEN=<bearer> stress.js
```

VUS naik tahap demi tahap (default `1,5,10,20,40`, tiap tahap 2 menit —
atur lewat `STAGE_VUS`/`STAGE_MINUTES`/`RAMP_SECONDS`). Perhatiin
`e2e_journey_ms`/`e2e_journey_failed` sepanjang run (bukan cuma angka akhir)
buat nemuin di tahap VUS berapa chain mulai melambat/gagal — itu kapasitas
maksimumnya. `MODE=excel` (default) atau `MODE=ocr`.

> ⚠️ Ramp default penuh (1→5→10→20→40, ~15 menit) bisa nyipta ratusan row
> permohonan di dev. Kabarin dev dulu kalau mau naikin `STAGE_VUS` lebih
> tinggi dari default.

## Langkah 8 — Spike (lonjakan mendadak)

```bash
k6 run -e SSO_TOKEN=<bearer> spike.js
```

VUS baseline rendah → lompat cepat ke `SPIKE_VUS` (default 15) selama
`SPIKE_DURATION` (default 30s) → turun lagi. Ngecek apakah chain (terutama
insert/lock di data-service) degradasi rapi atau malah collapse pas beban
naik tiba-tiba. Default sengaja kecil/singkat.

## Langkah 9 — Soak/endurance (opsional, koordinasi dev)

```bash
k6 run -e SSO_TOKEN=<bearer> soak.js
k6 run -e SSO_TOKEN=<bearer> -e VUS=3 -e DURATION=30m soak.js
```

VUS kecil-sedang konstan, durasi panjang (default 10m biar gak kejalanin
gak sengaja; soak beneran butuh `-e DURATION=` lebih panjang, mis. 30m-
beberapa jam). Nyari degradasi pelan-pelan (koneksi DB gak ke-release,
antrian OCR numpuk) yang gak kelihatan di run pendek. **Koordinasi sama dev
dulu** sebelum jalanin durasi panjang — ini yang paling banyak nulis data
dari semua test di sini.

Semua Langkah 4-9 (kecuali `negative.js`) juga nerima setting yang sama
kayak Langkah 2/3: `JENIS_DOKUMEN`, `P95_MS`, `MAX_FAIL_PCT`,
`DATA_SERVICE_URL`/`HPC_URL`/`OCR_URL`, dan buat `MODE=ocr`:
`POLL_INTERVAL_S`, `MAX_WAIT_S`.

---

## Cara baca hasilnya

Hasil auto ke `results/` (`.txt` + `.json`). Metrik kunci:

- **`e2e_journey_ms`** — waktu perjalanan **utuh** (p95). Ini angka headline E2E.
- **`e2e_journey_failed`** — persen journey yang gagal (ada hop putus).
- **Per-hop** (`e2e_permohonan_ms`, `e2e_excel_upload_ms`, `e2e_bundle_ms`,
  `e2e_ocr_create_ms`, `e2e_ocr_poll_ms`, `e2e_ocr_submit_ms`, `e2e_pengajuan_ms`,
  `e2e_review_ms`) — **buat nemuin hop mana yang jadi biang lambat**. Kalau
  `e2e_journey_ms` naik, lihat per-hop buat tau penyebabnya di service mana.
- **`e2e_hop_failed`** — porsi request per-hop yang gagal.

Tiap hop juga di-tag (`hop:...`) dan dibungkus `group`, jadi kelihatan di output k6.

Metrik tambahan khusus test baru:

- **`e2e_negative_5xx`** (negative.js) — harus selalu 0. Kalau ada, berarti
  ada input salah yang bikin server 500/hang, bukan ditolak rapi.
- **`e2e_negative_unexpected_status`** — status yang gak masuk daftar
  ekspektasi tapi juga bukan 5xx (worth dilihat, gak nge-fail run).
- **`e2e_robustness_rejected`** / **`e2e_robustness_silently_accepted`**
  (robustness.js) — proporsi file korup yang ditolak rapi vs yang malah
  keterima seolah sukses. `silently_accepted` harus selalu 0.
- **Concurrency** (concurrency.js) gak punya metric k6 khusus — cek manual
  lewat log `CONCURRENCY_ID` (lihat Langkah 6).
- **Stress/spike/soak** pakai metric yang sama kayak journey biasa
  (`e2e_journey_ms`, `e2e_journey_failed`) — bedanya, lihat **trennya
  sepanjang run**, bukan cuma angka akhir.

---

## Browser journey (validasi FE) — folder `browser/`

Buat **beberapa user** lewat FE beneran (Playwright), ukur render + tangkap error
sisi FE. **Bukan** buat beban skala besar.

```bash
cd browser
npm install
npm run install:browsers
FE_URL=<url FE> SSO_TOKEN=<bearer> USERS=3 npm test
```

Harness-nya (inject sesi SSO lewat `sessionStorage`/`localStorage` token +
cookie `_aid` jaga-jaga, timing, tangkap console error, screenshot/trace saat
gagal) **udah siap**. Langkah klik di `journey.spec.ts` udah di-wire ke DOM
asli FE (Data Pengajuan → Pengajuan → Buat Manual → Buat Baru → pilih BC 2.0
→ Lewati Upload → Review & Submit), berdasarkan source `kepabeanan-smart-form`
— tapi **belum divalidasi live**, jadi jalanin sekali dengan `USERS=1` dulu
buat mastiin selector-nya cocok sebelum dipakai rutin (kalau ada perubahan
label/role di FE, gampang ketahuan dari trace/screenshot on-failure).

Journey ini **berhenti di halaman Review & Submit** (assert render + status
kelengkapan) dan **gak** klik tombol Submit final — biar gak nambah
submission "selesai" beneran tiap run. Sampai di situ aja udah bikin draft
permohonan di dev (sama kayak journey k6 lainnya).

`USERS` sekarang beneran ngontrol jumlah user paralel (dipakai buat `workers`
maupun `repeatEach`), jadi `USERS=3` bakal jalanin journey yang sama 3x
konkuren, bukan cuma 1x.

---

## Catatan penting

- **Rantai ID**: `idPermohonan` (dari permohonan) → `header_id` (dari excel upload,
  jalur Excel) / `job_id` (jalur OCR) → `idHeader` data-service (dari
  `pengajuan?id_permohonan`) → dipakai `review-dan-submit`. Kalau salah satu ID
  nggak kebalikin, hop-nya ditandai gagal dan kelihatan di log.
- **Response `idHeader` bisa beda bentuk** antar-env; extractor-nya udah dibikin
  toleran (`data.idHeader`, `data[0].idHeader`, `data.headerAju[0].idHeader`, dll).
  Kalau ternyata beda, gampang ditambah di `lib.js` fungsi `pick`.
- **Insert-only / nambah data** — jalanin ke dev, dan kabarin dev buat mantau DB
  (pool koneksi, lock) + Temporal/queue OCR pas journey OCR jalan.

## Belum dicakup

- **Rate-limit test** — data-service/HPC/OCR (beda dari `legacy/`) gak punya
  rate limiter built-in, jadi gak ada yang bisa dites di sisi ini.
- **Volume test terpisah** — kasus file oversize udah kesenggol di
  `robustness.js`, belum ada script volume tersendiri (ngikutin pola suite
  lain yang juga gak punya).
- **Idempotency test setara `ocr/idempotency.js`** — journey ini bikin
  dokumen baru tiap kali (beda konteks dari submit job OCR berulang di
  `ocr/`); belum ada padanannya di sini.

---

_Folder ini alat bantu QA/dev, berdiri sendiri, nggak nyampur sama kode service/FE._
