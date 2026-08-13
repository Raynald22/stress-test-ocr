# Panduan Stress Test OCR Service (untuk QA)

Folder ini isinya alat buat **nguji beban (stress test)** OCR service. Kamu
(QA) **nggak perlu ngoding atau ngutak-atik repo**. Cukup jalanin skrip yang
sudah disiapin, lalu baca hasilnya.

Yang perlu kamu tahu duluan: dev/ops nyiapin **daftar file uji** (`keys.json`)
dan ngasih kamu **alamat server** yang mau dites. Setelah itu tinggal jalanin
k6 dan lihat laporannya.

---

## Kenapa OCR service ini beda dari API biasa

Ada 2 hal yang wajib dipahami, karena ini yang bikin cara ngetesnya nggak sama
kayak API pada umumnya:

**1. Prosesnya "nitip dulu, hasil belakangan" (async).**
Waktu kita panggil `POST /ocr/create`, server **belum langsung ngerjain OCR**.
Dia cuma nerima pekerjaan, ngasih nomor antrian (`job_id`), lalu jawab "oke,
diterima" (kode 202). Pekerjaan OCR-nya jalan di belakang layar.

Jadi kita nggak bisa cuma ngukur "berapa cepat server jawab". Yang bener:
kirim job → **cek terus** pakai `GET /ocr/getData/{job_id}` sampai statusnya
`SUCCESS` (berhasil) atau `FAILED` (gagal). Yang kita ukur adalah **berapa lama
satu job selesai dari awal sampai akhir**, dan **seberapa numpuk antriannya**.

**2. `POST /ocr/create` nggak nerima file PDF langsung.**
Yang dikirim ke API cuma **"alamat" file** (`min_io_key`) — yaitu PDF yang
**sudah di-upload duluan** ke penyimpanan (MinIO). Jadi kamu nggak bisa
lampirin PDF langsung ke API OCR. File-nya harus di-taruh dulu di MinIO, baru
alamatnya dipakai. Nyiapin file + alamat ini tugasnya dev/ops (lihat Langkah 1).

**Konsekuensinya:** karena di belakang layar jalan OCR + AI beneran, satu job
bisa makan waktu **puluhan detik sampai beberapa menit**. Jadi jumlah job per
detik pasti kecil. Kita **bukan** ngejar "ribuan request per detik" — kita
nguji seberapa kuat sistem nampung antrian dan apakah dia **gagal dengan rapi**
saat kebanjiran, bukan tiba-tiba error/hang.

---

## Yang perlu disiapin

- **k6** (alat load test) di komputer kamu.
  Cara install: https://grafana.com/docs/k6/latest/set-up/install-k6/
- **Alamat server** — sudah di-set default ke
  `https://dev-backend.insw.go.id/kepabeanan-ocr` di semua skrip, jadi
  `-e BASE_URL=...` **opsional** (cuma perlu kalau nembak env lain).
- **Token** — **nggak perlu**. Service ini nggak pakai auth. Perintah di bawah
  nggak butuh token.
- File **`keys.json`** (dari dev) — daftar file uji. Contoh isinya ada di
  `keys.example.json`.

> Catatan: `keys.json` harus ada di folder yang sama dengan skrip k6.

---

## Isi folder ini

| File | Gunanya |
|---|---|
| `smoke.js` | Tes 1 job (cek koneksi & data bener). **Jalanin duluan.** |
| `ocr_stress.js` | Tes beban utama (load/throughput). |
| `negative.js` | Tes input salah di level API. |
| `idempotency.js` | Tes kirim job yang sama 2x beruntun (duplicate submission). |
| `robustness.js` | Tes file rusak (OCR gagal dengan rapi). |
| `limits.js` | Tes correctness (data hasil OCR bener, bukan cuma "ada isinya") + tes limit 15 barang. |
| `seed_min_io_keys.py` | (dev) nyiapin file uji ke MinIO + bikin `keys.json`. |
| `chaos_probe.py` | (dev) pemandu tes ketahanan (matiin RabbitMQ/DB/dll). |
| `summary.js` | Dipakai skrip lain buat auto-simpan hasil. Jangan dijalanin langsung. |
| `FINDINGS.md` | Catatan bug/temuan dari hasil run terhadap server dev — cek ini sebelum lapor bug baru, siapa tahu sudah tercatat. |
| `results/` | Tempat laporan hasil tersimpan otomatis. |
| `keys.example.json` | Contoh bentuk `keys.json`. |

Urutan biasa: **smoke → ocr_stress → negative → idempotency → robustness → chaos**.

