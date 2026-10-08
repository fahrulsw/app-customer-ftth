// Kirim notifikasi WhatsApp via Mekari Qontak (WhatsApp Outbound Direct).
// Auth: HMAC (Client ID + Client Secret dari Mekari Developer Center, scope qontak-chat:all).
// Tanpa dependensi tambahan: hanya modul bawaan Node (crypto, http, https).
//
// Pengaturan utama diisi admin lewat web (Tiket > tombol WhatsApp), disimpan di data/wa-settings.json
// (Client Secret dienkripsi AES-256-GCM). Variabel .env di bawah hanya CADANGAN kalau form belum diisi:
//   MEKARI_CLIENT_ID=...
//   MEKARI_CLIENT_SECRET=...
//   QONTAK_CHANNEL_ID=...            (channel_integration_id nomor WA Anda)
//   QONTAK_TPL_PELANGGAN_ID=...      (id template tiket untuk pelanggan)
//   QONTAK_TPL_TEKNISI_ID=...        (id template tiket untuk teknisi)
//   QONTAK_TPL_SELESAI_ID=...        (opsional: id template "tiket selesai" untuk pelanggan)
//   WA_ENABLED=true                  (false = nonaktifkan semua pengiriman)
//   MEKARI_BASE_URL=https://api.mekari.com/qontak/chat/v1   (opsional)
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ---------- penyimpanan pengaturan (diisi admin lewat web) ----------
const SETTINGS_FILE = process.env.WA_SETTINGS_FILE || path.join(__dirname, '..', 'data', 'wa-settings.json');
// Kunci enkripsi diturunkan dari WA_SECRET_KEY / JWT_SECRET. Kalau kunci berubah, Client Secret perlu diisi ulang di form.
const encKey = () => crypto.createHash('sha256').update(process.env.WA_SECRET_KEY || process.env.JWT_SECRET || 'merdeka-secret-key-2025').digest();
function enc(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const d = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.');
}
function dec(str) {
  try {
    const [iv, tag, d] = String(str).split('.').map(x => Buffer.from(x, 'base64'));
    const c = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    c.setAuthTag(tag);
    return Buffer.concat([c.update(d), c.final()]).toString('utf8');
  } catch (e) { return ''; }
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { return {}; }
}
// patch: { enabled, client_id, client_secret, channel_id, tpl_pelanggan, tpl_teknisi }; client_secret kosong = pertahankan yang lama
function saveSettings(patch) {
  const cur = readSettings();
  const next = { ...cur };
  for (const k of ['client_id', 'channel_id', 'tpl_pelanggan', 'tpl_teknisi', 'tpl_selesai']) {
    if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.client_secret) next.client_secret_enc = enc(String(patch.client_secret).trim());
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
}

// Prioritas: isian form admin, lalu .env
const cfg = () => {
  const s = readSettings(), e = process.env;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : String(e.WA_ENABLED || 'false').toLowerCase() === 'true',
    clientId: s.client_id || e.MEKARI_CLIENT_ID,
    clientSecret: (s.client_secret_enc ? dec(s.client_secret_enc) : '') || e.MEKARI_CLIENT_SECRET,
    channelId: s.channel_id || e.QONTAK_CHANNEL_ID,
    tplPelanggan: s.tpl_pelanggan || e.QONTAK_TPL_PELANGGAN_ID,
    tplTeknisi: s.tpl_teknisi || e.QONTAK_TPL_TEKNISI_ID,
    tplSelesai: s.tpl_selesai || e.QONTAK_TPL_SELESAI_ID,
    baseUrl: (e.MEKARI_BASE_URL || 'https://api.mekari.com/qontak/chat/v1').replace(/\/+$/, '')
  };
};

// Untuk ditampilkan di form (Client Secret tidak pernah dikirim balik, hanya penanda & 4 karakter terakhir)
function publicSettings() {
  const c = cfg();
  return {
    enabled: c.enabled,
    client_id: c.clientId || '',
    secret_set: !!c.clientSecret,
    secret_masked: c.clientSecret ? '••••••' + c.clientSecret.slice(-4) : '',
    channel_id: c.channelId || '',
    tpl_pelanggan: c.tplPelanggan || '',
    tpl_teknisi: c.tplTeknisi || '',
    tpl_selesai: c.tplSelesai || '', // opsional
    configured: !!(c.clientId && c.clientSecret && c.channelId && c.tplPelanggan && c.tplTeknisi)
  };
}

// ---------- util ----------

