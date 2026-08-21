# Panduan Stress Test HPC Service (untuk QA)

Folder ini isinya alat buat **nguji beban (stress test)** service **kepabeanan-hpc**
— REST API (Go/Fiber) buat CRUD dokumen kepabeanan (BC16/BC20/BC23/FTZ01) dan
upload Excel→JSON. Kamu (QA) **nggak perlu ngoding**. Cukup jalanin skrip k6 yang
sudah disiapin, lalu baca hasilnya.

> Ini **beda** dari folder `ocr/`. OCR itu async (kirim job → tunggu). HPC ini
> **sinkron**: satu request langsung dapat jawaban. Jadi di sini kita ngukur
> **latency (p95)** dan **throughput (request per detik)** ala API biasa —
> bukan waktu antrian job.

---

## Kenapa HPC beda dari OCR

**1. Sinkron.** `GET /api/v1/bc20/header` atau `POST /api/v1/excel/upload`
langsung balikin hasil di response itu juga. Nggak ada `job_id`, nggak ada
polling. Yang kita kejar: **seberapa banyak request per detik** yang kuat
dilayani sebelum latency naik atau mulai error.

**2. Ada 2 jenis beban.**
- **Baca (read)** — endpoint `GET` list/by-id. Ringan, cuma query DB. Aman
  di-hammer sekencang apapun karena **nggak ngubah data**. Ini buat cari batas
  throughput baca API + Postgres.
- **Upload Excel** — `POST /api/v1/excel/upload`. Ini **jalur berat**: parse
  file Excel → simpan ke MinIO → insert banyak baris ke DB. Ini padanannya "job
  berat" di OCR. **Nulis data**, jadi cuma boleh dijalanin ke **environment
  dev/buangan**.

**3. Semua jawaban pakai amplop standar** `{ success, message, data, error }`.

---

## Yang perlu disiapin

- **k6** — https://grafana.com/docs/k6/latest/set-up/install-k6/
- **Alamat server** — sudah di-set default ke `https://dev-backend.insw.go.id/kepabeanan-hpc`
  di semua skrip, jadi `-e BASE_URL=...` **opsional** (cuma perlu kalau mau
  nembak env lain, misal lokal `http://localhost:3000`).
- **Token — WAJIB.** Semua route `/api/v1/*` (CRUD, excel, file) dilindungi
  middleware SSO (`internal/middleware/sso_auth.go`): tanpa header `Authorization`
  atau dengan token yang nggak valid, request langsung **401** sebelum sampai ke
  handler-nya (jadi test seolah-olah "gagal total" padahal endpoint/param-nya
  sendiri benar). Minta bearer token SSO dev yang valid ke dev, lalu tambahin
  `-e AUTH_TOKEN=<token>` di **setiap** perintah k6 di bawah. Cuma `GET /healthz`
  dan `GET /` yang bebas auth.
- **`targets.json`** — daftar endpoint yang mau dites. Salin dari contoh:
  ```bash
  cp targets.example.json targets.json
  ```
  Lalu buang endpoint yang nggak relevan. Kalau mau tes `GET /:id`, isi
  `get_by_id` pakai **UUID yang beneran ada** di DB dev (minta ke dev).
- (Buat tes upload) **file `.xlsx` template valid** dari dev, taruh di
  `samples/` dan tunjuk di `targets.json` → `upload.sample_xlsx`.

> Catatan: `targets.json` harus ada di folder `hpc/` ini (sebelah skrip k6).

---

## Isi folder ini

| File | Gunanya |
|---|---|
| `smoke.js` | Cek 1x: server hidup + amplop response bener. **Jalanin duluan.** |
| `hpc_stress.js` | Tes beban utama. `MODE=read` (baca) atau `MODE=upload` (Excel). |
| `negative.js` | Tes input salah di level API (harus ditolak sopan, bukan 500/hang). |
| `robustness.js` | Tes file Excel rusak/aneh di `/excel/upload` (harus gagal rapi). |
| `make_bad_xlsx.py` | (dev) bikin korpus file Excel jelek buat `robustness.js`. |
| `summary.js` | Dipakai skrip lain buat auto-simpan hasil. Jangan dijalanin langsung. |
| `targets.example.json` | Contoh daftar endpoint. Salin jadi `targets.json`. |
| `samples/` | Tempat file `.xlsx` template + korpus file jelek. |
| `results/` | Tempat laporan hasil tersimpan otomatis. |

