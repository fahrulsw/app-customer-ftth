try { require('dotenv').config(); } catch (e) { /* dotenv opsional: kalau belum di-npm install, .env diabaikan dan pakai default */ }

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const genieacs = require('./services/genieacsService');
const mekariWa = require('./services/mekariWaService');

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data', 'database.json');
const JWT_SECRET = process.env.JWT_SECRET || 'merdeka-secret-key-2025';
const JWT_EXPIRES = '8h';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===================== DATABASE =====================

async function initDB() {
  await fs.ensureDir(path.join(__dirname, 'data'));
  if (!await fs.pathExists(DATA_FILE)) {
    // Default admin user
    const hashedPassword = await bcrypt.hash('admin123', 10);
    const initialData = {
      users: [
        {
          id: uuidv4(),
          username: 'admin',
          nama: 'Administrator',
          password: hashedPassword,
          role: 'admin',
          aktif: true,
          created_at: new Date().toISOString()
        }
      ],
      odc: [],
      odp: [],
      pelanggan: []
    };
    await fs.writeJson(DATA_FILE, initialData, { spaces: 2 });
    console.log('Database initialized');
    console.log('Default login: admin / admin123');
  } else {
    // Migrate: tambah array users jika belum ada
    const db = await fs.readJson(DATA_FILE);
    if (!db.users) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      db.users = [
        {
          id: uuidv4(),
          username: 'admin',
          nama: 'Administrator',
          password: hashedPassword,
          role: 'admin',
          aktif: true,
          created_at: new Date().toISOString()
        }
      ];
      await fs.writeJson(DATA_FILE, db, { spaces: 2 });
      console.log('Users migrated. Default login: admin / admin123');
    }
  }
}

async function readDB() {
  return await fs.readJson(DATA_FILE);
}

async function writeDB(data) {
  await fs.writeJson(DATA_FILE, data, { spaces: 2 });
}

// ===================== AUTH MIDDLEWARE =====================

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Token tidak ditemukan' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token tidak valid atau kadaluarsa' });
  }
}

// Middleware: hanya admin & noc yang bisa CRUD
function crudMiddleware(req, res, next) {
  if (req.user.role === 'teknisi') {
    return res.status(403).json({ success: false, message: 'Akses ditolak: role Teknisi tidak dapat melakukan perubahan data' });
  }
  next();
}

// Middleware: hanya admin yang bisa kelola user
function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Akses ditolak: hanya Admin yang dapat mengelola pengguna' });
  }
  next();
}

// Middleware: admin & noc bisa kelola user. NOC dibatasi hanya untuk akun teknisi
// (pembatasan target dilakukan di masing-masing route /api/users di bawah).
function userManagerMiddleware(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'noc') {
    return res.status(403).json({ success: false, message: 'Akses ditolak: hanya Admin/NOC yang dapat mengelola pengguna' });
  }
  next();
}

