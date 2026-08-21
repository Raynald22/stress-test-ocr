# Laporan OCR Confidence Score
Dibuat: 2026-08-21T09:09:08.462Z  
Jumlah dokumen: 0

---

## Catatan penting buat yang baca laporan ini

- **"Implied grounding" itu hasil balikan aljabar dari skor akhir** (`confident_score = round(sqrt(grounding * completeness) * 100, 1)`), **bukan angka asli dari backend**. `completeness` dihitung ulang di sini dari daftar field bisnis yang sama persis dipakai `ocr-service` (`app/store/document_mapping.py`), jadi itu akurat; `grounding` dibalikin secara matematis dari situ, ada sedikit error karena pembulatan di source.
- **Breakdown per-field mana yang gak "grounded" (gak match teks OCR asli) gak bisa direkonstruksi** dari luar sama sekali — `ocr-service` cuma nyimpen `confident_score` sebagai satu angka akhir, hasil hitungan per-field-nya langsung dijumlah lalu dibuang (dicek langsung ke source, bukan dugaan). Gak ada API/DB/log yang nyimpen `raw_text` atau breakdown per-field.
- Kalau butuh breakdown per-field yang presisi (buat tuning yang lebih detail), itu perlu **perubahan di `ocr-service` sendiri** — expose `raw_text` atau simpen hasil per-field `_is_grounded()` di endpoint debug/verbose. Di luar yang bisa dikerjain dari suite QA ini.
- Gak ada threshold "aman"/"gak aman" resmi dari backend untuk skor ini — baca `README.md` folder ini buat detail.