// 0812-3456-789 / +62 812... / 62812... -> 62812xxxxxxx. Return '' jika tidak valid.
function normalizeNumber(raw) {
  let n = String(raw || '').replace(/[^\d]/g, '');
  if (!n) return '';
  if (n.startsWith('0')) n = '62' + n.slice(1);
  else if (n.startsWith('8')) n = '62' + n;
  return /^62\d{8,13}$/.test(n) ? n : '';
}

// Meta menolak variabel template yang berisi newline/tab atau banyak spasi berurutan, dan variabel tidak boleh kosong.
function cleanVar(v, max = 300) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return (s || '-').slice(0, max);
}

// Header Authorization HMAC sesuai spesifikasi Mekari
function hmacHeaders(clientId, clientSecret, method, fullUrl) {
  const u = new URL(fullUrl);
  const date = new Date().toUTCString();
  const requestLine = `${method.toUpperCase()} ${u.pathname}${u.search} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', clientSecret)
    .update(`date: ${date}\n${requestLine}`).digest('base64');
  return {
    Date: date,
    Authorization: `hmac username="${clientId}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`
  };
}

function request(method, endpoint, body) {
  const c = cfg();
  if (!c.clientId || !c.clientSecret) return Promise.reject(new Error('Client ID / Client Secret belum diisi di pengaturan WhatsApp'));
  const fullUrl = c.baseUrl + endpoint;
  const u = new URL(fullUrl);
  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    ...hmacHeaders(c.clientId, c.clientSecret, method, fullUrl),
    'Content-Type': 'application/json',
    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
  };
  const client = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = client.request(u, { method, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data; try { data = JSON.parse(text); } catch (e) { data = text; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        const err = new Error(`Mekari HTTP ${res.statusCode}: ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 300)}`);
        err.status = res.statusCode; err.data = data;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout menghubungi Mekari')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assertConfigured(needTemplate) {
  const c = cfg();
  const miss = [];
  if (!c.clientId) miss.push('Client ID');
  if (!c.clientSecret) miss.push('Client Secret');
  if (!c.channelId) miss.push('Channel ID');
  if (needTemplate && !c[needTemplate]) miss.push(needTemplate === 'tplPelanggan' ? 'Template Pelanggan' : 'Template Teknisi');
  if (miss.length) throw new Error('Pengaturan WhatsApp belum lengkap: ' + miss.join(', '));
  return c;
}

// ---------- kirim 1 pesan template ----------

// vars: array string, urutan = {{1}}, {{2}}, ... di template
async function sendTemplate({ toNumber, toName, templateId, vars = [] }) {
  const c = assertConfigured();
  const to = normalizeNumber(toNumber);
  if (!to) throw new Error('Nomor WhatsApp tidak valid: ' + toNumber);
  return request('POST', '/broadcasts/whatsapp/direct', {
    to_name: cleanVar(toName, 100),
    to_number: to,
    message_template_id: templateId,
    channel_integration_id: c.channelId,
    language: { code: 'id' },
    parameters: {
      body: vars.map((v, i) => ({ key: String(i + 1), value: 'var' + (i + 1), value_text: cleanVar(v) }))
    }
  });
}

// ---------- notifikasi tiket ----------

function nomorTiket(t) {
  return t.nomor || t.no_tiket || t.kode || t.kode_tiket || (t.id ? String(t.id).slice(0, 8).toUpperCase() : '-');
}

// ---- Bentuk isian disamakan dengan pesan Telegram di tiket.js ----
const ucfirst = v => { const x = String(v || ''); return x.charAt(0).toUpperCase() + x.slice(1); };
// Telegram: "Nama: <nama> - <no pelanggan>"
const namaDanNo = t => String(t.pelanggan_nama || '-') + (t.pelanggan_no ? ' - ' + t.pelanggan_no : '');
// Pengganti tombol Telegram "Telp Pelanggan" (buka WhatsApp pelanggan)
function linkTelp(t) { const n = normalizeNumber(t.pelanggan_hp); return n ? `https://wa.me/${n}` : '-'; }
// Pengganti tombol Telegram "Cek Lokasi": koordinat dulu, kalau tidak ada pakai alamat
function linkLokasi(t) {
  if (t.lat && t.lng) return `https://www.google.com/maps?q=${t.lat},${t.lng}`;
  if (t.alamat) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.alamat)}`;
  return '-';
}

// Template teknisi (sama dengan pesan Telegram "TIKET - kategori - prioritas"), 10 variabel:
//   {{1}} kategori, {{2}} prioritas, {{3}} no tiket, {{4}} nama[ - no pelanggan], {{5}} alamat,
//   {{6}} ditugaskan ke, {{7}} detail/keluhan, {{8}} waktu (WIB), {{9}} link telp pelanggan, {{10}} link lokasi
// Template pelanggan (versi ramah pelanggan dari pesan yang sama; tanpa prioritas/penugasan), 6 variabel:
//   {{1}} kategori, {{2}} no tiket, {{3}} nama[ - no pelanggan], {{4}} alamat, {{5}} detail, {{6}} waktu (WIB)
// tiket.waktu = teks waktu WIB (diisi tiket.js). teknisiList: array user teknisi ({ nama, no_wa }).
// Tidak pernah melempar error; hasil per penerima dikembalikan supaya bisa disimpan/dilog.
// opts.force = true: abaikan saklar Aktif/Nonaktif (dipakai tombol tes admin)
async function notifyTiketBaru(tiket, teknisiList = [], opts = {}) {
  const c = cfg();
  if (!c.enabled && !opts.force) return { skipped: true, reason: 'Notifikasi WhatsApp sedang nonaktif' };
  const jobs = [];

  if (tiket.pelanggan_hp) {
    jobs.push({
      peran: 'pelanggan', nama: tiket.pelanggan_nama,
      run: () => { assertConfigured('tplPelanggan'); return sendTemplate({
        toNumber: tiket.pelanggan_hp, toName: tiket.pelanggan_nama, templateId: c.tplPelanggan,
        vars: [tiket.kategori, nomorTiket(tiket), namaDanNo(tiket), tiket.alamat, tiket.deskripsi, tiket.waktu]
      }); }
    });
  }
  for (const tk of teknisiList) {
    if (!tk || !tk.no_wa) continue;
    jobs.push({
      peran: 'teknisi', nama: tk.nama,
      run: () => { assertConfigured('tplTeknisi'); return sendTemplate({
        toNumber: tk.no_wa, toName: tk.nama, templateId: c.tplTeknisi,
        vars: [tiket.kategori, ucfirst(tiket.prioritas), nomorTiket(tiket), namaDanNo(tiket), tiket.alamat,
               tiket.ditugaskan_nama || 'Terbuka untuk semua teknisi', tiket.deskripsi, tiket.waktu,
               linkTelp(tiket), linkLokasi(tiket)]
      }); }
    });
  }

  const results = await Promise.all(jobs.map(async (j) => {
    try { await j.run(); return { peran: j.peran, nama: j.nama, ok: true }; }
    catch (e) {
      console.error(`[WA] gagal kirim ke ${j.peran} (${j.nama}):`, e.message);
      return { peran: j.peran, nama: j.nama, ok: false, error: e.message };
    }
  }));
  return { skipped: false, results };
}

// Template selesai (sama dengan pesan Telegram "TIKET CLOSED"), 5 variabel:
//   {{1}} no tiket, {{2}} kategori, {{3}} nama pelanggan, {{4}} teknisi, {{5}} catatan penyelesaian
// Opsional: kalau Template Selesai belum diisi, dilewati tanpa error. Bentuk hasil sama dengan notifyTiketBaru.
async function notifyTiketSelesai(tiket, catatan, opts = {}) {
  const c = cfg();
  if (!c.enabled && !opts.force) return { skipped: true, reason: 'Notifikasi WhatsApp sedang nonaktif' };
  if (!c.tplSelesai) return { skipped: true, reason: 'ID Template Selesai belum diisi di pengaturan WhatsApp' };
  if (!tiket.pelanggan_hp) return { skipped: true, reason: 'Pelanggan tidak punya nomor HP' };
  try {
    assertConfigured();
    await sendTemplate({ toNumber: tiket.pelanggan_hp, toName: tiket.pelanggan_nama, templateId: c.tplSelesai,
      vars: [nomorTiket(tiket), tiket.kategori, tiket.pelanggan_nama, tiket.teknisi_nama, catatan] });
    return { skipped: false, results: [{ peran: 'pelanggan', nama: tiket.pelanggan_nama, ok: true }] };
  } catch (e) {
    console.error(`[WA] gagal kirim tiket selesai ke pelanggan (${tiket.pelanggan_nama}):`, e.message);
    return { skipped: false, results: [{ peran: 'pelanggan', nama: tiket.pelanggan_nama, ok: false, error: e.message }] };
  }
}

// Untuk menemukan ID template & channel yang akan dimasukkan ke .env
const listTemplates = () => request('GET', '/templates/whatsapp');
const listChannels = () => request('GET', '/integrations');

module.exports = { publicSettings, saveSettings, normalizeNumber, sendTemplate, notifyTiketBaru, notifyTiketSelesai, listTemplates, listChannels, hmacHeaders };