---

## Langkah 1 — Nyiapin file uji (ini bagian dev/ops, bukan QA)

Kalau kamu QA, **lewati langkah ini** — minta `keys.json` yang sudah jadi ke
dev. Bagian ini dokumentasi buat yang nyiapin datanya.

Cara nyiapin (butuh Python + `pip install minio`):

```bash
# pakai PDF contoh yang sudah ada (paling mirip kondisi asli)
python seed_min_io_keys.py --source ./samples --doc-type invoice \
    --endpoint ALAMAT_MINIO:9000 --access-key KEY --secret-key SECRET --bucket ocr

# atau bikin 20 PDF sederhana otomatis kalau belum punya contoh
python seed_min_io_keys.py --generate 20 --doc-type invoice \
    --endpoint ALAMAT_MINIO:9000 --access-key KEY --secret-key SECRET --bucket ocr
```

Hasilnya file `keys.json` yang isinya kira-kira begini:

```json
[
  {
    "filename": "invoice_0001.pdf",
    "min_io_key": "ocr-stress/ab12cd34-invoice_0001.pdf",
    "doc_type": "invoice"
  }
]
```

---

## Langkah 2 — Tes 1 job dulu (smoke test)

**Selalu jalanin ini duluan.** Tujuannya mastiin alamat server dan daftar
file-nya bener — dengan ngirim **1 job aja** dari awal sampai selesai.

```bash
k6 run smoke.js
```

Kalau ini gagal, **jangan lanjut** ke tes beban — pasti ada yang salah (alamat
atau daftar file). Beresin dulu di sini biar nggak bingung nanti.

> Catatan: `smoke.js` sekarang juga ngecek kalau job `SUCCESS`, hasil OCR-nya
> **nggak boleh kosong** (minimal ada satu field hasil ekstraksi yang keisi,
> di luar field metadata kayak status/job_id). Job yang `SUCCESS` tapi
> hasilnya kosong itu bug tersembunyi — kelihatan LULUS padahal OCR-nya nggak
> baca apa-apa.

---

## Langkah 3 — Tes beban beneran (stress test)

```bash
# kirim 6 job per menit, selama 10 menit
k6 run -e MODE=arrival -e SUBMIT_RATE=6 -e SUBMIT_UNIT=1m -e DURATION=10m \
       ocr_stress.js
```

Ada 2 gaya tes (`MODE`):

- **`MODE=arrival`** (disarankan) — job **terus dikirim** dengan kecepatan tetap
  walaupun yang lama belum selesai. Ini yang paling jujur nunjukin titik jebol:
  kalau server nggak sanggup, antrian bakal numpuk dan kelihatan.
- **`MODE=vus`** — ada sejumlah "user" tetap (`-e VUS=5`), tiap user kirim job →
  tunggu selesai → kirim lagi. Cocok buat tes **tahan lama** yang stabil.

Pengaturan yang bisa diubah (semua pakai `-e NAMA=nilai`):

| Pengaturan | Default | Artinya |
|---|---|---|
| `MODE` | `arrival` | Gaya tes: `arrival` atau `vus` |
| `SUBMIT_RATE` + `SUBMIT_UNIT` | `6` + `1m` | Berapa job per satuan waktu (contoh: 6 per menit) |
| `VUS` | `5` | Jumlah "user" (untuk mode `vus`) |
| `MAX_VUS` | `50` | Batas atas user (untuk mode `arrival`) |
| `DURATION` | `5m` | Berapa lama tes jalan |
| `FILES_PER_JOB` | `1` | Berapa file per job |
| `MAX_WAIT_S` | `300` | Nunggu 1 job maksimal berapa detik sebelum dianggap gagal |
| `POLL_INTERVAL_S` | `3` | Jeda cek status (detik) |
| `P95_E2E_MS` | `180000` | Target waktu job (lolos/gagal) |
| `MAX_FAIL_PCT` | `0.05` | Batas maksimal job gagal (0.05 = 5%) |

**Tips:** mulai pelan (`SUBMIT_RATE=2`), lalu naikkan tiap kali tes sampai
antrian mulai nggak habis atau kegagalan naik. Titik itulah **batas kemampuan**
sistemnya.

---

## Langkah 4 — Tes input yang salah

Ngecek server nolak input jelek **dengan sopan** (kasih kode error yang benar),
bukan malah error 500 atau nge-hang:

```bash
k6 run negative.js
```

Yang diuji: job kosong, tipe file nggak didukung, nama file kosong, alamat file
yang nggak ada, body request rusak, dan `job_id` ngawur.

