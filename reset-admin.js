// Reset password pengguna (atau buat admin baru) langsung dari server.
// Taruh di folder yang sama dengan server.js, lalu jalankan:
//   node reset-admin.js                      -> daftar admin yang ada
//   node reset-admin.js admin PasswordBaru1  -> set password baru untuk user "admin"
//   node reset-admin.js budi PasswordBaru1   -> kalau user "budi" belum ada, dibuat sebagai admin
// Database dicadangkan dulu ke data/database.json.bak-<waktu>. Sebaiknya hentikan server saat menjalankan ini.
const path = require('path');
const fs = require('fs-extra');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'database.json');

(async () => {
  if (!await fs.pathExists(DATA_FILE)) { console.error('Database tidak ditemukan: ' + DATA_FILE); process.exit(1); }
  const db = await fs.readJson(DATA_FILE);
  const [username, password] = process.argv.slice(2);

  if (!username) {
    console.log('Admin yang ada:');
    db.users.filter(u => u.role === 'admin').forEach(u => console.log(`  - ${u.username} (${u.nama})${u.aktif ? '' : ' [NONAKTIF]'}`));
    console.log('\nPakai: node reset-admin.js <username> <password-baru, min. 6 karakter>');
    return;
  }
  if (!password || password.length < 6) { console.error('Password baru wajib diisi, minimal 6 karakter.'); process.exit(1); }

  await fs.copy(DATA_FILE, DATA_FILE + '.bak-' + Date.now());
  const hash = await bcrypt.hash(password, 10);
  const u = db.users.find(x => x.username === username);
  if (u) {
    u.password = hash; u.aktif = true; u.updated_at = new Date().toISOString();
    console.log(`Password "${username}" (role: ${u.role}) berhasil direset dan akun diaktifkan.`);
    if (u.role !== 'admin') console.log('Catatan: akun ini bukan admin. Untuk fitur admin, pakai akun dengan role admin.');
  } else {
    db.users.push({ id: uuidv4(), username, nama: username, password: hash, role: 'admin', aktif: true, created_at: new Date().toISOString() });
    console.log(`User "${username}" belum ada, dibuat baru sebagai admin.`);
  }
  await fs.writeJson(DATA_FILE, db, { spaces: 2 });
})().catch(e => { console.error('Gagal:', e.message); process.exit(1); });
