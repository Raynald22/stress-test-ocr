# Panduan Stress Test Legacy Bridge Platform (untuk QA)

Folder ini isinya alat buat **nguji beban (stress test)** service
**kepabeanan-legacy** — yaitu **Legacy Bridge Platform (LBP)**, sebuah platform
integrasi (Go/Gin), bukan aplikasi CRUD biasa. Kamu (QA) **nggak perlu ngoding**.
Cukup jalanin skrip k6, lalu baca hasilnya.

> Beda dari service lain, di sini fokusnya ke **endpoint sinkron** yang ringkas
> dan mandiri (validasi + transformasi), plus satu tes khusus buat **rate
> limiter** bawaannya.

---

## ⚠️ Yang WAJIB dipahami dulu: rate limiter

LBP punya **pembatas laju (rate limiter) bawaan**: **per-IP, default 50
request/detik, burst 100** (`LBP_HTTP_RATE_LIMIT_RPS`). Konsekuensinya:

- Dari **satu komputer** (satu IP), begitu kamu ngirim **> ~50 req/detik**,
  sebagian request bakal dibalas **429 Too Many Requests**. **Itu normal** —
  limiter-nya lagi kerja, **bukan** server-nya jebol.
- Makanya `stress.js` **default-nya di bawah limit** (`RATE=40`) biar kamu
  ngukur latency asli. 429 dihitung terpisah (`lbp_ratelimited`), **nggak**
  dianggap error.
- Kalau kamu **sengaja** mau lihat titik limitnya, naikin `RATE` lewat 50 →
  429 bakal muncul makin banyak.
- Buat **nguji limiter-nya sendiri** (mastiin dia nolak dengan rapi pas
  dibanjirin), pakai `ratelimit.js`.

Hal lain yang perlu tahu:

- **Batas body 1 MB.** Payload lebih gede → ditolak (4xx).
- **Auth default MATI.** Kalau `LBP_SECURITY_ENABLED=true`, kirim header
  `X-API-Key` (dan opsional `X-Tenant-ID`): tambah `-e API_KEY=... -e TENANT=...`.
- **Amplop response** beda dari service lain: sukses `{ data, correlation_id }`,
  error `{ code, message, correlation_id }`.
- **Endpoint async (Temporal)** — `workflows/*` dan `schedules/*` — **belum**
  dites di suite ini karena butuh Temporal hidup + service downstream yang
  keregistrasi. Bisa ditambah nanti kalau perlu.

---

## Yang perlu disiapin

- **k6** — https://grafana.com/docs/k6/latest/set-up/install-k6/
- **Alamat server** — sudah di-set default ke
  `https://dev-backend.insw.go.id/kepabeanan-legacy`, jadi `-e BASE_URL=...`
  **opsional**.
- Payload contoh sudah disiapin di `samples/` (`pengajuan.json` disalin dari
  `examples/pengajuan-sample.json` repo service, + `sample.xml`).

---

## Isi folder ini

| File | Gunanya |
|---|---|
| `smoke.js` | Cek 1x: health + 1 kirimData + amplop bener. **Jalanin duluan.** |
| `stress.js` | Beban utama sinkron. `MODE=kirim` / `vt` / `xml2json` / `json2xml` / `health`. |
| `ratelimit.js` | Tes khusus rate limiter: banjirin → harus balas 429 rapi (bukan 5xx/hang). |
| `negative.js` | Tes input salah (harus 4xx, bukan 5xx/hang). |
| `summary.js` | Dipakai skrip lain buat auto-simpan hasil. Jangan dijalanin langsung. |
| `samples/` | Payload uji (`pengajuan.json`, `sample.xml`). |
| `results/` | Tempat laporan hasil tersimpan otomatis. |

Urutan biasa: **smoke → stress (kirim) → stress (mode lain) → ratelimit → negative**.

---

## Langkah 1 — Smoke test (jalanin duluan)

```bash
k6 run smoke.js
```

Ngecek `health/live`, `health/ready`, `health`, dan satu `POST /kirimData`.
Catatan: payload yang **ditolak validasi tetap balas HTTP 200** dengan hasilnya
di body (`data.verdict` = `pass`/`fail`) — jadi smoke ngecek amplop + adanya
verdict, bukan cuma kode HTTP.

---

## Langkah 2 — Beban utama (sinkron, di bawah rate limit)

