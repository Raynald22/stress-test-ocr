# Panduan Stress Test Data Service (untuk QA)

Folder ini isinya alat buat **nguji beban (stress test)** service
**kepabeanan-data-service** (LNSW Data Service) — REST API NestJS + TypeORM
(PostgreSQL schema `ssm_impor`) + **Redis cache** + MinIO. Kamu (QA) **nggak perlu
ngoding**. Cukup jalanin skrip k6 yang sudah disiapin, lalu baca hasilnya.

> Ini **sinkron** kayak HPC (1 request → 1 response), jadi yang diukur **latency
> (p95)** dan **throughput (request/detik)** — bukan waktu antrian job kayak OCR.
> Bedanya sama HPC: service ini punya **cache Redis** (bikin jalur baca referensi
> super cepat) dan endpoint **bundle** berat yang dipanggil HPC.

---

## Yang khas dari service ini

**1. Baca referensi di-cache (Redis, TTL 24 jam).** Ada ~60 endpoint
`GET /api/v1/referensi/*` (kantor-pabean, negara, hscode, kurs, jenis-kemasan,
dll). Hit pertama ngisi cache, sisanya dilayani dari Redis → harusnya sangat
cepat. Ini **jalur baca terpanas** dan paling menarik buat nguji efektivitas cache.

**2. Baca domain langsung DB (nggak di-cache).** `GET /api/v1/pengajuan`,
`/barang`, `/entitas`, dst. Lebih berat dari referensi karena tiap request query
Postgres.

**3. Bundle POST = jalur tulis berat.** `POST /api/v1/ssm-impor-api-bundle-post`
nerima satu dokumen SSM Impor utuh dan **insert ke banyak tabel dalam 1
transaksi**. Ini endpoint yang dipanggil service HPC. **Insert-only** (nggak ada
update/upsert) → tiap request nambah baris baru.

**4. generateNomorAju pakai advisory lock.**
`POST /api/v1/pengajuan/generateNomorAju` ngasih nomor unik via Postgres
sequence + advisory lock — target bagus buat tes konkurensi.

**5. Auth lagi DIMATIKAN.** Guard API-KEY di-comment di kode, jadi sekarang
endpoint kebuka tanpa header. Kalau nanti dinyalain lagi (header `API-KEY`, key
`1n5w2026#`), tinggal tambahin `-e API_KEY=1n5w2026#` di semua perintah.

**6. Nggak ada endpoint health.** Liveness pakai `GET /` (halaman HTML) dan
`GET /api/docs-json`.

Amplop response semua endpoint: `{ success, message, data, errors? }`.

---

## Yang perlu disiapin

- **k6** — https://grafana.com/docs/k6/latest/set-up/install-k6/
- **Alamat server** — sudah di-set default ke
  `https://dev-backend.insw.go.id/kepabeanan-data-service` di semua skrip, jadi
  `-e BASE_URL=...` **opsional**.
- **Token** — **nggak perlu** (auth lagi mati). Kalau dinyalain: `-e API_KEY=1n5w2026#`.
- **`targets.json`** — daftar endpoint yang mau dites. Salin dari contoh:
  ```bash
  cp targets.example.json targets.json
  ```
  Lalu buang endpoint yang nggak relevan.
- (Buat tes bundle) file payload sudah disiapin di `samples/bundle.json`
  (salinan `dummy-bundle-post.json` dari repo service).

---

## Isi folder ini

| File | Gunanya |
|---|---|
| `smoke.js` | Cek 1x: server hidup + amplop response bener. **Jalanin duluan.** |
| `stress.js` | Beban utama. `MODE=referensi` / `domain` / `bundle`. |
| `nomoraju.js` | Tes konkurensi generateNomorAju (advisory lock + cek nomor dobel). |
| `negative.js` | Tes input salah (harus ditolak 4xx, bukan 5xx/hang). |
| `summary.js` | Dipakai skrip lain buat auto-simpan hasil. Jangan dijalanin langsung. |
| `targets.example.json` | Contoh daftar endpoint. Salin jadi `targets.json`. |
| `samples/bundle.json` | Payload buat tes bundle POST. |
| `results/` | Tempat laporan hasil tersimpan otomatis. |

Urutan biasa: **smoke → stress (referensi) → stress (domain) → nomoraju → negative → stress (bundle)**.

---

## Langkah 1 — Smoke test (jalanin duluan)

```bash
k6 run smoke.js
```

Ngecek `GET /` (200), `GET /api/docs-json` (200), satu endpoint referensi, dan
satu endpoint domain — semua harus 200 + amplop `success:true`. Kalau gagal,
beresin dulu sebelum lanjut.

---

## Langkah 2 — Beban baca referensi (di-cache, paling aman)

```bash
# 100 request/detik selama 5 menit
k6 run -e MODE=referensi -e RATE=100 -e UNIT=1s -e DURATION=5m stress.js
```

Read-only, aman di-hammer. Lihat `ds_read_ms` (p95) — karena di-cache, harusnya
kecil dan stabil. Kalau p95 tetap tinggi/naik terus, berarti cache nggak jalan
atau ke-bypass (worth dilaporin). Naikkan `RATE` sampai nemu batasnya.

