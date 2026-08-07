# QA Stress Tests — Kepabeanan

Folder ini isinya alat **stress/load test** buat empat service kepabeanan yang
beda karakternya. Masing-masing dipisah ke sub-folder sendiri karena **cara
ngetesnya beda** — jangan dicampur.

| Folder | Service | Model | Yang diukur |
|---|---|---|---|
| [`ocr/`](./ocr/) | **kepabeanan-ocr** | **Async** (kirim job → poll `job_id` sampai `SUCCESS`/`FAILED`) | Waktu 1 job selesai (end-to-end), ketahanan antrian |
| [`hpc/`](./hpc/) | **kepabeanan-hpc** | **Sinkron** (1 request → 1 response) | Latency (p95) & throughput (req/detik), Excel upload |
| [`data-service/`](./data-service/) | **kepabeanan-data-service** | **Sinkron** (1 request → 1 response) | Latency (p95) & throughput; baca ter-cache (Redis) vs DB, bundle POST, generateNomorAju |
| [`legacy/`](./legacy/) | **kepabeanan-legacy** (Legacy Bridge Platform) | **Sinkron** (+ async Temporal, belum dites) | Latency & throughput di bawah **rate limit 50 rps**, validasi/transform, perilaku limiter (429) |

## Bedanya di mana (penting)

**OCR itu async.** `POST /ocr/create` cuma nerima pekerjaan (202 + `job_id`),
OCR beneran jalan di belakang layar. Jadi yang diukur bukan "kecepatan server
jawab", tapi **berapa lama satu job kelar** dan seberapa numpuk antriannya. Butuh
`keys.json` (file uji di MinIO) dari dev.

**HPC itu sinkron.** REST API biasa (Go/Fiber) buat CRUD dokumen kepabeanan
(BC16/BC20/BC23/FTZ01) + upload Excel→JSON. Satu request langsung balikin hasil,
jadi ini tes **"requests per second"** klasik: ukur latency p95 dan error rate
pas dibanjirin. Path utama: `/api/v1/...`, health di `/healthz`.

**Data Service juga sinkron.** REST API NestJS buat data `ssm_impor` — baca
referensi (di-cache Redis), baca/tulis domain, dan endpoint **bundle** yang
dipanggil HPC. Tes-nya mirip HPC (latency + throughput), plus angle khusus:
cache referensi vs baca DB, dan konkurensi `generateNomorAju`.

**Legacy (LBP) itu platform integrasi**, bukan CRUD. Fokus tes: endpoint sinkron
(validasi `kirimData`, transform XML↔JSON, scanner VT) — tapi hati-hati ada
**rate limiter 50 rps/IP** yang bikin request di atas itu kena 429. Jadi ada tes
khusus buat mastiin limiternya kerja rapi. Jalur async (Temporal) belum dicakup.

## Yang perlu duluan

Semua butuh **k6** (https://grafana.com/docs/k6/latest/set-up/install-k6/).
Sebagian langkah persiapan data (OCR) butuh **Python**. Alamat server dev sudah
jadi default di semua skrip, dan **nggak butuh token** (auth mati). Selalu
jalanin k6 **dari dalam folder service-nya** biar `results/` + config-nya kebaca.

Detail lengkap tiap tes ada di README masing-masing folder. Di bawah ini versi
ringkasnya.

## Cara pakai — OCR (`ocr/`)

Async: kirim job → poll sampai selesai. Butuh `keys.json` dari dev.

```bash
cd ocr
k6 run smoke.js                                                    # cek 1 job dulu
k6 run -e MODE=arrival -e SUBMIT_RATE=6 -e DURATION=10m ocr_stress.js   # beban utama
k6 run negative.js                                                 # input salah
k6 run idempotency.js                                              # job dobel
k6 run robustness.js                                               # file rusak
```

## Cara pakai — HPC (`hpc/`)

Sinkron: 1 request 1 response. Salin config dulu.

```bash
cd hpc
cp targets.example.json targets.json
k6 run smoke.js                                                    # cek konek + envelope
k6 run -e MODE=read -e RATE=50 -e DURATION=5m hpc_stress.js        # beban baca (aman)
k6 run negative.js                                                 # input salah
python make_bad_xlsx.py && k6 run robustness.js                   # file Excel rusak
# jalur berat (nulis data, dev only): siapin sample .xlsx di targets.json dulu
k6 run -e MODE=upload -e RATE=2 -e DURATION=3m hpc_stress.js
```

## Cara pakai — Data Service (`data-service/`)

Sinkron, ada cache Redis + endpoint bundle. Salin config dulu.

```bash
cd data-service
cp targets.example.json targets.json
k6 run smoke.js                                                    # cek konek + envelope
k6 run -e MODE=referensi -e RATE=100 -e DURATION=5m stress.js      # baca cached (aman)
k6 run -e MODE=domain -e RATE=50 -e DURATION=5m stress.js          # baca DB (aman)
k6 run -e MODE=review -e RATE=30 -e DURATION=5m stress.js          # Review & Submit (isi idHeader di targets.json)
k6 run -e VUS=30 -e DURATION=20s nomoraju.js                       # konkurensi generateNomorAju
k6 run negative.js                                                 # input salah
# jalur berat (nulis data, dev only):
k6 run -e MODE=bundle -e RATE=3 -e DURATION=3m stress.js
```

## Cara pakai — Legacy / LBP (`legacy/`)

Platform integrasi, **ada rate limit 50 rps/IP** — jaga RATE di bawah itu.

```bash
cd legacy
k6 run smoke.js                                                   # health + kirimData
k6 run -e MODE=kirim -e RATE=40 -e DURATION=3m stress.js          # validasi (di bawah limit)
k6 run -e MODE=xml2json -e RATE=40 -e DURATION=3m stress.js        # transform XML->JSON
k6 run -e RATE=200 -e DURATION=30s ratelimit.js                   # tes limiter (harus 429 rapi)
k6 run negative.js                                                # input salah
```

> Kalau auth di service dinyalain lagi, tambah `-e API_KEY=...` (data-service:
> `1n5w2026#`; legacy: `-e API_KEY=<key> -e TENANT=<tenant>`). Kalau mau nembak
> env selain dev, tambah `-e BASE_URL=...`.

---

_Alat bantu QA/dev, berdiri sendiri, nggak nyampur sama kode service dan nggak
ikut ke-deploy._
