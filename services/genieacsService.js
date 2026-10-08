// services/genieacsService.js
// Wrapper GenieACS NBI REST API. Taruh file ini di folder yang sama level
// dengan server.js (../services/genieacsService.js relatif dari server.js
// berarti buat folder "services" di root project, sejajar dengan server.js).

const NBI_URL = process.env.GENIEACS_NBI_URL || 'http://192.168.11.21:7557';
const NBI_USER = process.env.GENIEACS_USERNAME || '';
const NBI_PASS = process.env.GENIEACS_PASSWORD || '';
const OFFLINE_MINUTES = parseInt(process.env.GENIEACS_OFFLINE_MINUTES || '15', 10);

function authHeader() {
  if (!NBI_USER) return {};
  const token = Buffer.from(`${NBI_USER}:${NBI_PASS}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

async function request(path, options = {}) {
  const res = await fetch(`${NBI_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeader(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GenieACS NBI error ${res.status}: ${body || res.statusText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function listDevices(query) {
  let path = '/devices';
  if (query) path += `?query=${encodeURIComponent(JSON.stringify(query))}`;
  return request(path);
}

async function getDeviceById(id) {
  const result = await listDevices({ _id: id });
  return result && result[0] ? result[0] : null;
}

/**
 * Cari device di GenieACS berdasarkan keyword bebas: serial number, device id,
 * atau username PPPoE. Serial number pakai field _deviceId._SerialNumber yang
 * selalu ada di semua device apapun mereknya. Username PPPoE path-nya beda
 * tiap vendor ONT — di bawah sudah dicoba beberapa path umum, tambahkan path
 * lain di sini kalau ONT Anda pakai path berbeda.
 */
async function searchDevices(keyword) {
  const q = keyword.trim();
  if (!q) return [];
  const result = await listDevices({
    $or: [
      { _id: { $regex: q, $options: 'i' } },
      { '_deviceId._SerialNumber': { $regex: q, $options: 'i' } },
      { 'VirtualParameters.pppoeUsername._value': { $regex: q, $options: 'i' } },
      {
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username._value':
          { $regex: q, $options: 'i' },
      },
    ],
  });
  return (result || []).slice(0, 20).map(summarizeDevice);
}

async function reboot(deviceId) {
  return request(`/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`, {
    method: 'POST',
    body: JSON.stringify({ name: 'reboot' }),
  });
}

async function refreshObject(deviceId, objectName) {
  return request(`/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`, {
    method: 'POST',
    body: JSON.stringify({ name: 'refreshObject', objectName }),
  });
}

// Sesuaikan path ini kalau ONT Anda beda merk (cek di GenieACS UI > Devices > parameter tree)
// Dipertahankan sebagai fallback kalau band tidak dikenali / device tidak bisa dibaca ulang.
const WIFI_SSID_PATH = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID';
const WIFI_PASSWORD_PATH = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase';

// Daftar node parent yang dicek untuk menemukan SEMUA instance WLAN yang ada
// di device (SSID 1, SSID 2, SSID 3, dst — jumlahnya beda-beda tiap ONT,
// jadi tidak di-hardcode ke index tertentu). "ap" dipakai khusus skema TR-181
// (Device.WiFi.*) karena password ada di node AccessPoint, bukan di node SSID.
const WLAN_PARENT_CANDIDATES = [
  { parent: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration', apParent: null },
  { parent: 'Device.WiFi.SSID', apParent: 'Device.WiFi.AccessPoint' },
];

/**
 * Temukan semua instance WLAN yang benar-benar ada di device (dibaca langsung
 * dari struktur data GenieACS, bukan tebakan index tetap). Label diberi nama
 * sesuai nomor instance apa adanya ("SSID 1", "SSID 2", ...) karena mapping
 * ke band 2.4GHz/5GHz berbeda-beda tiap vendor ONT dan tidak selalu ada
 * parameter yang menyatakan band-nya secara eksplisit.
 */
function discoverWifiInstances(device) {
  const instances = [];
  for (const cand of WLAN_PARENT_CANDIDATES) {
    const node = getNode(device, cand.parent);
    if (!node || typeof node !== 'object') continue;
    const indices = Object.keys(node)
      .filter(k => !k.startsWith('_') && /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    for (const idx of indices) {
      const path = `${cand.parent}.${idx}`;
      if (getByPath(device, `${path}.SSID`) === undefined) continue;
      instances.push({
        path,
        ap: cand.apParent ? `${cand.apParent}.${idx}` : null,
        label: `SSID ${idx}`,
        instance: idx,
      });
    }
    if (instances.length) break; // skema yang ketemu duluan dipakai, tidak digabung dgn skema lain
  }
  return instances;
}

/**
 * Ganti SSID/password/security/enable WiFi pada instance tertentu (label
 * "SSID 1", "SSID 2", dst — sesuai yang ditampilkan di UI). Karena path
 * TR-069 berbeda-beda antar vendor ONT, fungsi ini membaca ulang device dari
 * GenieACS untuk menemukan instance WLAN yang cocok dengan label tersebut,
 * baru menulis ke situ. Kalau label tidak diberikan/tidak ketemu, fallback
 * ke path default lama (SSID 1 skema TR-098).
 */
async function setWifi(deviceId, { ssid, password, enable, security, band }) {
  let targetPath = null;
  let targetAp = null;

  if (band) {
    const device = await getDeviceById(deviceId);
    if (device) {
      const match = discoverWifiInstances(device).find(inst => inst.label === band);
      if (match) {
        targetPath = match.path;
        targetAp = match.ap || null;
      }
    }
  }

  const parameterValues = [];
  if (targetPath) {
    if (ssid) parameterValues.push([`${targetPath}.SSID`, ssid, 'xsd:string']);
    if (enable !== undefined) parameterValues.push([`${targetPath}.Enable`, !!enable, 'xsd:boolean']);
    if (security) {
      parameterValues.push([`${targetPath}.BeaconType`, security, 'xsd:string']);
      parameterValues.push([`${targetPath}.WPAAuthenticationMode`, security, 'xsd:string']);
    }
    if (password) {
      if (targetAp) {
        parameterValues.push([`${targetAp}.Security.KeyPassphrase`, password, 'xsd:string']);
      } else {
        parameterValues.push([`${targetPath}.KeyPassphrase`, password, 'xsd:string']);
        parameterValues.push([`${targetPath}.PreSharedKey.1.KeyPassphrase`, password, 'xsd:string']);
      }
    }
  } else {
    // Fallback: label tidak dikenali / device tidak terbaca, pakai path default (SSID 1)
    if (ssid) parameterValues.push([WIFI_SSID_PATH, ssid, 'xsd:string']);
    if (password) parameterValues.push([WIFI_PASSWORD_PATH, password, 'xsd:string']);
  }

  if (!parameterValues.length) throw new Error('Tidak ada perubahan untuk dikirim (ssid/password/security/enable kosong)');
  return request(`/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`, {
    method: 'POST',
    body: JSON.stringify({ name: 'setParameterValues', parameterValues }),
  });
}

const RX_POWER_CANDIDATES = [
  'VirtualParameters.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPowerdBm',
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CT-COM_WANPONInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CU_WANPONInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_TD-COM_WANPONInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_HW_WANPONInterfaceConfig.RXPower',
  'Device.Optical.Interface.1.RXPower',
];

// SSID kadang di WLANConfiguration index 5 (SSID 5GHz) atau path vendor lain.
const WIFI_SSID_CANDIDATES = [
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
  'Device.WiFi.SSID.1.SSID',
];

// Node Hosts (daftar client yang terhubung ke ONT), dicoba skema TR-098 lalu TR-181.
const HOSTS_NODE_CANDIDATES = [
  { path: 'InternetGatewayDevice.LANDevice.1.Hosts.Host', mac: 'MACAddress', ip: 'IPAddress', hostname: 'HostName', iface: 'InterfaceType' },
  { path: 'Device.Hosts.Host', mac: 'PhysAddress', ip: 'IPAddress', hostname: 'HostName', iface: 'InterfaceType' },
];

// GenieACS NBI mengembalikan parameter sebagai object BERTINGKAT sesuai hierarki
// TR-069 (bukan flat key "A.B.C"). Jadi harus ditelusuri per-segment path.
function getByPath(device, path) {
  const parts = path.split('.');
  let node = device;
  for (const part of parts) {
    if (node == null) return undefined;
    node = node[part];
  }
  if (node && node._value !== undefined && node._value !== '') return node._value;
  return undefined;
}

function getFirstMatch(device, candidates) {
  for (const p of candidates) {
    const value = getByPath(device, p);
    if (value !== undefined) return { path: p, value };
  }
  return null;
}

// Sama seperti getByPath tapi mengembalikan node mentah (bukan hanya ._value),
// dipakai untuk menelusuri object yang berisi banyak child (mis. daftar Host).
function getNode(device, path) {
  const parts = path.split('.');
  let node = device;
  for (const part of parts) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

// Ambil semua SSID + password + security dari SEMUA instance WLAN yang benar-benar
// ada di device (hasil discoverWifiInstances), bukan cuma sebagian yang ditebak.
function collectWifiList(device) {
  const list = [];
  for (const inst of discoverWifiInstances(device)) {
    const enabled = getByPath(device, `${inst.path}.Enable`);
    const security =
      getByPath(device, `${inst.path}.BeaconType`) ||
      getByPath(device, `${inst.path}.WPAAuthenticationMode`) ||
      (inst.ap && getByPath(device, `${inst.ap}.Security.ModeEnabled`));
    const password =
      getByPath(device, `${inst.path}.KeyPassphrase`) ||
      getByPath(device, `${inst.path}.PreSharedKey.1.KeyPassphrase`) ||
      (inst.ap && getByPath(device, `${inst.ap}.Security.KeyPassphrase`)) ||
      (inst.ap && getByPath(device, `${inst.ap}.Security.PreSharedKey`));
    list.push({ band: inst.label, ssid: getByPath(device, `${inst.path}.SSID`), password, security, enabled });
  }
  return list;
}

// Ambil daftar device (client) yang terhubung ke ONT dari node Hosts.
// Host yang punya field Active bernilai eksplisit false akan dilewati.
function collectConnectedDevices(device) {
  for (const cand of HOSTS_NODE_CANDIDATES) {
    const hostsNode = getNode(device, cand.path);
    if (!hostsNode || typeof hostsNode !== 'object') continue;
    const result = [];
    for (const key of Object.keys(hostsNode)) {
      if (key.startsWith('_')) continue;
      const host = hostsNode[key];
      if (!host || typeof host !== 'object') continue;
      const active = host.Active && host.Active._value;
      if (active === false) continue;
      const hostname = host[cand.hostname] && host[cand.hostname]._value;
      const ip = host[cand.ip] && host[cand.ip]._value;
      const mac = host[cand.mac] && host[cand.mac]._value;
      const ifaceRaw = host[cand.iface] && host[cand.iface]._value;
      if (!hostname && !ip && !mac) continue;
      const connectionType = ifaceRaw
        ? (/802\.11|wifi|wlan/i.test(ifaceRaw) ? 'WiFi' : 'Ethernet')
        : undefined;
      result.push({ hostname, ip, mac, connectionType });
    }
    if (result.length) return result;
  }
  return [];
}

function summarizeDevice(device) {
  if (!device) return null;
  const lastInform = device._lastInform ? new Date(device._lastInform) : null;
  const minutesSince = lastInform ? (Date.now() - lastInform.getTime()) / 60000 : Infinity;

  const rx = getFirstMatch(device, RX_POWER_CANDIDATES);
  const ssidMatch = getFirstMatch(device, WIFI_SSID_CANDIDATES);
  const wifiList = collectWifiList(device);
  const connectedDevices = collectConnectedDevices(device);
  // Ambil SSID pertama sebagai fallback field lama (dipakai tombol "Ganti WiFi"
  // & tampilan sebelum wifiList ada), diutamakan yang cocok dengan ssidMatch.
  const primaryWifi =
    wifiList.find(w => w.ssid === (ssidMatch && ssidMatch.value)) || wifiList[0];

  return {
    id: device._id,
    serialNumber: device._deviceId && device._deviceId._SerialNumber,
    manufacturer: device._deviceId && device._deviceId._Manufacturer,
    productClass: device._deviceId && device._deviceId._ProductClass,
    ssid: ssidMatch ? ssidMatch.value : (primaryWifi ? primaryWifi.ssid : undefined),
    password: primaryWifi ? primaryWifi.password : undefined,
    security: primaryWifi ? primaryWifi.security : undefined,
    lastInform,
    online: minutesSince <= OFFLINE_MINUTES,
    rxPowerDbm: rx ? rx.value : undefined,
    wifiList,
    connectedDevices,
  };
}

module.exports = { listDevices, getDeviceById, searchDevices, reboot, setWifi, refreshObject, summarizeDevice };