---

## Langkah 5 — Tes kirim job dobel (idempotency)

Ngecek kalau `min_io_key` yang sama dikirim jadi 2 job beruntun (nggak ada
jeda), servernya nggak error 500 dan nggak hang — baik itu di-dedupe jadi 1
job atau diproses jadi 2 job independen:

```bash
k6 run idempotency.js
```

Skrip ini **nggak maksa** ada kebijakan dedupe tertentu — cuma mastiin
perilakunya rapi. Kalau ternyata jadi 2 job independen, skrip bakal
ngingetin buat dev/ops ngecek manual apakah ada baris DB dobel untuk
`min_io_key` yang sama.

---

## Langkah 6 — Tes file rusak (robustness)

Ngecek OCR-nya **gagal dengan rapi** waktu ketemu file jelek — bukan nge-hang
atau bikin worker mati. Dev nyiapin dulu kumpulan file "jahat" (rusak,
terpotong, ke-password, kegedean, dll):

```bash
# bikin file-file rusak + upload ke MinIO -> keys_bad.json
python seed_min_io_keys.py --bad \
    --endpoint ALAMAT_MINIO:9000 --access-key KEY --secret-key SECRET --bucket ocr
```

(Buat file ke-password/encrypted, tambahin `pip install pypdf` — kalau nggak
ada, file itu dilewati otomatis, sisanya tetap jalan.)

Lalu QA jalanin:

```bash
k6 run robustness.js
```

Tiap file dikirim jadi 1 job. Aturan utamanya: **setiap job harus sampai ke
status akhir** (idealnya `FAILED`) dalam batas waktu — nggak boleh ada yang
nge-hang. Skrip juga nampilin file mana yang malah `SUCCESS` (mencurigakan buat
file sampah — layak dilaporin sebagai bug).

> Catatan: file `oversized.pdf` ukurannya ~55MB. Per 2026-08-13 server
> nolak file ini bersih di pintu masuk (`413 PAYLOAD_TOO_LARGE`), jadi
> nggak nyampe masuk antrian OCR — kalau nanti perilakunya berubah lagi
> (misal balik jadi hang), itu layak dilaporin ulang (lihat `FINDINGS.md`).

Korpus file jelek sekarang juga termasuk 2 kasus PDF yang **valid secara
struktur** tapi bermasalah dari sisi konten (bukan byte-nya yang rusak):
`blank_scan.pdf` (halaman kosong, nggak ada teks sama sekali — mirip hasil
scan yang putih polos) dan `many_pages.pdf` (500 halaman — nguji ketahanan
parser/pipeline terhadap dokumen yang tebal, beda dari `oversized.pdf` yang
cuma 1 halaman digedein ukuran byte-nya).

> **Penting** — `status: SUCCESS` di respons `getData` **nggak selalu berarti
> datanya beneran tersimpan/valid**. Servicenya kadang nandain job
> `SUCCESS` sambil tetap ngasih `errors: [...]` dan `result: {}` kosong
> (misal `EMPTY_DOCUMENT`, `DB_WRITE_SKIPPED`). `smoke.js`/`robustness.js`
> sudah nge-handle ini (`hasExtractedContent()` ngecek `errors[]`, bukan
> cuma status) — tapi kalau kamu nulis skrip/integrasi baru, jangan cuma
> cek `status === "SUCCESS"`. Detail lengkap ada di `FINDINGS.md`.

---

## Langkah 6.5 — Tes correctness + limit barang (`limits.js`)

Beda dari skrip lain yang cuma ngecek "job selesai", ini ngecek **isinya
bener apa nggak** — pakai 1 invoice sintetis yang isinya kita tahu persis
(nomor invoice, tanggal, total, 30 baris barang):

```bash
# bikin 1 invoice ground-truth + upload ke MinIO -> keys_limits.json
python seed_min_io_keys.py --limits \
    --endpoint ALAMAT_MINIO:9000 --access-key KEY --secret-key SECRET --bucket ocr

k6 run limits.js
```

Yang diuji:
- **Correctness** — hasil ekstraksi beneran mengandung nomor invoice & total
  yang kita kirim, bukan cuma "ada isinya".
- **`EXTRACTION_MAX_ITEMS=15`** (batas jumlah barang per invoice, di
  `ocr-service/.env`) — invoice sintetisnya sengaja punya 30 barang buat
  ngecek batas ini beneran diberlakukan.

