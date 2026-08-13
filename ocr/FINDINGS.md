# OCR Service — Temuan QA (2026-08-13)

Hasil dari sesi closure QA `ocr/` terhadap `https://dev-backend.insw.go.id/kepabeanan-ocr`.
Semua temuan di bawah sudah direproduksi ulang di tanggal ini (bukan cuma dari
run lama) kecuali disebutkan lain. Setiap temuan punya langkah reproduksi
supaya bisa langsung dipakai jadi bug report ke tim dev.

---

## TEMUAN UTAMA (headline) — `status: "SUCCESS"` tidak berarti data valid/tersimpan

Ini pola yang muncul di **3 skenario berbeda** dengan 2 error code berbeda.
Klien yang cuma cek `data.status === "SUCCESS"` (cara paling wajar buat
nulis integrasi) akan salah anggap job berhasil, padahal:
- Tidak ada data yang tersimpan ke database, DAN/ATAU
- `result` kosong (`{}`).

Detail per skenario ada di bawah (#1, #2, #3). **Rekomendasi**: kalau ada
`errors[]` yang non-kosong, `status` semestinya bukan `SUCCESS` murni (atau
minimal ada field terpisah yang jelas, misal `partial_success`/`has_errors`,
supaya klien tidak perlu tahu untuk selalu mengecek `errors[]` secara manual).

---

## 1. File sampah (PNG diberi ekstensi .pdf) → `SUCCESS` tapi `EMPTY_DOCUMENT`

**Reproduksi:**
```bash
curl -X POST $BASE_URL/ocr/create -H "Content-Type: application/json" \
  -d '{"invoices":[{"filename":"image_as_pdf.pdf","min_io_key":"<key file PNG-sebagai-.pdf>"}]}'
# lalu poll GET /ocr/getData/{job_id}
```
**Hasil:**
```json
{
  "status": "SUCCESS",
  "error": "...: document has no readable text - nothing extracted",
  "errors": [{"code": "EMPTY_DOCUMENT", "message": "...nothing extracted"}],
  "result": {}
}
```
**Kenapa ini masalah**: file yang jelas-jelas bukan dokumen sah ditandai
`SUCCESS`. Servicenya SUDAH benar mendeteksi masalahnya secara internal
(`code: EMPTY_DOCUMENT`) — tinggal `status` job-nya yang tidak mencerminkan itu.

## 2. PDF halaman kosong (tanpa teks) → pola identik dengan #1

**Reproduksi**: sama seperti #1, pakai `blank_scan.pdf` (dihasilkan
`seed_min_io_keys.py --bad`, PDF valid secara struktur tapi content stream-nya
kosong).
**Hasil**: identik dengan #1 — `status: SUCCESS`, `errors: [EMPTY_DOCUMENT]`,
`result: {}`.

## 3. Invoice valid tanpa tanggal → `SUCCESS` tapi `DB_WRITE_SKIPPED`, data hilang total

**Reproduksi**: submit PDF invoice valid (ada kata "INVOICE", nomor invoice,
daftar barang) TAPI tanpa baris tanggal invoice.
**Hasil:**
```json
{
  "status": "SUCCESS",
  "error": "...: not saved to database - td_invoice: missing required field: tanggal_invoice",
  "errors": [{"code": "DB_WRITE_SKIPPED", "message": "...missing required field: tanggal_invoice"}],
  "result": {}
}
```
**Dampak lebih luas**: PDF sintetis minimal yang dipakai `seed_min_io_keys.py
--generate` (dipakai `smoke.js`, `ocr_stress.js`, `idempotency.js`) TERNYATA
juga tidak menyertakan tanggal invoice — jadi **setiap run smoke/load/
idempotency sebelum perbaikan ini "SUCCESS" secara status, tapi job-nya
sebenarnya tidak pernah tersimpan ke database sama sekali.** Correctness
check versi lama (cuma cek "ada field non-metadata") ketipu karena `errors`
array dianggap sebagai "ada konten". Sudah diperbaiki di sesi ini:
  - `smoke.js`/`robustness.js`: `hasExtractedContent()` sekarang eksplisit
    menganggap `errors[]` non-kosong sebagai "tidak ada konten", bukan lolos.
  - `seed_min_io_keys.py --generate`: sekarang menyertakan baris
    "Invoice Date"/"Tanggal Invoice" di PDF sintetis, supaya job beneran
    tersimpan dan mencerminkan kondisi realistis.
**Rekomendasi ke dev**: field wajib (`tanggal_invoice`, mungkin ada lainnya)
sebaiknya didokumentasikan di suatu tempat yang bisa diakses QA/klien, dan
idealnya divalidasi lebih awal (bukan baru ketahuan pas DB write, dengan
`status` yang tetap `SUCCESS`).

---

## 4. `EXTRACTION_MAX_ITEMS=15` tidak diberlakukan untuk invoice padat (compact)

**Reproduksi**: submit invoice valid (kata "INVOICE" + tanggal ada) dengan
30 baris barang dalam 1 halaman, teks per baris pendek.
**Hasil**: seluruh **30 barang** berhasil diekstrak DAN tersimpan ke
database (`items` array panjang 30), bukan dipotong ke 15.
**Kenapa**: dari pembacaan kode `ocr-service` (`app/pipeline.py:134-135`,
`app/extraction/chunked_extraction.py`), limit 15 barang cuma aktif di jalur
*chunked extraction*, yang hanya dipicu kalau `len(raw_text) >
extraction_chunk_chars`. Proteksi ini digerakkan oleh **panjang karakter**,
bukan **jumlah barang**. Invoice yang padat (banyak barang, tapi tiap baris
pendek) sehingga total karakternya di bawah threshold akan lolos jalur
non-chunked — di situ limit 15 tidak pernah dicek sama sekali.
**Dampak**: proteksi anti-repetition-loop yang dimaksudkan untuk tabel
barang panjang punya celah nyata untuk dokumen yang "padat" tapi tetap
banyak barang. Worth didiskusikan ke dev apakah gating-nya perlu juga
mempertimbangkan jumlah baris (bukan cuma panjang teks).