// ===================== AUTH ROUTES =====================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username dan password wajib diisi' });
    }
    const db = await readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ success: false, message: 'Username atau password salah' });
    if (!user.aktif) return res.status(403).json({ success: false, message: 'Akun Anda telah dinonaktifkan' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, message: 'Username atau password salah' });

    const token = jwt.sign(
      { id: user.id, username: user.username, nama: user.nama, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, nama: user.nama, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Verify token (cek sesi)
app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Ganti password (hanya admin)
app.put('/api/auth/password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { user_id, password_baru } = req.body;
    if (!user_id || !password_baru) {
      return res.status(400).json({ success: false, message: 'User ID dan password baru wajib diisi' });
    }
    if (password_baru.length < 6) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter' });
    }
    const db = await readDB();
    const idx = db.users.findIndex(u => u.id === user_id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    db.users[idx].password = await bcrypt.hash(password_baru, 10);
    await writeDB(db);
    res.json({ success: true, message: 'Password berhasil diubah' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== USER MANAGEMENT (Admin; NOC hanya akun teknisi) =====================

// Get all users
app.get('/api/users', authMiddleware, userManagerMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    let users = db.users.map(({ password, ...u }) => u); // hide password
    if (req.user.role === 'noc') users = users.filter(u => u.role === 'teknisi'); // NOC hanya melihat teknisi
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create user
app.post('/api/users', authMiddleware, userManagerMiddleware, async (req, res) => {
  try {
    const { username, nama, password, role, no_wa } = req.body;
    if (!username || !nama || !password || !role) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }
    if (!['admin', 'noc', 'teknisi'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role tidak valid' });
    }
    if (req.user.role === 'noc' && role !== 'teknisi') {
      return res.status(403).json({ success: false, message: 'NOC hanya dapat membuat akun teknisi' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
    }
    if (no_wa && !mekariWa.normalizeNumber(no_wa)) {
      return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid (contoh: 081234567890)' });
    }
    const db = await readDB();
    if (db.users.find(u => u.username === username)) {
      return res.status(400).json({ success: false, message: 'Username sudah digunakan' });
    }
    const newUser = {
      id: uuidv4(),
      username,
      nama,
      password: await bcrypt.hash(password, 10),
      role,
      no_wa: mekariWa.normalizeNumber(no_wa), // format 62xxxxxxxxxx, dipakai untuk notifikasi WhatsApp tiket
      aktif: true,
      created_at: new Date().toISOString()
    };
    db.users.push(newUser);
    await writeDB(db);
    const { password: _, ...safeUser } = newUser;
    res.status(201).json({ success: true, data: safeUser, message: 'User berhasil ditambahkan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update user
app.put('/api/users/:id', authMiddleware, userManagerMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    if (req.user.role === 'noc' && (db.users[idx].role !== 'teknisi' || (req.body.role && req.body.role !== 'teknisi'))) {
      return res.status(403).json({ success: false, message: 'NOC hanya dapat mengubah akun teknisi' });
    }

    const { nama, role, aktif, password, no_wa } = req.body;
    if (role && !['admin', 'noc', 'teknisi'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role tidak valid' });
    }

    // Jangan biarkan admin menghapus diri sendiri
    if (req.params.id === req.user.id && aktif === false) {
      return res.status(400).json({ success: false, message: 'Tidak dapat menonaktifkan akun Anda sendiri' });
    }

    if (nama) db.users[idx].nama = nama;
    if (role) db.users[idx].role = role;
    if (aktif !== undefined) db.users[idx].aktif = aktif;
    if (no_wa !== undefined) {
      const n = mekariWa.normalizeNumber(no_wa);
      if (no_wa && !n) return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid (contoh: 081234567890)' });
      db.users[idx].no_wa = n;
    }
    if (password) {
      if (password.length < 6) return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
      db.users[idx].password = await bcrypt.hash(password, 10);
    }
    db.users[idx].updated_at = new Date().toISOString();
    await writeDB(db);

    const { password: _, ...safeUser } = db.users[idx];
    res.json({ success: true, data: safeUser, message: 'User berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete user
app.delete('/api/users/:id', authMiddleware, userManagerMiddleware, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'Tidak dapat menghapus akun Anda sendiri' });
    }
    const db = await readDB();
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    if (req.user.role === 'noc' && db.users[idx].role !== 'teknisi') {
      return res.status(403).json({ success: false, message: 'NOC hanya dapat menghapus akun teknisi' });
    }
    db.users.splice(idx, 1);
    await writeDB(db);
    res.json({ success: true, message: 'User berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== ODC ROUTES =====================

app.get('/api/odc', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { search, page = 1, limit = 50 } = req.query;

    let data = db.odc;

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(o =>
        o.nama?.toLowerCase().includes(q) ||
        o.kode?.toLowerCase().includes(q) ||
        o.lokasi?.toLowerCase().includes(q)
      );
    }

    const total = data.length;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const totalPages = Math.ceil(total / limitNum) || 1;
    const offset = (pageNum - 1) * limitNum;
    const paged = data.slice(offset, offset + limitNum);

    res.json({ success: true, data: paged, pagination: { total, page: pageNum, limit: limitNum, totalPages } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/odc/:id', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const odc = db.odc.find(o => o.id === req.params.id);
    if (!odc) return res.status(404).json({ success: false, message: 'ODC tidak ditemukan' });
    res.json({ success: true, data: odc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/odc', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { nama, kode, lokasi, koordinat_lat, koordinat_lng, kapasitas, status, keterangan } = req.body;
    if (!nama || !kode || !lokasi) {
      return res.status(400).json({ success: false, message: 'Nama, kode, dan lokasi wajib diisi' });
    }
    if (db.odc.find(o => o.kode.trim().toLowerCase() === kode.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `Kode ODC "${kode}" sudah ada, gunakan kode lain` });
    }
    const newODC = {
      id: uuidv4(), nama, kode, lokasi,
      koordinat_lat: koordinat_lat || '',
      koordinat_lng: koordinat_lng || '',
      kapasitas: parseInt(kapasitas) || 0,
      status: status || 'Aktif',
      keterangan: keterangan || '',
      created_by: req.user.username,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.odc.push(newODC);
    await writeDB(db);
    res.status(201).json({ success: true, data: newODC, message: 'ODC berhasil ditambahkan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/odc/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.odc.findIndex(o => o.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'ODC tidak ditemukan' });
    if (req.body.kode) {
      const dup = db.odc.find(o => o.id !== req.params.id && o.kode.trim().toLowerCase() === req.body.kode.trim().toLowerCase());
      if (dup) return res.status(400).json({ success: false, message: `Kode ODC "${req.body.kode}" sudah digunakan oleh ODC lain` });
    }
    db.odc[index] = { ...db.odc[index], ...req.body, updated_at: new Date().toISOString(), updated_by: req.user.username };
    await writeDB(db);
    res.json({ success: true, data: db.odc[index], message: 'ODC berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/odc/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.odc.findIndex(o => o.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'ODC tidak ditemukan' });
    db.odc.splice(index, 1);
    await writeDB(db);
    res.json({ success: true, message: 'ODC berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== ODP ROUTES =====================

app.get('/api/odp', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { odc_id, search, page = 1, limit = 50 } = req.query;

    // Lookup maps
    const odcMap = Object.fromEntries(db.odc.map(o => [o.id, o]));
    // Count pelanggan per ODP sekali
    const pelCountMap = {};
    db.pelanggan.forEach(p => { pelCountMap[p.odp_id] = (pelCountMap[p.odp_id] || 0) + 1; });

    let data = db.odp;
    if (odc_id) data = data.filter(o => o.odc_id === odc_id);

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(o => {
        const odc = odcMap[o.odc_id];
        return (
          o.nama?.toLowerCase().includes(q) ||
          o.kode?.toLowerCase().includes(q) ||
          o.lokasi?.toLowerCase().includes(q) ||
          odc?.kode?.toLowerCase().includes(q)
        );
      });
    }

    const total = data.length;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const totalPages = Math.ceil(total / limitNum) || 1;
    const offset = (pageNum - 1) * limitNum;

    const enriched = data.slice(offset, offset + limitNum).map(odp => {
      const odc = odcMap[odp.odc_id] || {};
      return {
        ...odp,
        odc_nama: odc.nama || '-',
        odc_kode: odc.kode || '-',
        terpakai: pelCountMap[odp.id] || 0
      };
    });

    res.json({ success: true, data: enriched, pagination: { total, page: pageNum, limit: limitNum, totalPages } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/odp/:id', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const odp = db.odp.find(o => o.id === req.params.id);
    if (!odp) return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
    res.json({ success: true, data: odp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cari ODP berdasarkan kode (dipakai untuk fitur scan QR/barcode di box ODP)
app.get('/api/odp/by-kode/:kode', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const kode = req.params.kode.trim().toLowerCase();
    const odp = db.odp.find(o => o.kode.trim().toLowerCase() === kode);
    if (!odp) return res.status(404).json({ success: false, message: 'ODP dengan kode tersebut tidak ditemukan' });
    const data = {
      ...odp,
      odc_nama: db.odc.find(o => o.id === odp.odc_id)?.nama || '-',
      odc_kode: db.odc.find(o => o.id === odp.odc_id)?.kode || '-',
      terpakai: db.pelanggan.filter(p => p.odp_id === odp.id).length
    };
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/odp', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { nama, kode, odc_id, lokasi, koordinat_lat, koordinat_lng, kapasitas, status, keterangan } = req.body;
    if (!nama || !kode || !odc_id || !lokasi) {
      return res.status(400).json({ success: false, message: 'Nama, kode, ODC, dan lokasi wajib diisi' });
    }
    if (!db.odc.find(o => o.id === odc_id)) {
      return res.status(400).json({ success: false, message: 'ODC tidak ditemukan' });
    }
    if (db.odp.find(o => o.kode.trim().toLowerCase() === kode.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `Kode ODP "${kode}" sudah ada, gunakan kode lain` });
    }
    const newODP = {
      id: uuidv4(), nama, kode, odc_id, lokasi,
      koordinat_lat: koordinat_lat || '',
      koordinat_lng: koordinat_lng || '',
      kapasitas: parseInt(kapasitas) || 0,
      status: status || 'Aktif',
      keterangan: keterangan || '',
      created_by: req.user.username,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.odp.push(newODP);
    await writeDB(db);
    res.status(201).json({ success: true, data: newODP, message: 'ODP berhasil ditambahkan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/odp/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.odp.findIndex(o => o.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
    if (req.body.kode) {
      const dup = db.odp.find(o => o.id !== req.params.id && o.kode.trim().toLowerCase() === req.body.kode.trim().toLowerCase());
      if (dup) return res.status(400).json({ success: false, message: `Kode ODP "${req.body.kode}" sudah digunakan oleh ODP lain` });
    }
    db.odp[index] = { ...db.odp[index], ...req.body, updated_at: new Date().toISOString(), updated_by: req.user.username };
    await writeDB(db);
    res.json({ success: true, data: db.odp[index], message: 'ODP berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/odp/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.odp.findIndex(o => o.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
    db.odp.splice(index, 1);
    await writeDB(db);
    res.json({ success: true, message: 'ODP berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== PELANGGAN ROUTES =====================

app.get('/api/pelanggan', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { odp_id, search, page = 1, limit = 50 } = req.query;

    // Buat lookup map O(1) — hindari .find() berulang di tiap baris
    const odpMap = Object.fromEntries(db.odp.map(o => [o.id, o]));
    const odcMap = Object.fromEntries(db.odc.map(o => [o.id, o]));

    let data = db.pelanggan;

    // Filter by ODP
    if (odp_id) data = data.filter(p => p.odp_id === odp_id);

    // Server-side search: nama, no_telp, no_pelanggan, kode ODP
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(p => {
        const odp = odpMap[p.odp_id];
        return (
          p.nama?.toLowerCase().includes(q) ||
          p.no_telp?.toLowerCase().includes(q) ||
          p.no_pelanggan?.toLowerCase().includes(q) ||
          odp?.kode?.toLowerCase().includes(q) ||
          odp?.nama?.toLowerCase().includes(q)
        );
      });
    }

    const total = data.length;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const totalPages = Math.ceil(total / limitNum) || 1;
    const offset = (pageNum - 1) * limitNum;

    // Ambil hanya data halaman ini, baru enrich
    const enriched = data.slice(offset, offset + limitNum).map(p => {
      const odp = odpMap[p.odp_id] || {};
      const odc = odcMap[odp.odc_id] || {};
      return {
        ...p,
        odp_nama: odp.nama || '-',
        odp_kode: odp.kode || '-',
        odc_nama: odc.nama || '-'
      };
    });

    res.json({
      success: true,
      data: enriched,
      pagination: { total, page: pageNum, limit: limitNum, totalPages }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/pelanggan', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { nama, no_pelanggan, odp_id, port, alamat, koordinat_lat, koordinat_lng, no_telp, paket, status, keterangan, onu_device_id } = req.body;
    if (!nama || !odp_id) {
      return res.status(400).json({ success: false, message: 'Nama dan ODP wajib diisi' });
    }
    if (!db.odp.find(o => o.id === odp_id)) {
      return res.status(400).json({ success: false, message: 'ODP tidak ditemukan' });
    }
    if (no_pelanggan && db.pelanggan.find(p => p.no_pelanggan && p.no_pelanggan.trim().toLowerCase() === no_pelanggan.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `No. Pelanggan "${no_pelanggan}" sudah terdaftar` });
    }
    if (no_telp && nama && db.pelanggan.find(p => p.no_telp && p.no_telp.trim() === no_telp.trim() && p.nama && p.nama.trim().toLowerCase() === nama.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `Pelanggan "${nama}" dengan No. Telepon "${no_telp}" sudah terdaftar` });
    }
    if (db.pelanggan.find(p => p.odp_id === odp_id && p.nama && p.nama.trim().toLowerCase() === nama.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `Pelanggan dengan nama "${nama}" sudah terdaftar di ODP ini` });
    }
    const newPelanggan = {
      id: uuidv4(), nama, no_pelanggan, odp_id,
      port: port || '', alamat: alamat || '',
      koordinat_lat: koordinat_lat || '',
      koordinat_lng: koordinat_lng || '',
      no_telp: no_telp || '',
      paket: paket || '',
      status: status || 'Aktif',
      keterangan: keterangan || '',
      onu_device_id: onu_device_id || '',
      created_by: req.user.username,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.pelanggan.push(newPelanggan);
    await writeDB(db);
    res.status(201).json({ success: true, data: newPelanggan, message: 'Pelanggan berhasil ditambahkan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/pelanggan/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.pelanggan.findIndex(p => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
    if (req.body.no_pelanggan) {
      const dup = db.pelanggan.find(p => p.id !== req.params.id && p.no_pelanggan && p.no_pelanggan.trim().toLowerCase() === req.body.no_pelanggan.trim().toLowerCase());
      if (dup) return res.status(400).json({ success: false, message: `No. Pelanggan "${req.body.no_pelanggan}" sudah digunakan oleh pelanggan lain` });
    }
    if (req.body.no_telp) {
      const namaCheckTelp = req.body.nama || db.pelanggan[index].nama;
      const dupTelp = db.pelanggan.find(p => p.id !== req.params.id && p.no_telp && p.no_telp.trim() === req.body.no_telp.trim() && p.nama && namaCheckTelp && p.nama.trim().toLowerCase() === namaCheckTelp.trim().toLowerCase());
      if (dupTelp) return res.status(400).json({ success: false, message: `Pelanggan "${namaCheckTelp}" dengan No. Telepon "${req.body.no_telp}" sudah terdaftar` });
    }
    {
      const namaCheck = req.body.nama || db.pelanggan[index].nama;
      const odpCheck = req.body.odp_id || db.pelanggan[index].odp_id;
      const dupNama = db.pelanggan.find(p => p.id !== req.params.id && p.odp_id === odpCheck && p.nama && namaCheck && p.nama.trim().toLowerCase() === namaCheck.trim().toLowerCase());
      if (dupNama) return res.status(400).json({ success: false, message: `Pelanggan dengan nama "${namaCheck}" sudah terdaftar di ODP ini` });
    }
    db.pelanggan[index] = { ...db.pelanggan[index], ...req.body, updated_at: new Date().toISOString(), updated_by: req.user.username };
    await writeDB(db);
    res.json({ success: true, data: db.pelanggan[index], message: 'Pelanggan berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/pelanggan/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.pelanggan.findIndex(p => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
    db.pelanggan.splice(index, 1);
    await writeDB(db);
    res.json({ success: true, message: 'Pelanggan berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== GENIEACS (ACS) INTEGRATION =====================

// Cari device di GenieACS by serial number / device id / username PPPoE
// Dipakai fitur "Tautkan ONT" di detail pelanggan.
app.get('/api/genieacs/search', authMiddleware, async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json({ success: true, data: [] });
    const data = await genieacs.searchDevices(q);
    res.json({ success: true, data });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Gagal menghubungi GenieACS: ' + err.message });
  }
});

// Tautkan / lepas tautan ONT dari 1 pelanggan
app.put('/api/pelanggan/:id/link-onu', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.pelanggan.findIndex(p => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
    db.pelanggan[index].onu_device_id = req.body.onu_device_id || '';
    db.pelanggan[index].updated_at = new Date().toISOString();
    await writeDB(db);
    res.json({ success: true, data: db.pelanggan[index], message: req.body.onu_device_id ? 'ONT berhasil ditautkan' : 'Tautan ONT dilepas' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Info umum device (DeviceInfo). Mendukung TR-098 (InternetGatewayDevice) dan TR-181 (Device).
function getDataModelRoot(device) {
  if (device && device.Device && !device.InternetGatewayDevice) return 'Device';
  return 'InternetGatewayDevice';
}

function extractCommon(device) {
  if (!device) return null;
  const info = (device[getDataModelRoot(device)] || {}).DeviceInfo || {};
  const v = (k) => (info[k] && info[k]._value !== undefined && info[k]._value !== '' ? info[k]._value : null);
  return {
    manufacturer: v('Manufacturer'),
    productClass: v('ProductClass'),
    modelName: v('ModelName'),
    softwareVersion: v('SoftwareVersion'),
    hardwareVersion: v('HardwareVersion'),
    upTime: v('UpTime')
  };
}

// Status live 1 pelanggan (online/offline, RX power, SSID) dari GenieACS
app.get('/api/genieacs/pelanggan/:id/status', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const p = db.pelanggan.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
    if (!p.onu_device_id) return res.json({ success: true, linked: false });
    const device = await genieacs.getDeviceById(p.onu_device_id);
    if (!device) return res.json({ success: true, linked: true, found: false });
    res.json({ success: true, linked: true, found: true, data: genieacs.summarizeDevice(device), common: extractCommon(device) });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Gagal menghubungi GenieACS: ' + err.message });
  }
});

// Status live SEMUA pelanggan dalam 1 ODP sekaligus (dipakai di tabel detail ODP)
// Return: { "<pelanggan_id>": { online, rxPowerDbm, ... } }
app.get('/api/genieacs/odp/:odpId/status', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const pelangganList = db.pelanggan.filter(p => p.odp_id === req.params.odpId && p.onu_device_id);
    if (!pelangganList.length) return res.json({ success: true, data: {} });

    const deviceIds = pelangganList.map(p => p.onu_device_id);
    const devices = await genieacs.listDevices({ _id: { $in: deviceIds } });
    const deviceMap = Object.fromEntries((devices || []).map(d => [d._id, genieacs.summarizeDevice(d)]));

    const result = {};
    pelangganList.forEach(p => { result[p.id] = deviceMap[p.onu_device_id] || null; });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Gagal menghubungi GenieACS: ' + err.message });
  }
});

app.post('/api/genieacs/pelanggan/:id/reboot', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const p = db.pelanggan.find(x => x.id === req.params.id);
    if (!p || !p.onu_device_id) return res.status(400).json({ success: false, message: 'Pelanggan belum ditautkan ke ONT' });
    await genieacs.reboot(p.onu_device_id);
    res.json({ success: true, message: 'Perintah reboot dikirim ke ONT' });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Gagal menghubungi GenieACS: ' + err.message });
  }
});

app.post('/api/genieacs/pelanggan/:id/wifi', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const p = db.pelanggan.find(x => x.id === req.params.id);
    if (!p || !p.onu_device_id) return res.status(400).json({ success: false, message: 'Pelanggan belum ditautkan ke ONT' });
    const { ssid, password, enable, security, band } = req.body;
    await genieacs.setWifi(p.onu_device_id, { ssid, password, enable, security, band });
    res.json({ success: true, message: 'Perintah ganti WiFi dikirim ke ONT' });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Gagal menghubungi GenieACS: ' + err.message });
  }
});

app.post('/api/genieacs/pelanggan/:id/refresh', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const p = db.pelanggan.find(x => x.id === req.params.id);
    if (!p || !p.onu_device_id) return res.status(400).json({ success: false, message: 'Pelanggan belum ditautkan ke ONT' });
    // Minta ONT lapor ulang subtree WANDevice (RX power) & LANDevice (WiFi/SSID)
    await genieacs.refreshObject(p.onu_device_id, 'InternetGatewayDevice.WANDevice');
    await genieacs.refreshObject(p.onu_device_id, 'InternetGatewayDevice.LANDevice');
    res.json({ success: true, message: 'Permintaan refresh dikirim ke ONT, tunggu beberapa detik lalu cek lagi' });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Gagal menghubungi GenieACS: ' + err.message });
  }
});

app.post('/api/genieacs/pelanggan/:id/common', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const p = db.pelanggan.find(x => x.id === req.params.id);
    if (!p || !p.onu_device_id) return res.status(400).json({ success: false, message: 'Pelanggan belum ditautkan ke ONT' });
    // Deteksi data model (TR-098 / TR-181) dari dokumen device
    const device = await genieacs.getDeviceById(p.onu_device_id);
    const root = getDataModelRoot(device);
    // Minta ONT lapor ulang DeviceInfo (Manufacturer, Model, Versi, UpTime)
    await genieacs.refreshObject(p.onu_device_id, root + '.DeviceInfo');
    res.json({ success: true, message: 'Permintaan refresh info perangkat dikirim ke ONT, tunggu beberapa detik lalu cek lagi' });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Gagal menghubungi GenieACS: ' + err.message });
  }
});

// ===================== RESOLVE LINK GOOGLE MAPS =====================
// Dipakai fitur "Ambil Koordinat" di form Pelanggan/ODC/ODP: menerima link Google Maps
// (bisa link pendek seperti maps.app.goo.gl atau link lengkap maps.google.com),
// lalu mengikuti redirect-nya (kalau perlu) dan membaca koordinat lat/lng dari URL akhirnya.
// Tidak pakai library tambahan, cukup modul bawaan Node (http/https).

function extractLatLngFromText(text) {
  if (!text) return null;
  const patterns = [
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,          // .../@-8.123,115.567,17z
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,       // parameter data ...!3d..!4d..
    /[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,      // ?q=-8.123,115.567
    /[?&]ll=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,     // ?ll=-8.123,115.567
    /\/(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)(?:,|\/|$|\?)/ // fallback umum: /lat,lng
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

// Ambil URL final (setelah mengikuti semua redirect) + isi HTML-nya.
function fetchFollowRedirects(urlString, maxRedirects = 8) {
  return new Promise((resolve, reject) => {
    function doRequest(currentUrl, redirectsLeft) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        return reject(new Error('Format link tidak valid'));
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new Error('Link harus dimulai dengan http:// atau https://'));
      }
      const client = parsed.protocol === 'http:' ? http : https;
      const clientReq = client.request(parsed, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        },
        timeout: 8000
      }, (response) => {
        const { statusCode, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume(); // buang body redirect, tidak perlu dibaca
          if (redirectsLeft <= 0) return reject(new Error('Terlalu banyak redirect'));
          let nextUrl;
          try { nextUrl = new URL(headers.location, currentUrl).toString(); }
          catch (e) { return reject(new Error('Redirect tidak valid')); }
          return doRequest(nextUrl, redirectsLeft - 1);
        }
        const chunks = [];
        let totalLen = 0;
        const MAX_BODY = 300 * 1024; // batasi 300KB, cukup untuk cari koordinat di HTML
        response.on('data', (chunk) => {
          totalLen += chunk.length;
          if (totalLen <= MAX_BODY) chunks.push(chunk);
        });
        response.on('end', () => resolve({ finalUrl: currentUrl, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      clientReq.on('timeout', () => clientReq.destroy(new Error('Waktu permintaan habis, server Maps tidak merespon')));
      clientReq.on('error', reject);
      clientReq.end();
    }
    doRequest(urlString, maxRedirects);
  });
}

app.post('/api/resolve-maps-link', authMiddleware, async (req, res) => {
  try {
    const link = (req.body.link || '').trim();
    if (!link) return res.status(400).json({ success: false, message: 'Link wajib diisi' });
    if (!/^https?:\/\//i.test(link)) {
      return res.status(400).json({ success: false, message: 'Link harus dimulai dengan http:// atau https://' });
    }

    // 1. Coba baca langsung dari link yang dikirim (kalau sudah link lengkap yang mengandung koordinat)
    let coord = extractLatLngFromText(link);
    let finalUrl = link;

    // 2. Kalau belum ketemu, ikuti redirect-nya (untuk link pendek maps.app.goo.gl / goo.gl/maps)
    if (!coord) {
      const result = await fetchFollowRedirects(link);
      finalUrl = result.finalUrl;
      coord = extractLatLngFromText(finalUrl) || extractLatLngFromText(result.body);
    }

    if (!coord) {
      return res.status(422).json({ success: false, message: 'Koordinat tidak ditemukan dari link tersebut' });
    }
    res.json({ success: true, data: coord, url: finalUrl });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Gagal memproses link: ' + err.message });
  }
});

// ===================== MAP =====================

// Data gabungan untuk peta: ODC, ODP, Pelanggan (yang punya koordinat) + rute kabel ODC-ODP
app.get('/api/map/all', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();

    const hasCoord = (o) => o.koordinat_lat && o.koordinat_lng &&
      !isNaN(parseFloat(o.koordinat_lat)) && !isNaN(parseFloat(o.koordinat_lng));

    const odc = db.odc.filter(hasCoord).map(o => ({
      id: o.id, nama: o.nama, kode: o.kode, lokasi: o.lokasi,
      lat: parseFloat(o.koordinat_lat), lng: parseFloat(o.koordinat_lng),
      kapasitas: o.kapasitas, status: o.status
    }));

    const odp = db.odp.filter(hasCoord).map(o => {
      const odcInduk = db.odc.find(x => x.id === o.odc_id);
      const terpakai = db.pelanggan.filter(p => p.odp_id === o.id).length;
      return {
        id: o.id, nama: o.nama, kode: o.kode, lokasi: o.lokasi,
        lat: parseFloat(o.koordinat_lat), lng: parseFloat(o.koordinat_lng),
        kapasitas: o.kapasitas, status: o.status, terpakai,
        odc_id: o.odc_id,
        odc_nama: odcInduk ? odcInduk.nama : '-',
        odc_kode: odcInduk ? odcInduk.kode : '-',
        odc_lat: odcInduk && hasCoord(odcInduk) ? parseFloat(odcInduk.koordinat_lat) : null,
        odc_lng: odcInduk && hasCoord(odcInduk) ? parseFloat(odcInduk.koordinat_lng) : null
      };
    });

    const pelanggan = db.pelanggan.filter(hasCoord).map(p => {
      const odpInduk = db.odp.find(x => x.id === p.odp_id);
      return {
        id: p.id, nama: p.nama, no_pelanggan: p.no_pelanggan, alamat: p.alamat,
        lat: parseFloat(p.koordinat_lat), lng: parseFloat(p.koordinat_lng),
        no_telp: p.no_telp, paket: p.paket, status: p.status,
        odp_id: p.odp_id,
        odp_nama: odpInduk ? odpInduk.nama : '-',
        odp_kode: odpInduk ? odpInduk.kode : '-',
        odp_lat: odpInduk && hasCoord(odpInduk) ? parseFloat(odpInduk.koordinat_lat) : null,
        odp_lng: odpInduk && hasCoord(odpInduk) ? parseFloat(odpInduk.koordinat_lng) : null
      };
    });

    res.json({
      success: true,
      data: { odc, odp, pelanggan },
      meta: {
        total_odc: db.odc.length, odc_with_coord: odc.length,
        total_odp: db.odp.length, odp_with_coord: odp.length,
        total_pelanggan: db.pelanggan.length, pelanggan_with_coord: pelanggan.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== DUPLICATE CHECK =====================

function findDuplicateGroups(arr, field) {
  const map = {};
  arr.forEach(item => {
    const val = (item[field] || '').toString().trim().toLowerCase();
    if (!val) return;
    if (!map[val]) map[val] = [];
    map[val].push(item);
  });
  return Object.values(map).filter(group => group.length > 1);
}

function findDuplicateGroupsByKey(arr, keyFn) {
  const map = {};
  arr.forEach(item => {
    const val = keyFn(item);
    if (!val) return;
    if (!map[val]) map[val] = [];
    map[val].push(item);
  });
  return Object.values(map).filter(group => group.length > 1);
}

app.get('/api/duplicates', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const odpMap = Object.fromEntries(db.odp.map(o => [o.id, o]));

    const odcDup = findDuplicateGroups(db.odc, 'kode').map(group => ({
      field: 'kode',
      items: group.map(o => ({ id: o.id, nama: o.nama, kode: o.kode, created_at: o.created_at }))
    }));

    const odpDup = findDuplicateGroups(db.odp, 'kode').map(group => ({
      field: 'kode',
      items: group.map(o => ({ id: o.id, nama: o.nama, kode: o.kode, created_at: o.created_at }))
    }));

    // Pelanggan: cek 3 kriteria sekaligus karena no_pelanggan sering kosong (tidak ada di form input)
    // No. Telepon hanya dianggap duplikat jika NAMA juga sama (1 nomor HP boleh dipakai untuk lebih dari 1 pemasangan, mis. beda anggota keluarga)
    const pelNoTelpDup = findDuplicateGroupsByKey(db.pelanggan, p => {
      const telp = p.no_telp && p.no_telp.trim();
      const nama = (p.nama || '').trim().toLowerCase();
      if (!telp || !nama) return null;
      return telp + '|' + nama;
    }).map(group => ({
      field: 'no_telp',
      label: 'No. Telepon + Nama',
      items: group.map(p => ({ id: p.id, nama: p.nama, value: p.no_telp, odp_nama: odpMap[p.odp_id]?.nama || '-', created_at: p.created_at }))
    }));

    const pelNamaOdpDup = findDuplicateGroupsByKey(db.pelanggan, p => {
      const nama = (p.nama || '').trim().toLowerCase();
      if (!nama || !p.odp_id) return null;
      return nama + '|' + p.odp_id;
    }).map(group => ({
      field: 'nama_odp',
      label: 'Nama + ODP',
      items: group.map(p => ({ id: p.id, nama: p.nama, value: `${p.nama} (ODP: ${odpMap[p.odp_id]?.nama || '-'})`, odp_nama: odpMap[p.odp_id]?.nama || '-', created_at: p.created_at }))
    }));

    const pelNoPelangganDup = findDuplicateGroups(db.pelanggan, 'no_pelanggan').map(group => ({
      field: 'no_pelanggan',
      label: 'No. Pelanggan',
      items: group.map(p => ({ id: p.id, nama: p.nama, value: p.no_pelanggan, odp_nama: odpMap[p.odp_id]?.nama || '-', created_at: p.created_at }))
    }));

    const pelangganDup = [...pelNoTelpDup, ...pelNamaOdpDup, ...pelNoPelangganDup];

    res.json({
      success: true,
      data: { odc: odcDup, odp: odpDup, pelanggan: pelangganDup },
      meta: {
        total_odc_dup: odcDup.length,
        total_odp_dup: odpDup.length,
        total_pelanggan_dup: pelangganDup.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== STATS =====================

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const stats = {
      total_odc: db.odc.length,
      odc_aktif: db.odc.filter(o => o.status === 'Aktif').length,
      total_odp: db.odp.length,
      odp_aktif: db.odp.filter(o => o.status === 'Aktif').length,
      total_pelanggan: db.pelanggan.length,
      pelanggan_aktif: db.pelanggan.filter(p => p.status === 'Aktif').length,
      total_kapasitas_odp: db.odp.reduce((sum, o) => sum + (parseInt(o.kapasitas) || 0), 0),
      total_terpakai: db.pelanggan.length
    };
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== WHATSAPP (Mekari Qontak) =====================
// Khusus admin: pengaturan akun Mekari (form di web), tes kirim, dan daftar channel/template
app.get('/api/wa/settings', authMiddleware, adminMiddleware, (req, res) => {
  res.json({ success: true, data: mekariWa.publicSettings() });
});

app.put('/api/wa/settings', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { enabled, client_id, client_secret, channel_id, tpl_pelanggan, tpl_teknisi, tpl_selesai } = req.body;
    const idOk = v => v === undefined || v === '' || /^[\w.-]{4,100}$/.test(String(v).trim());
    for (const [label, v] of [['Client ID', client_id], ['Channel ID', channel_id], ['Template Pelanggan', tpl_pelanggan], ['Template Teknisi', tpl_teknisi], ['Template Selesai', tpl_selesai]]) {
      if (!idOk(v)) return res.status(400).json({ success: false, message: label + ' tidak valid (hanya huruf, angka, titik, strip, garis bawah)' });
    }
    if (client_secret && String(client_secret).length > 300) return res.status(400).json({ success: false, message: 'Client Secret terlalu panjang' });
    mekariWa.saveSettings({ enabled: typeof enabled === 'boolean' ? enabled : undefined, client_id, client_secret, channel_id, tpl_pelanggan, tpl_teknisi, tpl_selesai });
    res.json({ success: true, data: mekariWa.publicSettings(), message: 'Pengaturan WhatsApp disimpan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/wa/test', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { no_wa, jenis = 'pelanggan' } = req.body;
    if (!mekariWa.normalizeNumber(no_wa)) return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid' });
    const contoh = {
      id: 'TEST0001', kode: 'TKT-TES000000', pelanggan_nama: 'Pelanggan Contoh', pelanggan_no: 'PLG-001', pelanggan_hp: no_wa,
      kategori: 'Internet Mati', prioritas: 'sedang', alamat: 'Jl. Contoh No. 1', deskripsi: 'Tes notifikasi tiket',
      lat: '', lng: '', ditugaskan_nama: 'Teknisi Tes', teknisi_nama: 'Teknisi Tes',
      waktu: new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    };
    const out = jenis === 'teknisi'
      ? await mekariWa.notifyTiketBaru({ ...contoh, pelanggan_hp: '' }, [{ nama: 'Teknisi Tes', no_wa }], { force: true })
      : jenis === 'selesai'
        ? await mekariWa.notifyTiketSelesai(contoh, 'Perangkat sudah diganti dan internet normal kembali', { force: true })
        : await mekariWa.notifyTiketBaru(contoh, [], { force: true });
    if (out.skipped) return res.status(400).json({ success: false, message: out.reason });
    const gagal = out.results.find(r => !r.ok);
    if (gagal) return res.status(502).json({ success: false, message: 'Gagal kirim: ' + gagal.error });
    res.json({ success: true, message: 'Pesan tes terkirim ke ' + no_wa });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/wa/templates', authMiddleware, adminMiddleware, async (req, res) => {
  try { res.json({ success: true, data: await mekariWa.listTemplates() }); }
  catch (err) { res.status(502).json({ success: false, message: err.message }); }
});

app.get('/api/wa/channels', authMiddleware, adminMiddleware, async (req, res) => {
  try { res.json({ success: true, data: await mekariWa.listChannels() }); }
  catch (err) { res.status(502).json({ success: false, message: err.message }); }
});

// ===================== TIKET (+ notifikasi Telegram) =====================
const tiketRouter = require('./tiket');
// Parameter ke-2: pengambil daftar user (dipakai tiket.js untuk validasi teknisi yang ditugaskan)
app.use('/api/tiket', tiketRouter(authMiddleware, async () => (await readDB()).users));

// Start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
  });
});