Urutan biasa: **smoke → hpc_stress (read) → hpc_stress (upload) → negative → robustness**.

---

## Langkah 1 — Smoke test (jalanin duluan)

Mastiin alamat server bener dan response-nya sesuai bentuk yang diharapkan
(status 200 + amplop `success:true`), pakai beberapa request aja.

```bash
k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc \
       -e AUTH_TOKEN=<token-sso-dev> smoke.js
```

Yang dicek: `GET /healthz` → 200, `GET /` → info service, dan endpoint baca
pertama di `targets.json` → 200 dengan amplop bener. Kalau `AUTH_TOKEN` kosong/
salah, endpoint baca bakal balik **401** (bukan salah alamat/targets) — cek
token dulu sebelum curiga ke tempat lain. Kalau ini gagal, **jangan lanjut** —
beresin dulu token/alamat/targets-nya.

Mau sekalian nyoba 1 upload? Siapin template valid di `targets.json`, lalu:

```bash
k6 run -e BASE_URL=... -e AUTH_TOKEN=<token-sso-dev> -e UPLOAD=1 smoke.js
```

---

## Langkah 2 — Tes beban baca (read)

Ini yang paling aman dan paling sering dipakai: hammer endpoint `GET` dengan
kecepatan tetap, ukur latency + error rate. **Nggak ngubah data.**

```bash
# 50 request/detik selama 5 menit
k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc \
       -e AUTH_TOKEN=<token-sso-dev> \
       -e MODE=read -e RATE=50 -e UNIT=1s -e DURATION=5m hpc_stress.js
```

Pengaturan (semua pakai `-e NAMA=nilai`):

| Pengaturan | Default | Artinya |
|---|---|---|
| `MODE` | `read` | `read` (GET) atau `upload` (Excel) |
| `RATE` + `UNIT` | `50` + `1s` | Berapa request per satuan waktu (50 per detik) |
| `DURATION` | `5m` | Berapa lama tes jalan |
| `MAX_VUS` | `100` | Batas atas "user" paralel |
| `P95_MS` | `800` (read) / `10000` (upload) | Target latency p95 (lolos/gagal) |
| `MAX_FAIL_PCT` | `0.01` | Batas maksimal request gagal (0.01 = 1%) |

**Tips:** mulai pelan (`RATE=10`), naikkan tiap run sampai `hpc_read_ms` (p95)
mulai naik tajam atau `hpc_req_failed` naik. Titik itu **batas kemampuan** baca-nya.

---

## Langkah 3 — Tes beban upload Excel (jalur berat)

⚠️ **Nulis data ke DB + MinIO. Cuma jalanin ke environment dev/buangan.**
Butuh template `.xlsx` valid dari dev (ditunjuk di `targets.json` → `upload`).

```bash
# 2 upload/detik selama 3 menit
k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc \
       -e AUTH_TOKEN=<token-sso-dev> \
       -e MODE=upload -e RATE=2 -e UNIT=1s -e DURATION=3m hpc_stress.js
```

Yang diukur: `hpc_upload_ms` (latency upload) dan `hpc_req_failed`. Karena ini
berat, `RATE` pasti jauh lebih kecil dari mode read. Naikkan pelan-pelan.

---

## Langkah 4 — Tes input salah (negative)

Ngecek server nolak input jelek **dengan sopan** (kode 4xx yang benar), bukan
500 atau nge-hang:

```bash
k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc \
       -e AUTH_TOKEN=<token-sso-dev> negative.js
```

Yang diuji antara lain: `GET /:id` dengan UUID ngawur (400) & UUID nggak ada
(404), body JSON rusak (400), update tanpa ID (400), `/file` tanpa parameter
(400), upload tanpa file (400), upload `.txt` (415), upload tanpa `createdBy`
(400), dan route ngaco (404). Aturan utama: **nggak boleh ada yang jadi 5xx atau
hang.**