```bash
# 40 req/detik selama 3 menit (default aman, di bawah limiter 50 rps)
k6 run -e MODE=kirim -e RATE=40 -e UNIT=1s -e DURATION=3m stress.js
```

Ganti `MODE` buat nguji jalur lain:

| MODE | Endpoint | Beban |
|---|---|---|
| `kirim` (default) | `POST /kirimData` | Validasi payload pengajuan |
| `vt` | `POST /scanners/vt/execute` | Scan Vulnerability Test |
| `xml2json` | `POST /transform/xml-to-json` | Transformasi XML→JSON |
| `json2xml` | `POST /transform/json-to-xml` | Transformasi JSON→XML |
| `health` | `GET /health` | Paling ringan (baseline) |

Pengaturan (semua `-e NAMA=nilai`):

| Pengaturan | Default | Artinya |
|---|---|---|
| `MODE` | `kirim` | Endpoint yang dites |
| `RATE` + `UNIT` | `40` + `1s` | Request per satuan waktu (**jaga < 50/detik** biar nggak kena 429) |
| `DURATION` | `3m` | Lama tes |
| `MAX_VUS` | `80` | Batas atas user paralel |
| `P95_MS` | `800` | Target latency p95 |
| `MAX_FAIL_PCT` | `0.01` | Batas maksimal gagal (di luar 429) |

Yang dilihat: **`lbp_ms`** (latency p95, cuma dari request yang kelayan 2xx),
**`lbp_req_failed`** (gagal beneran, 429 nggak dihitung), dan
**`lbp_ratelimited`** (berapa persen kena 429 — kalau ini naik, berarti `RATE`
kamu udah lewat limiter).

> Mau lihat batas kemampuan asli tanpa ganggu limiter? Naikin `RATE` pelan-pelan;
> begitu `lbp_ratelimited` mulai > 0, kamu udah nyentuh plafon 50 rps.

---

## Langkah 3 — Tes rate limiter (sengaja dibanjirin)

```bash
# 200 req/detik selama 30 detik — jauh di atas limit
k6 run -e RATE=200 -e DURATION=30s ratelimit.js
```

Di sini **kena 429 itu justru yang diharapkan**. Yang dicek:
- **Tiap** response cuma boleh **200 atau 429** — nggak boleh ada 5xx atau hang
  (`lbp_clean_status` harus 100%).
- **429 harus muncul** (`lbp_ratelimited > 0`) — buktinya limiter jalan.

Kalau `lbp_ratelimited` tetap 0%, berarti limiter mati atau `RATE` masih di bawah
konfigurasi server — naikin `RATE` atau cek `LBP_HTTP_RATE_LIMIT_RPS`.

---

## Langkah 4 — Tes input salah (negative)

```bash
k6 run negative.js
```

Yang diuji: kirimData body kosong (400), JSON rusak (400), body > 1MB (4xx),
transform tanpa Content-Type XML (400), XML rusak (400), scanner tanpa
payload/service_name (400), route ngaco (404). Aturan mati: **nggak boleh 5xx
atau hang.**

---

## Cara baca hasilnya

Hasil auto-tersimpan ke `results/` (`.txt` + `.json`, ber-timestamp). Jalanin k6
dari **dalam folder `legacy/` ini**. Metrik penting:

- **`lbp_ms`** — latency request yang kelayan, lihat `p95`.
- **`lbp_req_failed`** — gagal beneran (non-2xx, non-429).
- **`lbp_ratelimited`** — porsi kena 429 (tanda udah lewat limiter).
- **`http_req_failed`** — level transport/5xx.

---

## Belum dicakup (butuh setup lebih)

- **Workflow Temporal** (`POST /workflows/integration-requests` → poll
  `GET .../:workflow_id`) — async, butuh Temporal + service downstream. Modelnya
  mirip suite OCR (submit → poll) kalau nanti mau ditambah.
- **Gateway proxy** (`/api/v1/gateway/*`) — perlu service downstream keregistrasi
  dulu di registry.
- **Registry / routes / tenants / schedules CRUD** — perlu seed/urutan data.

---

_Folder ini alat bantu QA/dev, berdiri sendiri (cuma butuh k6), dan nggak
nyampur sama kode service. Nggak ikut ke-deploy bareng aplikasinya._