Pengaturan (semua `-e NAMA=nilai`):

| Pengaturan | Default | Artinya |
|---|---|---|
| `MODE` | `referensi` | `referensi` / `domain` / `review` / `bundle` |
| `RATE` + `UNIT` | `100` + `1s` | Request per satuan waktu |
| `DURATION` | `5m` | Lama tes |
| `MAX_VUS` | `150` | Batas atas user paralel |
| `P95_MS` | `500` referensi / `1500` domain / `8000` bundle | Target p95 |
| `MAX_FAIL_PCT` | `0.01` | Batas maksimal gagal (1%) |

---

## Langkah 3 — Beban baca domain (langsung DB)

```bash
k6 run -e MODE=domain -e RATE=50 -e DURATION=5m stress.js
```

Sama kayak referensi tapi nembak endpoint domain (pengajuan/barang/entitas/
kemasan-dan-kontainer/dokumen-lampiran/karantina/penanggung-jawab/ikb) yang query
Postgres langsung. Wajar lebih lambat. Bandingin `ds_read_ms`-nya sama referensi
buat lihat seberapa besar untungnya cache.

---

## Langkah 3b — Beban Review & Submit (perlu idPermohonan)

```bash
k6 run -e MODE=review -e RATE=30 -e DURATION=5m stress.js
```

Nembak `GET /api/v1/review-dan-submit?idPermohonan=<uuid>` — endpoint cek kelengkapan
yang **wajib `idPermohonan`** dan lumayan berat (agregasi statistik dokumen/kemasan/
kontainer/barang + pungutan per section). Karena butuh record beneran, **isi dulu**
`review_dan_submit.id_permohonans` di `targets.json` pakai 1+ UUID permohonan yang
**ada di DB dev** (minta ke dev). Skrip milih acak dari daftar itu. Kalau daftar
kosong, mode ini nggak jalan.

---

## Langkah 4 — Tes konkurensi generateNomorAju

```bash
# 30 user barengan selama 20 detik
k6 run -e VUS=30 -e DURATION=20s nomoraju.js
```

Nyari tahu apakah advisory lock kuat pas banyak request barengan: semua harus
2xx, dapat `nomorAju`, nggak ada 5xx/hang, latency ke-jaga. **Cek nomor dobel**
(ini yang paling penting) — tiap sukses nge-log `NOMORAJU=...`, jadi:

```bash
k6 run -e VUS=30 -e DURATION=20s nomoraju.js 2>&1 | grep -o 'NOMORAJU=[0-9]*' | sort | uniq -d
```

Kalau nggak ngeluarin apa-apa = semua unik (bagus). Kalau ada yang keluar = ada
nomor dobel = **bug** (lock gagal nge-serialize).

> Tiap panggilan makan 1 nilai sequence — env dev/buangan aja.

---

## Langkah 5 — Tes input salah (negative)

```bash
k6 run negative.js
```

Yang diuji: `idHeader` bukan UUID (400), PUT tanpa `idHeader` (400), bundle JSON
rusak (400), bundle kosong (400), `referensi/kurs` tanpa `kodeKurs` (4xx), route
ngaco (404), upload tanpa file (400). Aturan mati: **nggak boleh 5xx atau hang.**

---

## Langkah 6 — Beban tulis bundle (jalur berat) ⚠️

⚠️ **Nulis data ke DB (insert-only, data numpuk). Cuma ke env dev/buangan.**

```bash
# 3 request/detik selama 3 menit
k6 run -e MODE=bundle -e RATE=3 -e UNIT=1s -e DURATION=3m stress.js
```

Ini padanan "job berat"-nya: satu request nge-insert dokumen utuh ke banyak
tabel dalam 1 transaksi. Ukur `ds_write_ms` (p95) dan `ds_req_failed`. Ratenya
kecil karena berat — naikkan pelan-pelan sambil dev mantau DB (koneksi pool,
lock, disk).

---

## Cara baca hasilnya

Hasil auto-tersimpan ke `results/` (`.txt` + `.json`, ber-timestamp). Jalanin k6
dari **dalam folder `data-service/` ini** biar `results/` kebaca. Yang penting:

- **`ds_read_ms` / `ds_write_ms`** — latency request, lihat `p95`. Naik terus =
  lewat batas kemampuan.
- **`ds_req_failed`** — persen request gagal (non-2xx yang nggak wajar).
- **`http_req_failed`** — kegagalan transport/5xx.
- **`nomoraju_ms` / `nomoraju_issued`** — buat tes konkurensi.

Sambil tes jalan, minta dev mantau sisi server: **Redis** (hit rate cache
referensi), **Postgres** (connection pool, lock, slow query), dan **MinIO**
(kalau tes upload).

---

_Folder ini alat bantu QA/dev, berdiri sendiri (cuma butuh k6), dan nggak
nyampur sama kode service. Nggak ikut ke-deploy bareng aplikasinya._
