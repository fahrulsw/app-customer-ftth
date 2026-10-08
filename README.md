# ⚡ FiberNet — Sistem Manajemen ODC & ODP

Aplikasi web untuk mendata ODC (Optical Distribution Cabinet) dan ODP (Optical Distribution Point) beserta pelanggan fiber optik.

## 🚀 Cara Menjalankan

### 1. Install dependencies
```bash
cd odc-odp-app
npm install
```

### 2. Jalankan server
```bash
node server.js
```

### 3. Buka browser
```
http://localhost:3000
```

---

## 📁 Struktur Folder
```
odc-odp-app/
├── server.js          # Backend Node.js (Express)
├── package.json       # Konfigurasi npm
├── data/
│   └── database.json  # Database JSON (auto-generated)
└── public/
    └── index.html     # Frontend HTML
```

---

## 🔌 API Endpoints

### ODC
| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET | /api/odc | Ambil semua ODC |
| GET | /api/odc/:id | Ambil ODC by ID |
| POST | /api/odc | Tambah ODC baru |
| PUT | /api/odc/:id | Update ODC |
| DELETE | /api/odc/:id | Hapus ODC |

### ODP
| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET | /api/odp | Ambil semua ODP |
| GET | /api/odp?odc_id=xxx | Filter ODP by ODC |
| POST | /api/odp | Tambah ODP baru |
| PUT | /api/odp/:id | Update ODP |
| DELETE | /api/odp/:id | Hapus ODP |

### Pelanggan
| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET | /api/pelanggan | Ambil semua pelanggan |
| GET | /api/pelanggan?odp_id=xxx | Filter by ODP |
| POST | /api/pelanggan | Tambah pelanggan |
| PUT | /api/pelanggan/:id | Update pelanggan |
| DELETE | /api/pelanggan/:id | Hapus pelanggan |

### Dashboard
| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET | /api/stats | Statistik ringkasan |

---

## 📦 Fitur
- ✅ CRUD ODC (Optical Distribution Cabinet)
- ✅ CRUD ODP (Optical Distribution Point) — terhubung ke ODC
- ✅ CRUD Pelanggan — terhubung ke ODP
- ✅ Dashboard statistik (total ODC, ODP, pelanggan, kapasitas)
- ✅ Filter ODP berdasarkan ODC
- ✅ Filter pelanggan berdasarkan ODP
- ✅ Pencarian real-time
- ✅ Indikator kapasitas port (progress bar warna)
- ✅ Status Aktif / Nonaktif / Maintenance / Isolir
- ✅ Penyimpanan data JSON (tanpa database eksternal)
