# QA Stress Tests — Kepabeanan

Folder ini isinya alat **stress/load test** buat dua service kepabeanan yang
beda karakternya. Keduanya dipisah ke sub-folder sendiri karena **cara ngetesnya
beda total** — jangan dicampur.

| Folder | Service | Model | Yang diukur |
|---|---|---|---|
| [`ocr/`](./ocr/) | **kepabeanan-ocr** | **Async** (kirim job → poll `job_id` sampai `SUCCESS`/`FAILED`) | Waktu 1 job selesai (end-to-end), ketahanan antrian |
| [`hpc/`](./hpc/) | **kepabeanan-hpc** | **Sinkron** (1 request → 1 response) | Latency (p95) & throughput (req/detik), Excel upload |

## Bedanya di mana (penting)

**OCR itu async.** `POST /ocr/create` cuma nerima pekerjaan (202 + `job_id`),
OCR beneran jalan di belakang layar. Jadi yang diukur bukan "kecepatan server
jawab", tapi **berapa lama satu job kelar** dan seberapa numpuk antriannya. Butuh
`keys.json` (file uji di MinIO) dari dev.

**HPC itu sinkron.** REST API biasa (Go/Fiber) buat CRUD dokumen kepabeanan
(BC16/BC20/BC23/FTZ01) + upload Excel→JSON. Satu request langsung balikin hasil,
jadi ini tes **"requests per second"** klasik: ukur latency p95 dan error rate
pas dibanjirin. Path utama: `/api/v1/...`, health di `/healthz`.

## Mulai dari mana

Masuk ke folder service yang mau dites, baca README-nya, lalu jalanin k6 **dari
dalam folder itu** (biar `results/` dan file config-nya kebaca):

```bash
cd ocr   && cat README.md     # buat OCR service
cd hpc   && cat README.md     # buat HPC service
```

Dua-duanya butuh **k6** (https://grafana.com/docs/k6/latest/set-up/install-k6/).
Sebagian langkah persiapan data butuh **Python**.

---

_Alat bantu QA/dev, berdiri sendiri, nggak nyampur sama kode service dan nggak
ikut ke-deploy._