> Temuan dari run 2026-08-13: batas 15 barang **ternyata nggak selalu
> diberlakukan** untuk invoice yang "padat" (banyak barang tapi teksnya
> pendek) — lihat `FINDINGS.md` poin #4 buat detailnya.

---

## Cara baca hasilnya

**Hasil otomatis tersimpan.** Tiap tes k6 selesai, laporannya otomatis ditulis
ke folder **`results/`** dengan nama ber-timestamp, dalam 2 bentuk:
`nama-tes-<waktu>.txt` (enak dibaca / buat lampiran bug report) dan
`nama-tes-<waktu>.json` (angka lengkap). Ringkasannya tetap muncul di layar
seperti biasa. Jalanin k6 dari **dalam folder `qa-stress` ini** biar `results/`
kebaca.

Yang penting diperhatiin di laporan:

Setelah k6 selesai, dia nampilin ringkasan. Yang penting diperhatiin:

- **`ocr_job_e2e_ms`** — waktu satu job dari kirim sampai selesai. Lihat angka
  `p95` (95% job selesai di bawah waktu ini). Kalau angkanya naik terus selama
  tes, artinya antrian makin numpuk = **sudah lewat batas kemampuan**.
- **`ocr_job_failed`** — persentase job yang gagal atau kelamaan. Makin kecil
  makin bagus.
- **`ocr_submit_ms`** — waktu server nerima job (cuma bagian "nitip", belum
  diproses). Ini harusnya **tetap cepat** walaupun antrian numpuk. Kalau yang
  ini ikut melambat, berarti masalahnya di API/antrian, bukan di OCR-nya.

k6 otomatis nandain **LULUS/GAGAL** berdasarkan target `P95_E2E_MS` dan
`MAX_FAIL_PCT` di atas.

---

## Sambil tes, pantau juga sisi server (minta bantuan dev)

k6 cuma lihat dari luar. Idealnya, pas tes jalan, dev juga mantau:

- **Antrian RabbitMQ** — kalau job numpuk terus dan nggak habis, itu tandanya
  sudah kelebihan beban.
- **Jumlah worker** — sistem otomatis nambah/ngurangin worker sesuai antrian.
  Pastiin dia nambah pas ramai dan balik normal pas sepi.
- **Database, penyimpanan, memori** — biar ketahuan kalau ada yang bocor atau
  penuh.

---

## Langkah 7 — Tes "ketahanan" (chaos test) — dibantu dev/ops

Ini nguji: *kalau ada bagian yang mati, sistemnya rusak diam-diam, atau gagal
dengan jelas dan bisa pulih?* Ada skrip bantu **`chaos_probe.py`** (Python,
tanpa install apa-apa) yang **memandu langkah + otomatis ngecek hasilnya**.

Skrip ini **nggak matiin infra sendiri** — nggak tahu setup server kamu. Yang dia
lakuin: nyuruh kamu matiin satu bagian, nunggu, lalu otomatis nembak server dan
ngasih **LULUS/GAGAL**. Matiin/nyalain bagiannya tetap manual (biasanya dev/ops).

```bash
# satu skenario
python chaos_probe.py rabbitmq --base-url https://dev-backend.insw.go.id/kepabeanan-ocr

# atau semua sekaligus
python chaos_probe.py all --base-url https://dev-backend.insw.go.id/kepabeanan-ocr
```

Skenario yang dicek (dan hasil yang diharapkan):

- **`rabbitmq`** — matiin antrian → `POST /ocr/create` harus balas 503, bukan hang.
- **`database`** — matiin DB → server tetap hidup (`/health` 200); `getData`
  balas 503, nggak crash.
- **`minio`** — matiin penyimpanan → `create` balas 503/404, bukan hang.
- **`worker`** — kirim 1 job, lalu kamu bunuh 1 worker di tengah jalan → job
  harusnya tetap selesai (`SUCCESS`) karena dikerjain ulang worker lain. (Skrip
  ngingetin buat ngecek manual: jangan sampai ada **baris DB dobel**.)
- **`ollama`** — bikin AI mati → job itu `FAILED` dengan alasan jelas, job lain
  tetap normal.

Skenario `worker` dan `ollama` butuh 1 alamat file valid — otomatis diambil dari
`keys.json`, atau kasih lewat `--key`. Tambah `--insecure` kalau sertifikat TLS
server-nya bikin masalah.

---

_Folder ini alat bantu QA/dev, berdiri sendiri (cuma butuh `minio` + k6), dan
nggak nyampur sama kode service. Nggak ikut ke-deploy bareng aplikasinya._
