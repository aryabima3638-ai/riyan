// Database JSON sederhana (tanpa dependency native, aman untuk panel)
const fs = require('fs');
const path = require('path');
const S = require('../setting');
const T = require('../telegram');
const { mkdirp } = require('./util');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'db.json');
mkdirp(DIR);

const data = {
  users: {}, history: [], maintenance: false, stats: { builds: 0, ok: 0, fail: 0 },
  servers: [], nextServerId: 1, seeded: false,
  prices: { credit: 'Hubungi owner', reseller: 'Hubungi owner' },
};
try {
  Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch {}
data.prices = { credit: 'Hubungi owner', reseller: 'Hubungi owner', vip: 'Hubungi owner', ...(data.prices || {}) };
if (!data.vipDays) data.vipDays = S.fix?.defaultVipDays || 30;
// server bawaan dari setting.js (sekali saja)
if (!data.seeded) {
  data.servers.push({ id: data.nextServerId++, repo: S.github.repo, label: 'Server 1', branch: S.github.branch, cost: 1, enabled: true });
  data.seeded = true;
}

let timer = null;
function flush() {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('[db] gagal simpan:', e.message); }
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 400);
}
process.on('exit', flush);

const isOwner = (id) => T.ownerIds.map(Number).includes(Number(id)) || data.users[id]?.role === 'owner';
function roleOf(id) {
  if (isOwner(id)) return 'owner';
  const u = data.users[id];
  if (!u) return 'member';
  if (u.role === 'vip' && (!u.vipUntil || u.vipUntil < Date.now())) { u.role = 'member'; u.vipUntil = null; save(); } // VIP kedaluwarsa
  return u.role || 'member';
}
const isUnlimited = (id) => ['owner', 'reseller'].includes(roleOf(id));

function ensure(from) {
  const id = String(from.id);
  let isNew = false;
  if (!data.users[id]) {
    data.users[id] = {
      id: Number(id), role: 'member', credits: S.limits.freeCredit, emptyAt: null,
      verified: false, banned: false, builds: 0, joinedAt: Date.now(),
    };
    isNew = true;
  }
  const u = data.users[id];
  u.name = [from.first_name, from.last_name].filter(Boolean).join(' ') || u.name || 'User';
  u.username = from.username || u.username || '';
  save();
  return { user: u, isNew };
}

// Stub untuk user yang ditambah credit/role sebelum pernah /start
function stub(id) {
  id = String(id);
  if (!data.users[id]) {
    data.users[id] = {
      id: Number(id), role: 'member', credits: 0, emptyAt: null, verified: false,
      banned: false, builds: 0, joinedAt: Date.now(), name: 'User', username: '',
    };
    save();
  }
  return data.users[id];
}

function refill(u) {
  if (u.credits <= 0 && u.emptyAt && Date.now() - u.emptyAt >= S.limits.refillHours * 3600e3) {
    u.credits = S.limits.freeCredit;
    u.emptyAt = null;
    save();
  }
}
const canBuild = (id, cost = 1) => {
  if (isUnlimited(id)) return true;
  const u = data.users[id];
  if (!u) return false;
  refill(u);
  return u.credits >= cost;
};
function charge(id, cost = 1) {
  if (isUnlimited(id)) return true;
  const u = data.users[id];
  refill(u);
  if (u.credits < cost) return false;
  u.credits -= cost;
  if (u.credits <= 0) u.emptyAt = Date.now();
  save();
  return true;
}
function refund(id, cost = 1) {
  if (isUnlimited(id)) return;
  const u = data.users[id];
  if (!u) return;
  u.credits += cost;
  u.emptyAt = null;
  save();
}
function addCredit(id, n) {
  const u = stub(id);
  u.credits += n;
  u.emptyAt = null;
  save();
  return u;
}
function setRole(id, role) {
  const u = stub(id);
  u.role = role;
  save();
  return u;
}
function addVip(id, days) {
  const u = stub(id);
  const base = u.role === 'vip' && u.vipUntil > Date.now() ? u.vipUntil : Date.now();
  u.role = 'vip';
  u.vipUntil = base + days * 86400e3;
  save();
  return u;
}
function delVip(id) {
  const u = data.users[id];
  if (!u || u.role !== 'vip') return false;
  u.role = 'member'; u.vipUntil = null; save();
  return true;
}
// batas harian fitur Fix (owner tanpa batas). Mengembalikan false kalau habis
function fixTake(id, limit) {
  if (isOwner(id)) return true;
  const u = stub(id);
  const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  if (u.fixDay !== day) { u.fixDay = day; u.fixCount = 0; }
  if (u.fixCount >= limit) return false;
  u.fixCount++; save();
  return true;
}
function fixGive(id) {
  const u = data.users[id];
  if (u && u.fixCount > 0) { u.fixCount--; save(); }
}

function addHistory(entry) {
  data.history.push(entry);
  if (data.history.length > 500) data.history.splice(0, data.history.length - 500);
  data.stats.builds++;
  if (entry.status === 'sukses') data.stats.ok++;
  else if (entry.status === 'gagal') data.stats.fail++;
  save();
}

const serverById = (id) => data.servers.find((x) => x.id === Number(id));
const enabledServers = () => data.servers.filter((x) => x.enabled);
function addServer(repo, label) {
  const sv = { id: data.nextServerId++, repo, label: label || `Server ${data.nextServerId - 1}`, branch: S.github.branch, cost: 1, enabled: true };
  data.servers.push(sv); save();
  return sv;
}
function delServer(id) {
  const i = data.servers.findIndex((x) => x.id === Number(id));
  if (i < 0) return false;
  data.servers.splice(i, 1); save();
  return true;
}

module.exports = {
  addVip, delVip, fixTake, fixGive, isUnlimited,
  serverById, enabledServers, addServer, delServer,
  data, save, isOwner, roleOf, ensure, stub, refill, canBuild, charge, refund,
  addCredit, setRole, addHistory,
};
