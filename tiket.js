// tiket.js — router tiket + notifikasi Telegram
// Dipasang di server.js:
//   const tiketRouter = require('./tiket');
//   app.use('/api/tiket', tiketRouter(authMiddleware));
// Butuh: npm i better-sqlite3   (Node 18+ untuk fetch bawaan)
// Token bot & Chat ID diisi lewat web: Tiket > tombol "Telegram" (role Admin & NOC).
// Fallback: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID di .env kalau belum diisi lewat web.

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const wa = require('./services/mekariWaService'); // notifikasi WhatsApp (Mekari Qontak)

const dbPath = process.env.TIKET_DB || path.join(__dirname, 'data', 'tiket.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const fotoDir = path.join(path.dirname(dbPath), 'tiket-foto'); // foto pekerjaan teknisi
fs.mkdirSync(fotoDir, { recursive: true });
const db = new Database(dbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS tiket (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pelanggan_id TEXT, pelanggan_nama TEXT NOT NULL, pelanggan_no TEXT, pelanggan_hp TEXT, alamat TEXT, lat TEXT, lng TEXT, odp_nama TEXT,
  kategori TEXT NOT NULL, prioritas TEXT NOT NULL DEFAULT 'sedang', deskripsi TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  dibuat_oleh_id TEXT, dibuat_oleh_nama TEXT,
  teknisi_id TEXT, teknisi_nama TEXT, foto_progress TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pengaturan (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tiket_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tiket_id INTEGER NOT NULL,
  aksi TEXT NOT NULL, oleh_nama TEXT, catatan TEXT, created_at TEXT DEFAULT (datetime('now'))
);`);

// Migrasi: tambah kolom baru jika tiket.db dibuat dari versi sebelumnya
for (const col of ['pelanggan_no', 'alamat', 'lat', 'lng', 'foto_progress', 'ditugaskan_ke', 'ditugaskan_nama']) {
  if (!db.prepare('PRAGMA table_info(tiket)').all().some(c => c.name === col)) db.exec(`ALTER TABLE tiket ADD COLUMN ${col} TEXT`);
}

// Waktu WIB dari created_at (UTC di SQLite): teks "2026-08-13 14:16:34" dan stamp "260813141634"
function wib(utc) {
  const iso = new Date(new Date(String(utc).replace(' ', 'T') + 'Z').getTime() + 7 * 3600e3).toISOString();
  return { text: iso.slice(0, 10) + ' ' + iso.slice(11, 19), stamp: iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) };
}
const kode = t => 'TKT-' + wib(t.created_at).stamp;
const esc = s => String(s || '-').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = t => { if (!t) return t; const { foto_progress, ...r } = t; return { ...r, kode: kode(t), ada_foto: !!foto_progress, created_at: t.created_at + 'Z', updated_at: t.updated_at + 'Z' }; };

const getSetting = k => db.prepare('SELECT value FROM pengaturan WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO pengaturan (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
const telegramCfg = () => ({
  token: getSetting('telegram_token') || process.env.TELEGRAM_BOT_TOKEN || '',
  chat: getSetting('telegram_chat_id') || process.env.TELEGRAM_CHAT_ID || ''
});

async function panggilTelegram(method, init) {
  const { token } = telegramCfg();
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', signal: AbortSignal.timeout(30000), ...init });
    if (!r.ok) {
      const msg = (await r.json().catch(() => ({}))).description || ('HTTP ' + r.status);
      console.error('[Telegram] gagal:', msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    console.error('[Telegram] error:', e.message);
    return { ok: false, error: e.message };
  }
}

// Tidak melempar error: gagal kirim Telegram tidak boleh menggagalkan tiket.
// foto = { buf, mime, ext } -> dikirim sebagai foto dengan caption; jika gagal, teks tetap dikirim.
async function kirimTelegram(text, buttons = [], foto = null) {
  const { token, chat } = telegramCfg();
  if (!token || !chat) {
    console.warn('[Telegram] belum dikonfigurasi (Tiket > Telegram, login sebagai Admin/NOC)');
    return { ok: false, error: 'Token bot / Chat ID belum diisi' };
  }
  if (foto) {
    const fd = new FormData();
    fd.append('chat_id', chat);
    fd.append('caption', text.slice(0, 1000));
    fd.append('parse_mode', 'HTML');
    fd.append('photo', new Blob([foto.buf], { type: foto.mime }), 'foto.' + foto.ext);
    const r = await panggilTelegram('sendPhoto', { body: fd });
    if (r.ok) return r;
  }
  return panggilTelegram('sendMessage', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
      ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : {}) })
  });
}

// Deteksi jenis gambar dari byte awal (jangan percaya header Content-Type saja)
function jenisGambar(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: 'png', mime: 'image/png' };
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

// Tombol URL Telegram hanya menerima http(s):// atau tg:// (tel: ditolak), jadi "Telp" membuka WhatsApp
function waNumber(hp) {
  let d = String(hp || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1); else if (d.startsWith('8')) d = '62' + d;
  return /^62\d{8,13}$/.test(d) ? d : null;
}
function tombolTiket(t) {
  const btn = [];
  const wa = waNumber(t.pelanggan_hp);
  if (wa) btn.push({ text: '📞 Telp Pelanggan', url: `https://wa.me/${wa}` });
  if (t.lat && t.lng) btn.push({ text: '📍 Cek Lokasi', url: `https://www.google.com/maps?q=${t.lat},${t.lng}` });
  else if (t.alamat) btn.push({ text: '📍 Cek Lokasi', url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.alamat)}` });
  return btn;
}
const koordinat = (v, max) => { const n = parseFloat(v); return Number.isFinite(n) && Math.abs(n) <= max ? String(n) : null; };

function ringkas(t) {
  return `<b>#${kode(t)}</b> — ${esc(t.kategori)}\n` +
    `Pelanggan: ${esc(t.pelanggan_nama)}${t.pelanggan_hp ? ' (' + esc(t.pelanggan_hp) + ')' : ''}\n` +
    `ODP: ${esc(t.odp_nama)}\nPrioritas: ${esc(t.prioritas)}`;
}

module.exports = function (auth, getUsers) {
  const r = express.Router();
  r.use(auth);

  // Teknisi aktif (sumber: daftar user di server.js). Dipakai untuk validasi penugasan tiket.
  const daftarTeknisi = async () => {
    try { return typeof getUsers === 'function' ? (await getUsers()).filter(u => u.role === 'teknisi' && u.aktif !== false) : []; }
    catch (e) { console.error('[Tiket] gagal memuat user:', e.message); return []; }
  };
  // Aturan yang sama dengan daftar tiket: teknisi hanya boleh melihat tiket terbuka yang belum ditugaskan
  // (atau ditugaskan ke dirinya), tiket yang ia kerjakan, dan tiket yang ditugaskan kepadanya.
  const bolehLihat = (t, u) => u.role !== 'teknisi'
    || (t.status === 'open' && (!t.ditugaskan_ke || t.ditugaskan_ke === u.id))
    || t.teknisi_id === u.id || t.ditugaskan_ke === u.id;
  const log = (id, aksi, u, catatan = null) =>
    db.prepare('INSERT INTO tiket_log (tiket_id, aksi, oleh_nama, catatan) VALUES (?,?,?,?)').run(id, aksi, u.nama, catatan);
  const get = id => db.prepare('SELECT * FROM tiket WHERE id=?').get(id);

  // Kirim WA di latar belakang (tidak ditunggu, tidak boleh menggagalkan tiket). Kegagalan dicatat di riwayat tiket.
  // teknisi: array user teknisi penerima. kePelanggan=false -> hanya teknisi (mis. saat penugasan ulang).
  const kirimWa = (t, teknisi, kePelanggan = true) => {
    const data = { ...t, kode: kode(t), waktu: wib(t.created_at).text, ...(kePelanggan ? {} : { pelanggan_hp: '' }) };
    wa.notifyTiketBaru(data, teknisi).then(h => {
      (h.results || []).filter(x => !x.ok).forEach(x =>
        log(t.id, `Notifikasi WA gagal (${x.peran}: ${x.nama})`, { nama: 'Sistem' }, String(x.error).slice(0, 200)));
    }).catch(e => console.error('[WA] error:', e.message));
  };
  // Tiket selesai -> WA ke pelanggan (hanya jika Template Selesai sudah diisi di pengaturan WhatsApp)
  const kirimWaSelesai = (t, catatan) => {
    wa.notifyTiketSelesai({ ...t, kode: kode(t), waktu: wib(t.created_at).text }, catatan).then(h => {
      (h.results || []).filter(x => !x.ok).forEach(x =>
        log(t.id, `Notifikasi WA gagal (${x.peran}: ${x.nama})`, { nama: 'Sistem' }, String(x.error).slice(0, 200)));
    }).catch(e => console.error('[WA] error:', e.message));
  };

  // ---- Pengaturan Telegram: role Admin & NOC (harus di atas route '/:id') ----
  const onlyNoc = (req, res, next) => ['admin', 'noc'].includes(req.user.role) ? next()
    : res.status(403).json({ success: false, message: 'Hanya role Admin/NOC yang dapat mengatur Telegram' });

  r.get('/telegram', onlyNoc, (req, res) => {
    const { token, chat } = telegramCfg();
    res.json({ success: true, data: { configured: !!(token && chat), token_masked: token ? '••••••' + token.slice(-4) : '', chat_id: chat } });
  });

  r.put('/telegram', onlyNoc, (req, res) => {
    const token = String(req.body.token || '').trim();
    const chat = String(req.body.chat_id || '').trim();
    if (token && !/^\d{5,}:[\w-]{20,}$/.test(token)) return res.status(400).json({ success: false, message: 'Format token bot tidak valid (contoh: 123456789:AAH...)' });
    if (!/^(-?\d+|@\w+)$/.test(chat)) return res.status(400).json({ success: false, message: 'Chat ID tidak valid (contoh: -1001234567890)' });
    if (!token && !telegramCfg().token) return res.status(400).json({ success: false, message: 'Token bot wajib diisi' });
    if (token) setSetting('telegram_token', token); // kosong = pertahankan token lama
    setSetting('telegram_chat_id', chat);
    res.json({ success: true });
  });

  r.post('/telegram/test', onlyNoc, async (req, res) => {
    const h = await kirimTelegram(`🔔 <b>Tes notifikasi</b>\nBot tiket terhubung. Dikirim oleh ${esc(req.user.nama)}.`);
    res.json(h.ok ? { success: true } : { success: false, message: 'Gagal kirim: ' + h.error });
  });

  // Daftar teknisi aktif untuk dropdown penugasan (admin & noc). Harus di atas route '/:id'.
  r.get('/teknisi', async (req, res) => {
    if (!['admin', 'noc'].includes(req.user.role)) return res.status(403).json({ success: false, message: 'Tidak diizinkan' });
    res.json({ success: true, data: (await daftarTeknisi()).map(u => ({ id: u.id, nama: u.nama })) });
  });

  r.get('/', (req, res) => {
    const { status, search } = req.query;
    let sql = 'SELECT * FROM tiket WHERE 1=1'; const p = [];
    if (status) { sql += ' AND status=?'; p.push(status); }
    if (search) {
      sql += " AND (pelanggan_nama LIKE ? OR substr(strftime('%Y%m%d%H%M%S', created_at, '+7 hours'), 3) LIKE ?)";
      p.push(`%${search}%`, `%${String(search).replace(/\D/g, '') || '@@'}%`);
    }
    if (req.user.role === 'teknisi') {
      sql += " AND ((status='open' AND (ditugaskan_ke IS NULL OR ditugaskan_ke=?)) OR teknisi_id=? OR ditugaskan_ke=?)";
      p.push(req.user.id, req.user.id, req.user.id);
    }
    res.json({ success: true, data: db.prepare(sql + ' ORDER BY id DESC LIMIT 500').all(...p).map(out) });
  });

  r.get('/:id', (req, res) => {
    const t = get(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
    if (!bolehLihat(t, req.user)) return res.status(403).json({ success: false, message: 'Tiket ini ditugaskan ke teknisi lain' });
    const logs = db.prepare('SELECT * FROM tiket_log WHERE tiket_id=? ORDER BY id').all(t.id)
      .map(l => ({ ...l, created_at: l.created_at + 'Z' }));
    res.json({ success: true, data: { ...out(t), logs } });
  });

  // Buat tiket (admin & noc)
  r.post('/', async (req, res) => {
    if (!['admin', 'noc'].includes(req.user.role)) return res.status(403).json({ success: false, message: 'Tidak diizinkan' });
    try {
    const b = req.body;
    if (!b.pelanggan_nama || !b.kategori) return res.status(400).json({ success: false, message: 'Pelanggan & kategori wajib diisi' });
    const prio = ['rendah', 'sedang', 'tinggi'].includes(b.prioritas) ? b.prioritas : 'sedang';
    let tugas = null; // teknisi yang ditugaskan (opsional)
    if (b.ditugaskan_ke) {
      tugas = (await daftarTeknisi()).find(u => u.id === b.ditugaskan_ke);
      if (!tugas) return res.status(400).json({ success: false, message: 'Teknisi yang dipilih tidak valid atau tidak aktif' });
    }
    const info = db.prepare(`INSERT INTO tiket (pelanggan_id, pelanggan_nama, pelanggan_no, pelanggan_hp, alamat, lat, lng, odp_nama, kategori, prioritas, deskripsi, dibuat_oleh_id, dibuat_oleh_nama, ditugaskan_ke, ditugaskan_nama)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.pelanggan_id || null, b.pelanggan_nama, b.pelanggan_no || null, b.pelanggan_hp || null, b.alamat || null, koordinat(b.lat, 90), koordinat(b.lng, 180), b.odp_nama || null, b.kategori, prio, b.deskripsi || null, req.user.id, req.user.nama, tugas ? tugas.id : null, tugas ? tugas.nama : null);
    log(info.lastInsertRowid, 'Tiket dibuat', req.user, b.deskripsi);
    if (tugas) log(info.lastInsertRowid, 'Ditugaskan ke ' + tugas.nama, req.user);
    const t = get(info.lastInsertRowid);
    kirimTelegram(
      `<b>TIKET - ${esc(t.kategori)} - ${esc(t.prioritas.charAt(0).toUpperCase() + t.prioritas.slice(1))}</b>\n\n` +
      `No Tiket: #${kode(t)}\n` +
      `Nama: ${esc(t.pelanggan_nama)}${t.pelanggan_no ? ' - ' + esc(t.pelanggan_no) : ''}\n` +
      `Alamat: ${esc(t.alamat)}\n` +
      (t.ditugaskan_nama ? `Ditugaskan ke: ${esc(t.ditugaskan_nama)}\n` : '') + '\n' +
      `Detail: ${esc(t.deskripsi)}\n` +
      `Foto Rumah: Tidak tersedia\n\n` +
      `Waktu: ${wib(t.created_at).text}`,
      tombolTiket(t));
    // WhatsApp: ke pelanggan + teknisi (yang ditugaskan; kalau tiket terbuka -> semua teknisi aktif yang punya no_wa)
    kirimWa(t, tugas ? [tugas] : await daftarTeknisi());
    res.json({ success: true, data: out(t) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // Tugaskan / ubah / hapus penugasan teknisi (admin & noc). Body: { teknisi_id } — null/kosong = hapus penugasan.
  // Kalau tiket sudah 'taken' oleh teknisi lain, tiket dilepas kembali ke 'open' agar bisa diambil penerima baru.
  r.post('/:id/assign', async (req, res) => {
    if (!['admin', 'noc'].includes(req.user.role)) return res.status(403).json({ success: false, message: 'Tidak diizinkan' });
    try {
      const t0 = get(req.params.id);
      if (!t0) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
      if (!['open', 'taken'].includes(t0.status)) return res.status(409).json({ success: false, message: 'Tiket yang sudah dikerjakan atau ditutup tidak bisa ditugaskan ulang' });
      let tugas = null;
      if (req.body.teknisi_id) {
        tugas = (await daftarTeknisi()).find(u => u.id === req.body.teknisi_id);
        if (!tugas) return res.status(400).json({ success: false, message: 'Teknisi yang dipilih tidak valid atau tidak aktif' });
      }
      const lepas = t0.status === 'taken' && t0.teknisi_id !== (tugas ? tugas.id : null);
      const c = lepas
        ? db.prepare(`UPDATE tiket SET ditugaskan_ke=?, ditugaskan_nama=?, status='open', teknisi_id=NULL, teknisi_nama=NULL, updated_at=datetime('now') WHERE id=? AND status IN ('open','taken')`)
            .run(tugas ? tugas.id : null, tugas ? tugas.nama : null, t0.id)
        : db.prepare(`UPDATE tiket SET ditugaskan_ke=?, ditugaskan_nama=?, updated_at=datetime('now') WHERE id=? AND status IN ('open','taken')`)
            .run(tugas ? tugas.id : null, tugas ? tugas.nama : null, t0.id);
      if (!c.changes) return res.status(409).json({ success: false, message: 'Status tiket sudah berubah, muat ulang halaman' });
      log(t0.id, tugas ? 'Ditugaskan ke ' + tugas.nama : 'Penugasan dihapus', req.user, lepas ? `Dilepas dari ${t0.teknisi_nama}` : null);
      const t = get(t0.id);
      if (tugas) kirimTelegram(`📌 <b>TIKET DITUGASKAN</b>\n${ringkas(t)}\nDitugaskan ke: ${esc(tugas.nama)}\nOleh: ${esc(req.user.nama)}`, tombolTiket(t));
      if (tugas) kirimWa(t, [tugas], false); // WA hanya ke teknisi baru (pelanggan sudah diberi tahu saat tiket dibuat)
      res.json({ success: true, data: out(t) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // open -> taken (teknisi tidak boleh mengambil tiket yang ditugaskan ke teknisi lain)
  r.post('/:id/ambil', (req, res) => {
    const t0 = get(req.params.id);
    if (t0 && req.user.role === 'teknisi' && t0.ditugaskan_ke && t0.ditugaskan_ke !== req.user.id)
      return res.status(403).json({ success: false, message: 'Tiket ini ditugaskan ke teknisi lain' });
    const c = db.prepare(`UPDATE tiket SET status='taken', teknisi_id=?, teknisi_nama=?, updated_at=datetime('now') WHERE id=? AND status='open' AND (ditugaskan_ke IS NULL OR ditugaskan_ke=? OR ?)`)
      .run(req.user.id, req.user.nama, req.params.id, req.user.id, req.user.role === 'teknisi' ? 0 : 1);
    if (!c.changes) return res.status(409).json({ success: false, message: 'Tiket sudah diambil atau tidak ditemukan' });
    log(req.params.id, 'Tiket diambil', req.user);
    const t = get(req.params.id);
    kirimTelegram(`🙋 <b>TIKET DIAMBIL</b>\n${ringkas(t)}\nTeknisi: ${esc(req.user.nama)}`);
    res.json({ success: true, data: out(t) });
  });

  // taken -> progress. WAJIB melampirkan foto pekerjaan: body = biner gambar (Content-Type image/jpeg|png|webp)
  r.post('/:id/progress', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }), (req, res) => {
    const img = Buffer.isBuffer(req.body) && req.body.length ? jenisGambar(req.body) : null;
    if (!img) return res.status(400).json({ success: false, message: 'Foto pekerjaan wajib dilampirkan (JPG/PNG/WEBP)' });
    const t0 = get(req.params.id);
    if (!t0) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
    if (t0.status !== 'taken') return res.status(409).json({ success: false, message: 'Status tiket sudah berubah, muat ulang halaman' });
    if (t0.teknisi_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Hanya teknisi pemilik tiket (atau admin) yang dapat mengubah tiket ini' });
    const nama = `${t0.id}-${Date.now()}.${img.ext}`; // id dari DB (angka), bukan dari URL
    fs.writeFileSync(path.join(fotoDir, nama), req.body);
    const c = db.prepare(`UPDATE tiket SET status='progress', foto_progress=?, updated_at=datetime('now') WHERE id=? AND status='taken'`).run(nama, t0.id);
    if (!c.changes) { fs.unlink(path.join(fotoDir, nama), () => {}); return res.status(409).json({ success: false, message: 'Status tiket sudah berubah, muat ulang halaman' }); }
    log(t0.id, 'On progress', req.user, 'Foto pekerjaan dilampirkan');
    const t = get(t0.id);
    kirimTelegram(`🔧 <b>TIKET ON PROGRESS</b>\n${ringkas(t)}\nTeknisi: ${esc(t.teknisi_nama)}`, [], { buf: req.body, ...img });
    res.json({ success: true, data: out(t) });
  });

  // Foto pekerjaan (butuh login; teknisi hanya untuk tiket miliknya)
  r.get('/:id/foto', (req, res) => {
    const t = get(req.params.id);
    if (!t || !t.foto_progress) return res.status(404).json({ success: false, message: 'Foto tidak ada' });
    if (req.user.role === 'teknisi' && t.teknisi_id !== req.user.id) return res.status(403).json({ success: false, message: 'Tidak diizinkan' });
    res.sendFile(path.join(fotoDir, path.basename(t.foto_progress)), { headers: { 'Cache-Control': 'private, max-age=3600' } });
  });

  // progress -> closed
  r.post('/:id/close', (req, res) => {
    const catatan = (req.body.catatan || '').trim();
    if (!catatan) return res.status(400).json({ success: false, message: 'Catatan penyelesaian wajib diisi' });
    const c = db.prepare(`UPDATE tiket SET status='closed', updated_at=datetime('now') WHERE id=? AND status='progress' AND (teknisi_id=? OR ?)`)
      .run(req.params.id, req.user.id, req.user.role === 'admin' ? 1 : 0);
    if (!c.changes) return res.status(409).json({ success: false, message: 'Tidak bisa menutup tiket ini' });
    log(req.params.id, 'Tiket ditutup', req.user, catatan);
    const t = get(req.params.id);
    kirimTelegram(`✅ <b>TIKET CLOSED</b>\n${ringkas(t)}\nTeknisi: ${esc(t.teknisi_nama)}\nCatatan: ${esc(catatan)}`);
    kirimWaSelesai(t, catatan);
    res.json({ success: true, data: out(t) });
  });

  r.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const besar = err.type === 'entity.too.large';
    res.status(besar ? 413 : (err.status || 500)).json({ success: false, message: besar ? 'Foto terlalu besar (maks 8 MB)' : (err.message || 'Terjadi kesalahan') });
  });

  return r;
};