Default resource yang diprobe `/api/v1/bc20/header` (handler-nya generik, sama
buat semua). Ganti pakai `-e RESOURCE=/api/v1/ftz01/barang` kalau mau.

---

## Langkah 5 — Tes file Excel rusak (robustness)

Ngecek `/excel/upload` **gagal dengan rapi** waktu ketemu file jelek — bukan
nge-hang atau nerima sampah. Dev/QA nyiapin korpus file dulu:

```bash
pip install openpyxl
python make_bad_xlsx.py     # -> samples/bad/*.xlsx + samples/bad_manifest.json
```

Korpusnya: file bukan-zip yang disamarin `.xlsx`, file 0 byte, file kegedean
(>10MB → harus 413), file kepotong, xlsx kosong, xlsx valid tapi nggak ada
`id_doc`/skema-nya nggak dikenal, dan xlsx 50rb baris (berat). Lalu:

```bash
k6 run -e BASE_URL=https://dev-backend.insw.go.id/kepabeanan-hpc \
       -e AUTH_TOKEN=<token-sso-dev> robustness.js
```

Aturan utamanya: **tiap upload harus balik dengan status HTTP beneran (nggak
hang)**, file sampah harus **ditolak (>=400)**, dan **nggak boleh ada yang balik
200/"success" buat file sampah**. Skrip nampilin file mana yang malah diterima
(mencurigakan — layak dilaporin) dan mana yang bikin 500.

---

## Cara baca hasilnya

**Hasil otomatis tersimpan.** Tiap tes k6 selesai, laporannya ditulis ke folder
**`results/`** dengan nama ber-timestamp: `.txt` (enak dibaca / lampiran bug
report) dan `.json` (angka lengkap). Ringkasan tetap muncul di layar. Jalanin k6
dari **dalam folder `hpc/` ini** biar `results/` kebaca.

Yang penting diperhatiin:

- **`hpc_read_ms` / `hpc_upload_ms`** — latency request. Lihat `p95`. Kalau naik
  terus selama tes = sudah lewat batas kemampuan.
- **`hpc_req_failed`** — persentase request gagal (non-2xx yang nggak wajar).
  Makin kecil makin bagus.
- **`http_req_failed`** — kegagalan di level transport/5xx.

k6 otomatis nandain **LULUS/GAGAL** berdasarkan target `P95_MS` dan
`MAX_FAIL_PCT`.

---

## Referensi endpoint (dari kode service)

- Health: `GET /healthz` → 200 (body kosong). Info: `GET /` → JSON.
- Base path semua API: `/api/v1` (kalau ada `SERVER_SUBPATH`, jadi
  `{subpath}/api/v1` — biasanya sudah termasuk di `BASE_URL`).
- Excel: `POST /api/v1/excel/upload` & `/excel/upload-barang`
  (multipart: `file` `.xlsx`, `createdBy`, `id_rekam`), `GET /api/v1/excel/download?objectName=`.
- File: `GET /api/v1/file?id=|filename=`, `DELETE /api/v1/file?id=|filename=`.
- CRUD (buat tiap `bc16` `bc20` `bc23` `ftz01`) dengan sub-resource
  `header`, `barang`, `barang-tarif`, `barang-vd`, `dokumen`, `entitas`,
  `karantina`, `karantina-barang`, `kemasan`, `kontainer`, `spesifikasi-wajib`,
  `transaksi-detail`, `barang-dokumen`. Pola: `POST ""` (create), `GET ""`
  (list), `GET /:id`, `PUT ""` (update, id di body), `DELETE /:id`.
- Validasi umum: UUID ngawur → 400, data nggak ada → 404, body rusak → 400,
  upload non-`.xlsx` → 415, upload > 10MB → 413.
- Dokumentasi lengkap (Swagger) ada di `GET /docs` atau `GET /swagger`.

---

_Folder ini alat bantu QA/dev, berdiri sendiri (cuma butuh k6 + Python), dan
nggak nyampur sama kode service. Nggak ikut ke-deploy bareng aplikasinya._