## 5. `nilai` (nilai per baris barang) selalu 0, padahal `harga_satuan` & `jumlah` benar

**Reproduksi**: sama seperti #4 — tiap baris barang di PDF sumber jelas
punya `qty:N price:N*1000`.
**Hasil**: field `harga_satuan` (unit price) dan `jumlah` (quantity) di
setiap satu dari 30 item **terekstrak benar** (1000, 2000, ..., 30000 dan
1..30 secara berurutan) — tapi field `nilai` (line value, mestinya
`harga_satuan × jumlah`) **selalu 0** di seluruh 30 item, tanpa kecuali.
**Kenapa ini masalah**: ini terlihat seperti bug kalkulasi/ekstraksi
spesifik pada satu field, bukan masalah OCR (field lain di baris yang sama
berhasil). Worth dicek ke dev — apakah `nilai` memang harus dihitung
otomatis (bukan diekstrak dari teks), dan kalau iya kenapa hasilnya selalu 0.

## 6. Tidak ada field grand-total di hasil ekstraksi invoice

**Reproduksi**: sama seperti #4, dokumen sumber punya baris eksplisit
"Total: 157500000".
**Hasil**: field `total`/grand-total **tidak ada sama sekali** di objek
invoice hasil ekstraksi (field yang ada: `nomor_invoice`, `tanggal_invoice`,
`mata_uang`, `incoterm`, `consignee`, `alamat_penerbit_invoice`,
`nama_penerbit_invoice`, `negara_penerbit_invoice`, `confident_score`,
`items[]`, dll — tidak ada `total`/`grand_total`/sejenisnya).
**Catatan**: belum jelas apakah ini karena skema invoice memang tidak
punya field grand-total (misalnya karena total dihitung dari `SUM(nilai)`
per item, yang mana kalau begitu nyambung ke temuan #5 di atas — `nilai`
yang 0 bikin total jadi 0 juga kalau dihitung dari situ), atau karena
ekstraksinya memang tidak menangkap field ini. **Perlu klarifikasi dev.**

## 7. Minor: field lokasi kosong berisi whitespace, bukan null/string kosong

`negara_asal` (tiap item) dan `negara_penerbit_invoice` (level dokumen)
bernilai `"  "` (dua spasi) ketika informasinya tidak diketahui, alih-alih
`null` atau `""`. Kosmetik, tapi bisa menyulitkan validasi di sisi klien
(`if (!negara_asal)` akan false padahal isinya cuma spasi).

---

## 8. Duplicate submission tidak di-dedupe (dari sesi sebelumnya, 2026-07-31)

**Reproduksi**: kirim 2 job dengan `min_io_key` yang SAMA persis, tanpa jeda
(`idempotency.js`).
**Hasil**: server menghasilkan 2 `job_id` berbeda, keduanya diproses secara
independen dan berakhir `SUCCESS`.
**Rekomendasi**: minta dev/ops cek apakah ada baris database dobel untuk
`min_io_key` yang sama. Ini bukan otomatis salah (tergantung kebijakan
dedupe yang diinginkan), tapi worth dikonfirmasi ke product/dev apakah
duplikasi ini yang diharapkan.

---

## RESOLVED — `oversized.pdf` (55MB) sekarang ditolak bersih, bukan hang lagi

Di run 2026-07-31, file 55MB menyebabkan job `HANG/TIMEOUT` (tidak selesai
dalam `MAX_WAIT_S=300`). **Di-retest 2026-08-13**: sekarang server menolak
di pintu masuk dengan `HTTP 413 PAYLOAD_TOO_LARGE`
(`"File too large: oversized.pdf is 55.0MB, limit is 50MB"`), tidak pernah
sampai masuk antrian OCR. Ini perbaikan yang baik — servicenya sudah
menambahkan validasi ukuran file sebelum diproses. **Tidak perlu tindak
lanjut**, dicatat di sini murni sebagai riwayat (supaya tidak dianggap bug
yang masih terbuka).

---

## Ringkasan prioritas untuk tim dev

| # | Temuan | Prioritas | Kenapa |
|---|---|---|---|
| 1-3 | `status: SUCCESS` walau `errors[]` ada & `result` kosong | **Tinggi** | Menyesatkan semua klien yang cuma cek status; pola berulang 3x |
| 5 | `nilai` selalu 0 walau `harga_satuan`/`jumlah` benar | **Tinggi** | Bug kalkulasi/ekstraksi yang mempengaruhi angka bisnis |
| 6 | Tidak ada field grand-total | **Sedang** | Perlu klarifikasi dulu apakah ini gap atau memang by design |
| 4 | `EXTRACTION_MAX_ITEMS` bisa dilewati dokumen padat | **Sedang** | Proteksi anti-loop yang dimaksud tidak menutup semua kasus |
| 8 | Duplicate submission tidak di-dedupe | **Sedang** | Perlu klarifikasi kebijakan yang diinginkan |
| 7 | Field kosong berisi whitespace bukan null | **Rendah** | Kosmetik |
| — | `oversized.pdf` hang | **Resolved** | Sudah diperbaiki (413 bersih) |
