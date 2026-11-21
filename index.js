// =====================================================
//  index.js  -  MENU UTAMA BOT FLUTTER BUILD
// =====================================================
const { Telegraf, Markup } = require('telegraf');
const S = require('./setting');
const T = require('./telegram');
const db = require('./lib/db');
const mt = require('./lib/mtproto');
const builder = require('./lib/builder');
const setup = require('./lib/setup');
const uicopy = require('./lib/uicopy');
const fixer = require('./lib/fixer');
const { esc, sleep, fmtDur, fmtBytes } = require('./lib/util');

if (!S.botToken || S.botToken.startsWith('ISI_')) {
  console.error('❌ Isi botToken di setting.js (atau env BOT_TOKEN) dulu.');
  process.exit(1);
}

const bot = new Telegraf(S.botToken, { handlerTimeout: 60000 });
const btn = Markup.button;
const kb = (rows) => Markup.inlineKeyboard(rows);
const pending = new Map(); // uid -> { kind, mode, at }
const uiState = new Map(); // uid -> { dart, image, prompt, at, busy, msgId }
const fixState = new Map(); // uid -> { file, note, at, busy, msgId }
const memberCache = new Map(); // uid -> { ok, at }
const lastHit = new Map();
let photoId = null;

const BADGE = { owner: '👑 OWNER', reseller: '🏪 RESELLER', vip: '💎 VIP', member: '👤 MEMBER' };
const creditEmptyText = () =>
  `CREDIT ANDA SUDAH HABIS!!! SILAHKAN BELI CREDIT/TUNGGU 1 HARI LAGI UNTUK MENDAPATKAN CREDIT ANDA KEMBALI\nOWNER : ${T.ownerUsername}`;
const denyReseller = '⚠️ <b>WARNING!</b>\nHanya role di atas member yang bisa memakai command ini!';
const denyOwner = '⚠️ <b>WARNING!</b>\nHanya role <b>OWNER</b> yang bisa memakai command ini!';

// ---------------- helper tampilan ----------------
async function sendPhotoMsg(chatId, caption, extra = {}) {
  try {
    const m = await bot.telegram.sendPhoto(chatId, photoId || S.photoUrl, { caption, parse_mode: 'HTML', ...extra });
    if (m.photo) photoId = m.photo[m.photo.length - 1].file_id;
    return m;
  } catch {
    return bot.telegram.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
}

async function show(ctx, text, keyboard) {
  const extra = { parse_mode: 'HTML', ...keyboard };
  const msg = ctx.callbackQuery?.message;
  if (msg?.photo && text.length <= 1000) {
    try { await ctx.editMessageCaption(text, extra); return; } catch (e) {
      if (/not modified/i.test(e.description || e.message)) return;
    }
  } else if (msg && !msg.photo) {
    try { await ctx.editMessageText(text, { ...extra, disable_web_page_preview: true }); return; } catch (e) {
      if (/not modified/i.test(e.description || e.message)) return;
    }
  }
  if (text.length <= 1000) await sendPhotoMsg(ctx.chat.id, text, keyboard);
  else await ctx.reply(text, { ...extra, disable_web_page_preview: true });
}

async function logChannel(text) {
  try { await sendPhotoMsg(S.logChannel, text); } catch (e) { console.error('[log channel]', e.description || e.message); }
}

const who = (u) => `${esc(u.name)}${u.username ? ' (@' + esc(u.username) + ')' : ''} • <code>${u.id}</code>`;

async function isMember(uid) {
  const c = memberCache.get(uid);
  if (c && Date.now() - c.at < 60000) return c.ok;
  let ok = false;
  try {
    const m = await bot.telegram.getChatMember(S.channel.id, uid);
    ok = ['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member);
  } catch (e) {
    console.error('[cek member]', e.description || e.message, '-> pastikan bot admin di channel');
  }
  memberCache.set(uid, { ok, at: Date.now() });
  return ok;
}

// ---------------- menu ----------------
function mainKb(uid) {
  const role = db.roleOf(uid);
  const rows = [
    [btn.callback('🌐 Build Web', 'b:web'), btn.callback('📱 Build Flutter', 'b:flutter')],
    [btn.callback('👤 Profil', 'profile'), btn.callback('💳 Credit', 'credit')],
    [btn.callback('📜 Riwayat', 'history'), btn.callback('📊 Status Build', 'status')],
    [btn.callback('🎨 Copy Tampilan (Gambar → Dart)', 'ui')],
    [btn.callback('🛠 Fix Base/API (VIP)', 'fix')],
  ];
  if (role === 'reseller' || role === 'owner') rows.push([btn.callback('🏪 Panel Reseller', 'reseller')]);
  if (role === 'owner') rows.push([btn.callback('👑 Panel Owner', 'owner')]);
  rows.push([btn.callback('❓ Bantuan', 'help'), btn.url('📢 Channel', S.channel.link)]);
  return kb(rows);
}

const creditText = (u, role) => {
  if (db.isUnlimited(u.id)) return '♾ Unlimited';
  db.refill(u);
  if (u.credits > 0) return `${u.credits} credit`;
  const left = Math.max(0, u.emptyAt + S.limits.refillHours * 3600e3 - Date.now());
  return `0 (reset ${fmtDur(left)} lagi)`;
};

function mainText(u) {
  const role = db.roleOf(u.id);
  return `🤖 <b>FLUTTER BUILD BOT</b>\n━━━━━━━━━━━━━━\n👤 ${esc(u.name)}\n🆔 <code>${u.id}</code>\n🎖 Role: <b>${BADGE[role]}</b>\n💳 Credit: <b>${creditText(u, role)}</b>\n🛠 Bot: ${db.data.maintenance ? '🔴 Maintenance' : '🟢 Online'}\n━━━━━━━━━━━━━━\nPilih menu di bawah 👇`;
}

const showMain = (ctx) => show(ctx, mainText(db.data.users[ctx.from.id]), mainKb(ctx.from.id));

function joinScreen(ctx) {
  return show(ctx,
    `👋 Halo <b>${esc(ctx.from.first_name)}</b>!\n\n🤖 <b>FLUTTER BUILD BOT</b>\nBuild Flutter jadi APK langsung dari ZIP source (sampai 2GB).\n\n⚠️ Untuk memakai bot, kamu wajib:\n1️⃣ Follow channel dulu\n2️⃣ Tekan tombol <b>Verifikasi</b>`,
    kb([[btn.url('📢 Follow Channel', S.channel.link)], [btn.callback('✅ Verifikasi', 'verify')]]));
}

// ---------------- middleware ----------------
bot.catch((err, ctx) => console.error('[bot error]', ctx?.updateType, err.message));

bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return; // hanya chat pribadi
  const { user, isNew } = db.ensure(ctx.from);
  if (isNew) {
    logChannel(`🆕 <b>USER BARU /START</b>\n━━━━━━━━━━━━━━\n👤 ${who(user)}\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n👥 Total user: <b>${Object.keys(db.data.users).length}</b>`);
  }
  if (user.banned && !db.isOwner(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('🚫 Kamu diblokir.', { show_alert: true }).catch(() => {});
    return ctx.reply('🚫 Kamu diblokir dari bot ini.');
  }
  // anti spam
  const now = Date.now();
  if (now - (lastHit.get(ctx.from.id) || 0) < 500) {
    if (ctx.callbackQuery) ctx.answerCbQuery().catch(() => {});
    return;
  }
  lastHit.set(ctx.from.id, now);
  // maintenance (owner bebas)
  if (db.data.maintenance && !db.isOwner(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery(S.texts.maintenance, { show_alert: true }).catch(() => {});
    return ctx.reply(`🚧 <b>${esc(S.texts.maintenance)}</b>`, { parse_mode: 'HTML' });
  }
  // wajib follow channel
  const free = ctx.callbackQuery?.data === 'verify' || ctx.message?.text?.startsWith('/start');
  if (!free && !db.isOwner(ctx.from.id) && !(await isMember(ctx.from.id))) {
    if (ctx.callbackQuery) ctx.answerCbQuery('Follow channel dulu!', { show_alert: true }).catch(() => {});
    return joinScreen(ctx);
  }
  return next();
});

// ---------------- start & verifikasi ----------------
bot.start(async (ctx) => {
  pending.delete(ctx.from.id);
  const u = db.data.users[ctx.from.id];
  if (db.isOwner(ctx.from.id) || (u.verified && (await isMember(ctx.from.id)))) return showMain(ctx);
  return joinScreen(ctx);
});

bot.action('verify', async (ctx) => {
  memberCache.delete(ctx.from.id);
  if (!(await isMember(ctx.from.id))) {
    return ctx.answerCbQuery('❌ Kamu belum follow channel! Follow dulu lalu tekan Verifikasi.', { show_alert: true });
  }
  await ctx.answerCbQuery('✅ Verifikasi berhasil!');
  const u = db.data.users[ctx.from.id];
  const first = !u.verified;
  u.verified = true; db.save();
  if (first) {
    logChannel(`✅ <b>USER BARU TERVERIFIKASI</b>\n━━━━━━━━━━━━━━\n👤 ${who(u)}\n🎖 Role: ${BADGE[db.roleOf(u.id)]}\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n👥 Total user: <b>${Object.keys(db.data.users).length}</b>`);
  }
  // logo + menu muncul setelah berhasil join
  try { await ctx.deleteMessage(); } catch {}
  await sendPhotoMsg(ctx.chat.id, `🎉 <b>Verifikasi berhasil!</b>\nSelamat datang, ${esc(u.name)}.\n\n` + mainText(u), mainKb(u.id));
});

bot.action('menu', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); if (!uiState.get(ctx.from.id)?.busy) uiState.delete(ctx.from.id); if (!fixState.get(ctx.from.id)?.busy) fixState.delete(ctx.from.id); return showMain(ctx); });

// ---------------- menu build ----------------
const backBtn = [btn.callback('⬅️ Kembali', 'menu')];

function needCredit(ctx) {
  if (db.canBuild(ctx.from.id)) return false;
  show(ctx, `❌ <b>${esc(creditEmptyText())}</b>`, kb([backBtn]));
  return true;
}

function screenZip(ctx) {
  const p = pending.get(ctx.from.id);
  const big = mt.isReady() ? 'sampai 2GB' : 'maks 20MB (isi apiId/apiHash agar bisa 2GB)';
  return show(ctx,
    `📦 <b>${p.kind === 'web' ? 'BUILD WEB' : `BUILD FLUTTER ${p.mode.toUpperCase()}`}</b>\n\nKirim sekarang:\n• File <b>.ZIP</b> project Flutter (${big})\n• atau <b>link direct</b> ke ZIP (https://...)\n\n📌 ZIP harus berisi <code>pubspec.yaml</code>.\n💳 Biaya credit tergantung server.\n📨 <i>ZIP yang kamu kirim juga diteruskan ke owner bot.</i>`,
    kb([[btn.callback('❌ Batal', 'menu')]]));
}

function askZip(ctx, kind, mode) {
  if (!fixState.get(ctx.from.id)?.busy) fixState.delete(ctx.from.id);
  if (!uiState.get(ctx.from.id)?.busy) uiState.delete(ctx.from.id);
  pending.set(ctx.from.id, { kind, mode, at: Date.now() });
  return screenZip(ctx);
}

bot.action('b:web', async (ctx) => {
  await ctx.answerCbQuery();
  if (builder.getJob(ctx.from.id)) return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (needCredit(ctx)) return;
  return askZip(ctx, 'web', 'release');
});

bot.action('b:flutter', async (ctx) => {
  await ctx.answerCbQuery();
  if (builder.getJob(ctx.from.id)) return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (needCredit(ctx)) return;
  return show(ctx, '📱 <b>BUILD FLUTTER</b>\nPilih tipe build:\n\n🚀 <b>Release</b> - APK final, ukuran kecil\n🐞 <b>Debug</b> - APK debug, build lebih cepat',
    kb([[btn.callback('🚀 Build Release', 'bf:release'), btn.callback('🐞 Build Debug', 'bf:debug')], backBtn]));
});

bot.action(/^bf:(release|debug)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (needCredit(ctx)) return;
  return askZip(ctx, 'flutter', ctx.match[1]);
});

const serverLoad = (id) => builder.allJobs().filter((j) => j.server.id === id).length;

async function stage(ctx, src) {
  const p = pending.get(ctx.from.id);
  if (!p || Date.now() - p.at > 15 * 60e3) {
    pending.delete(ctx.from.id);
    return ctx.reply('⚠️ Pilih menu build dulu (Build Flutter / Build Web) baru kirim ZIP.');
  }
  const list = db.enabledServers();
  if (!list.length) { pending.delete(ctx.from.id); return ctx.reply('❌ Belum ada server aktif. Hubungi owner ' + T.ownerUsername); }
  p.src = src; p.at = Date.now();
  if (list.length === 1) return startOn(ctx, list[0]);
  const rows = list.map((sv) => [btn.callback(`🖥 ${sv.label} • ${serverLoad(sv.id) ? '🟡 ' + serverLoad(sv.id) + ' aktif' : '🟢 kosong'} • 💳${sv.cost}`, `sv:${sv.id}`)]);
  rows.push([btn.callback('❌ Batal', 'menu')]);
  return show(ctx, '🖥 <b>PILIH SERVER</b>\n━━━━━━━━━━━━━━\nZIP diterima ✅\nPilih server untuk build.\n💳 = credit yang dipakai per build.', kb(rows));
}

async function startOn(ctx, sv) {
  const p = pending.get(ctx.from.id);
  if (!p?.src) return;
  if (!db.canBuild(ctx.from.id, sv.cost)) {
    const u = db.data.users[ctx.from.id];
    pending.delete(ctx.from.id);
    return ctx.reply(u.credits > 0 ? `❌ Credit kurang. Server ini butuh ${sv.cost} credit (saldo ${u.credits}).\nOWNER : ${T.ownerUsername}` : `❌ ${creditEmptyText()}`);
  }
  pending.delete(ctx.from.id);
  const r = await builder.start(bot, { uid: ctx.from.id, chatId: ctx.chat.id, kind: p.kind, mode: p.mode, src: p.src, server: sv, name: [ctx.from.first_name, ctx.from.username ? '@' + ctx.from.username : ''].filter(Boolean).join(' ') });
  if (!r.ok && r.reason === 'credit') return ctx.reply(`❌ ${creditEmptyText()}`);
  if (!r.ok && r.reason === 'busy') return ctx.reply('⚠️ Kamu masih punya build yang berjalan.');
}


bot.action(/^rt:(\w+)$/, async (ctx) => {
  if (db.data.maintenance && !db.isOwner(ctx.from.id)) return ctx.answerCbQuery(S.texts.maintenance, { show_alert: true });
  const r = await builder.acceptRetry(bot, ctx.from.id, ctx.chat.id, ctx.match[1]);
  if (!r.ok && r.reason === 'busy') return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (!r.ok && r.reason === 'credit') return ctx.answerCbQuery('Credit tidak cukup.', { show_alert: true });
  if (!r.ok) return ctx.answerCbQuery('Tawaran ulang sudah kedaluwarsa. Kirim ZIP lagi.', { show_alert: true });
  await ctx.answerCbQuery('Build diulang...');
  try { await ctx.deleteMessage(); } catch {}
});
bot.action(/^rtn:(\w+)$/, async (ctx) => {
  builder.declineRetry(ctx.match[1]);
  await ctx.answerCbQuery('Oke, tidak diulang.');
  try { await ctx.deleteMessage(); } catch {}
});

bot.action(/^sv:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sv = db.serverById(ctx.match[1]);
  if (!sv || !sv.enabled) return ctx.answerCbQuery('Server tidak tersedia.', { show_alert: true });
  if (!pending.get(ctx.from.id)?.src) return ctx.answerCbQuery('Sesi habis, kirim ZIP lagi.', { show_alert: true });
  try { await ctx.deleteMessage(); } catch {}
  return startOn(ctx, sv);
});

// ---------------- Copy Tampilan (gambar -> Dart) ----------------
const AI_OK = () => S.ai && S.ai.apiKey && !S.ai.apiKey.startsWith('ISI_');

async function fetchBuf(fileId, max) {
  const link = await bot.telegram.getFileLink(fileId);
  const res = await fetch(link.href, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error('terlalu besar');
  return buf;
}

function uiText(u) {
  const cost = !db.isUnlimited(u.uid) ? `${S.ai.cost} credit` : 'gratis';
  return `🎨 <b>COPY TAMPILAN</b>\n━━━━━━━━━━━━━━\n1️⃣ File Dart: ${u.dart ? '✅ ' + esc(u.dart.name) : '⬜ belum'}\n2️⃣ Gambar UI: ${u.image ? '✅ diterima' : '⬜ belum'}\n3️⃣ Prompt: ${u.prompt ? '✅ ' + esc(u.prompt.slice(0, 80)) : '⬜ (opsional, kirim teks)'}\n━━━━━━━━━━━━━━\nKirim <b>file .dart</b> (maks ${Math.round(S.ai.maxDartBytes / 1024)}KB), <b>gambar</b> tampilan yang mau ditiru (foto/PNG/JPG), dan <b>teks prompt</b>. Urutan bebas.\n💳 Biaya: ${cost}\n🔒 <i>File & gambar diproses oleh AI.</i>`;
}
const uiKb = (u) => kb([
  ...(u.dart && u.image ? [[btn.callback('🚀 Proses Sekarang', 'ui:go')]] : []),
  [btn.callback('🗑 Reset', 'ui:reset'), btn.callback('⬅️ Kembali', 'menu')],
]);

async function uiRefresh(ctx, u) {
  if (u.msgId) { try { await bot.telegram.deleteMessage(ctx.chat.id, u.msgId); } catch {} }
  const m = await ctx.reply(uiText(u), { parse_mode: 'HTML', ...uiKb(u) });
  u.msgId = m.message_id;
}

bot.action('ui', async (ctx) => {
  await ctx.answerCbQuery();
  if (!AI_OK()) return show(ctx, '🎨 <b>COPY TAMPILAN</b>\nFitur belum aktif: owner belum mengisi API key AI di setting.js.', kb([backBtn]));
  pending.delete(ctx.from.id);
  if (!fixState.get(ctx.from.id)?.busy) fixState.delete(ctx.from.id);
  const u = { uid: ctx.from.id, dart: null, image: null, prompt: '', at: Date.now(), busy: false, msgId: null };
  uiState.set(ctx.from.id, u);
  try { await ctx.deleteMessage(); } catch {}
  return uiRefresh(ctx, u);
});

bot.action('ui:reset', async (ctx) => {
  await ctx.answerCbQuery('Direset');
  const old = uiState.get(ctx.from.id);
  if (old?.busy) return ctx.answerCbQuery('Sedang diproses, tunggu selesai.', { show_alert: true });
  const u = { uid: ctx.from.id, dart: null, image: null, prompt: '', at: Date.now(), busy: false, msgId: old?.msgId };
  uiState.set(ctx.from.id, u);
  return uiRefresh(ctx, u);
});

bot.action('ui:go', async (ctx) => {
  const uid = ctx.from.id;
  const u = uiState.get(uid);
  if (!u || !u.dart || !u.image) return ctx.answerCbQuery('Kirim file .dart dan gambarnya dulu.', { show_alert: true });
  if (u.busy) return ctx.answerCbQuery('Sedang diproses...', { show_alert: true });
  const cost = S.ai.cost;
  if (!db.canBuild(uid, cost) || !db.charge(uid, cost)) {
    await ctx.answerCbQuery();
    return ctx.reply(`❌ ${creditEmptyText()}`);
  }
  await ctx.answerCbQuery('Memproses...');
  u.busy = true;
  const wait = await ctx.reply('⏳ <b>AI sedang menyalin tampilan ke Dart...</b>\nBiasanya 30–120 detik.', { parse_mode: 'HTML' });
  (async () => {
    try {
      const r = await uicopy.generate({ name: u.dart.name, dart: u.dart.text, image: u.image, prompt: u.prompt });
      const base = u.dart.name.replace(/\.dart$/i, '');
      await bot.telegram.sendDocument(ctx.chat.id, { source: Buffer.from(r.code, 'utf8'), filename: `${base}_copy.dart` }, {
        caption: `✅ <b>Tampilan disalin ke Dart</b>\n${esc((r.notes || '').slice(0, 800))}\n\n⚠️ Cek dulu sebelum dipakai; AI bisa meleset di detail.`.slice(0, 1000),
        parse_mode: 'HTML',
      });
      uiState.delete(uid);
    } catch (e) {
      db.refund(uid, cost);
      u.busy = false;
      await bot.telegram.sendMessage(ctx.chat.id, `❌ <b>Gagal</b>\n${esc(e.message).slice(0, 500)}\n💳 Credit dikembalikan.`, { parse_mode: 'HTML' }).catch(() => {});
    } finally {
      u.busy = false;
      bot.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    }
  })();
});

// return true kalau pesan ini ditangani fitur Copy Tampilan
async function uiAccept(ctx, kind) {
  const u = uiState.get(ctx.from.id);
  if (!u) return false;
  if (!u.busy && Date.now() - u.at > 30 * 60e3) { uiState.delete(ctx.from.id); return false; }
  if (u.busy) { await ctx.reply('⏳ Masih diproses, tunggu selesai.'); return true; }
  u.at = Date.now();
  try {
    if (kind === 'text') {
      u.prompt = ctx.message.text.trim().slice(0, 1500);
    } else if (kind === 'photo') {
      const ph = ctx.message.photo[ctx.message.photo.length - 1];
      const buf = await fetchBuf(ph.file_id, S.ai.maxImageBytes);
      u.image = { b64: buf.toString('base64'), mime: 'image/jpeg' };
    } else {
      const d = ctx.message.document;
      if (/\.dart$/i.test(d.file_name || '')) {
        if (d.file_size > S.ai.maxDartBytes) { await ctx.reply(`❌ File Dart ${fmtBytes(d.file_size)} terlalu besar (maks ${Math.round(S.ai.maxDartBytes / 1024)}KB). Pakai satu file layar saja.`); return true; }
        const buf = await fetchBuf(d.file_id, S.ai.maxDartBytes);
        u.dart = { name: d.file_name, text: buf.toString('utf8') };
      } else if (/^image\/(png|jpeg|webp|gif)$/i.test(d.mime_type || '')) {
        const buf = await fetchBuf(d.file_id, S.ai.maxImageBytes);
        u.image = { b64: buf.toString('base64'), mime: d.mime_type.toLowerCase() };
      } else {
        return false; // bukan .dart / gambar -> biarkan handler ZIP
      }
    }
  } catch (e) {
    await ctx.reply(`❌ Gagal membaca file/gambar (${e.message}). Maks gambar ${fmtBytes(S.ai.maxImageBytes)}.`);
    return true;
  }
  await uiRefresh(ctx, u);
  return true;
}

bot.on('photo', async (ctx) => {
  if (!(await uiAccept(ctx, 'photo'))) return ctx.reply('⚠️ Buka menu 🎨 Copy Tampilan dulu untuk mengirim gambar.');
});

// ---------------- Fix Base/API (khusus VIP) ----------------
const canFix = (id) => ['vip', 'owner'].includes(db.roleOf(id));
const FIX_FILE = /\.(zip|js|cjs|mjs|py|php)$/i;

function fixText(u) {
  const role = db.roleOf(u.uid);
  const left = role === 'owner' ? '♾' : `${Math.max(0, S.fix.dailyLimit - (db.data.users[u.uid]?.fixDay === new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10) ? db.data.users[u.uid].fixCount || 0 : 0))}/${S.fix.dailyLimit}`;
  return `🛠 <b>FIX BASE / API</b>\n━━━━━━━━━━━━━━\n1️⃣ File: ${u.file ? '✅ ' + esc(u.file.name) + ' (' + fmtBytes(u.file.buf.length) + ')' : '⬜ kirim <b>ZIP project</b> (atau 1 file .js/.py/.php)'}\n2️⃣ Log error: ${u.note ? '✅ ' + u.note.length + ' karakter' : '⬜ (opsional) tempel teks error/log di chat'}\n━━━━━━━━━━━━━━\n✔ Node.js • Python • PHP (base bot WA/Telegram/Discord, REST API, dll)\n✔ Project tanpa pubspec.yaml (bukan Flutter) cocoknya di sini\n🎟 Sisa hari ini: <b>${left}</b>${role === 'vip' ? ` • 💎 VIP s/d ${new Date(db.data.users[u.uid].vipUntil).toLocaleDateString('id-ID')}` : ''}\n🔒 <i>Token umum disamarkan sebelum dikirim ke AI. Kode tidak pernah dijalankan oleh bot.</i>`;
}
const fixKb = (u) => kb([
  ...(u.file ? [[btn.callback('🚀 Proses Sekarang', 'fix:go')]] : []),
  [btn.callback('🗑 Reset', 'fix:reset'), btn.callback('⬅️ Kembali', 'menu')],
]);
async function fixRefresh(ctx, u) {
  if (u.msgId) { try { await bot.telegram.deleteMessage(ctx.chat.id, u.msgId); } catch {} }
  const m = await ctx.reply(fixText(u), { parse_mode: 'HTML', ...fixKb(u) });
  u.msgId = m.message_id;
}

bot.action('fix', async (ctx) => {
  await ctx.answerCbQuery();
  if (!canFix(ctx.from.id)) {
    return show(ctx, `🔒 <b>FIX BASE / API</b>\nFitur ini <b>khusus role VIP</b> (member & reseller tidak bisa).\n\nPerbaiki error project Node.js / Python / PHP otomatis: kirim ZIP-nya, bot cari error lalu kirim ZIP hasil perbaikan.\n\n💎 Harga VIP: <b>${esc(db.data.prices.vip)}</b> / ${db.data.vipDays} hari\nBeli: ${T.ownerUsername}`, kb([backBtn]));
  }
  if (!AI_OK()) return show(ctx, '🛠 <b>FIX BASE / API</b>\nFitur belum aktif: owner belum mengisi API key AI di setting.js.', kb([backBtn]));
  pending.delete(ctx.from.id);
  if (!uiState.get(ctx.from.id)?.busy) uiState.delete(ctx.from.id);
  const u = { uid: ctx.from.id, file: null, note: '', at: Date.now(), busy: false, msgId: null };
  fixState.set(ctx.from.id, u);
  try { await ctx.deleteMessage(); } catch {}
  return fixRefresh(ctx, u);
});

bot.action('fix:reset', async (ctx) => {
  await ctx.answerCbQuery('Direset');
  const old = fixState.get(ctx.from.id);
  if (old?.busy) return ctx.answerCbQuery('Sedang diproses, tunggu selesai.', { show_alert: true });
  const u = { uid: ctx.from.id, file: null, note: '', at: Date.now(), busy: false, msgId: old?.msgId };
  fixState.set(ctx.from.id, u);
  return fixRefresh(ctx, u);
});

bot.action('fix:go', async (ctx) => {
  const uid = ctx.from.id;
  const u = fixState.get(uid);
  if (!canFix(uid)) return ctx.answerCbQuery('Masa VIP kamu sudah habis.', { show_alert: true });
  if (!u || !u.file) return ctx.answerCbQuery('Kirim ZIP/file project dulu.', { show_alert: true });
  if (u.busy) return ctx.answerCbQuery('Sedang diproses...', { show_alert: true });
  if (!db.fixTake(uid, S.fix.dailyLimit)) return ctx.answerCbQuery(`Batas harian ${S.fix.dailyLimit}x tercapai. Coba lagi besok.`, { show_alert: true });
  await ctx.answerCbQuery('Memproses...');
  u.busy = true;
  const wait = await ctx.reply('⏳ <b>Memperbaiki project...</b>', { parse_mode: 'HTML' });
  let lastEdit = 0;
  const onStep = (t) => {
    if (Date.now() - lastEdit < 1500) return;
    lastEdit = Date.now();
    bot.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `⏳ <b>Memperbaiki project...</b>\n${esc(t)}`, { parse_mode: 'HTML' }).catch(() => {});
  };
  (async () => {
    try {
      const r = await fixer.run({ name: u.file.name, buf: u.file.buf, note: u.note, onStep });
      if (!r.ok) {
        db.fixGive(uid);
        await bot.telegram.sendMessage(ctx.chat.id, `ℹ️ <b>Belum ada yang bisa diperbaiki</b>\n<pre>${esc(r.msg).slice(0, 3000)}</pre>\nKamu bisa tempel log error di chat lalu tekan 🚀 Proses lagi (jatah hari ini dikembalikan).`, { parse_mode: 'HTML' });
        return;
      }
      const base = u.file.name.replace(/\.[^.]+$/, '');
      await bot.telegram.sendDocument(ctx.chat.id, { source: r.zip, filename: `fixed_${base}.zip` }, {
        caption: `✅ <b>Selesai diperbaiki</b>\n${esc(r.report).slice(0, 850)}`.slice(0, 1000), parse_mode: 'HTML',
      });
      if (r.report.length > 850) await bot.telegram.sendMessage(ctx.chat.id, `<pre>${esc(r.report).slice(0, 3500)}</pre>`, { parse_mode: 'HTML' }).catch(() => {});
      fixState.delete(uid);
    } catch (e) {
      db.fixGive(uid);
      await bot.telegram.sendMessage(ctx.chat.id, `❌ <b>Gagal</b>\n${esc(e.message).slice(0, 500)}\n🎟 Jatah hari ini dikembalikan.`, { parse_mode: 'HTML' }).catch(() => {});
    } finally {
      u.busy = false;
      bot.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    }
  })();
});

// true kalau pesan ditangani fitur Fix
async function fixAccept(ctx, kind) {
  const u = fixState.get(ctx.from.id);
  if (!u) return false;
  if (!u.busy && Date.now() - u.at > 30 * 60e3) { fixState.delete(ctx.from.id); return false; }
  if (!canFix(ctx.from.id)) { fixState.delete(ctx.from.id); return false; }
  if (u.busy) { await ctx.reply('⏳ Masih diproses, tunggu selesai.'); return true; }
  u.at = Date.now();
  if (kind === 'text') {
    const t = ctx.message.text.trim();
    u.note = (u.note ? u.note + '\n' : '') + t;
    u.note = u.note.slice(0, 6000);
  } else {
    const d = ctx.message.document;
    if (!FIX_FILE.test(d.file_name || '')) return false; // bukan file project -> biarkan handler lain
    if (d.file_size > S.fix.maxZipBytes) { await ctx.reply(`❌ File ${fmtBytes(d.file_size)} terlalu besar (maks ${fmtBytes(S.fix.maxZipBytes)}). Hapus node_modules / folder besar dari ZIP.`); return true; }
    try {
      const buf = await fetchBuf(d.file_id, S.fix.maxZipBytes);
      u.file = { name: d.file_name, buf };
    } catch (e) {
      await ctx.reply(`❌ Gagal membaca file (${e.message}).`);
      return true;
    }
  }
  await fixRefresh(ctx, u);
  return true;
}

async function onZipDocument(ctx) {
  const d = ctx.message.document;
  if (!pending.get(ctx.from.id)) return ctx.reply('⚠️ Pilih menu build dulu (Build Flutter / Build Web) baru kirim ZIP.');
  if (!/\.zip$/i.test(d.file_name || '') && !/zip/i.test(d.mime_type || '')) return ctx.reply('❌ File harus berformat <b>.zip</b>', { parse_mode: 'HTML' });
  if (d.file_size > S.limits.maxZipBytes) return ctx.reply(`❌ File terlalu besar (${fmtBytes(d.file_size)}). Maksimal ${fmtBytes(S.limits.maxZipBytes)}.`);
  if (d.file_size > 20 * 1024 * 1024 && !mt.isReady()) {
    return ctx.reply(`❌ ZIP ${fmtBytes(d.file_size)} > 20MB. Owner belum mengaktifkan MTProto (apiId/apiHash).\nSolusi: kirim <b>link direct</b> ZIP kamu.`, { parse_mode: 'HTML' });
  }
  return stage(ctx, { type: 'tg', fileId: d.file_id, size: d.file_size, msgId: ctx.message.message_id, name: d.file_name });
}
bot.on('document', async (ctx) => {
  if (uiState.has(ctx.from.id) && (await uiAccept(ctx, 'doc'))) return;
  if (fixState.has(ctx.from.id) && (await fixAccept(ctx, 'doc'))) return;
  return onZipDocument(ctx);
});

bot.on('text', async (ctx, next) => {
  if (uiState.has(ctx.from.id) && !pending.get(ctx.from.id) && (await uiAccept(ctx, 'text'))) return;
  if (fixState.has(ctx.from.id) && !pending.get(ctx.from.id) && (await fixAccept(ctx, 'text'))) return;
  const t = ctx.message.text.trim();
  if (pending.get(ctx.from.id) && /^https?:\/\/\S+$/i.test(t)) return stage(ctx, { type: 'url', url: t });
  return next();
});

bot.action(/^cancel:(\d+)$/, async (ctx) => {
  const uid = Number(ctx.match[1]);
  if (uid !== ctx.from.id && !db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Bukan build kamu.', { show_alert: true });
  const ok = builder.cancel(uid, 'user');
  return ctx.answerCbQuery(ok ? '🛑 Membatalkan build...' : 'Build sudah selesai.', { show_alert: !ok });
});

// ---------------- profil, credit, riwayat, status, bantuan ----------------
bot.action('profile', async (ctx) => {
  await ctx.answerCbQuery();
  const u = db.data.users[ctx.from.id];
  const role = db.roleOf(u.id);
  return show(ctx, `👤 <b>PROFIL</b>\n━━━━━━━━━━━━━━\nNama: ${esc(u.name)}\nID: <code>${u.id}</code>\nRole: <b>${BADGE[role]}</b>\nCredit: <b>${creditText(u, role)}</b>\n${role === 'vip' ? `💎 VIP sampai: <b>${new Date(u.vipUntil).toLocaleDateString('id-ID')}</b> (${Math.max(0, Math.ceil((u.vipUntil - Date.now()) / 86400e3))} hari lagi)\n` : ''}Total build: <b>${u.builds}</b>\nBergabung: ${new Date(u.joinedAt).toLocaleDateString('id-ID')}`, kb([backBtn]));
});

bot.action('credit', async (ctx) => {
  await ctx.answerCbQuery();
  const u = db.data.users[ctx.from.id];
  const role = db.roleOf(u.id);
  const info = !db.isUnlimited(u.id)
    ? `Member dapat <b>${S.limits.freeCredit} credit gratis</b>. Kalau habis, tunggu ${S.limits.refillHours} jam atau beli credit.\n`
    : 'Role kamu <b>unlimited build</b>.\n';
  return show(ctx, `💳 <b>CREDIT</b>\n━━━━━━━━━━━━━━\nSaldo: <b>${creditText(u, role)}</b>\n${info}\n\n💰 <b>Harga</b>\n• Credit: ${esc(db.data.prices.credit)}\n• Jadi reseller: ${esc(db.data.prices.reseller)}\n• VIP (fitur Fix Base/API): ${esc(db.data.prices.vip)} / ${db.data.vipDays} hari\n\nBeli: ${T.ownerUsername}`, kb([backBtn]));
});

bot.action('history', async (ctx) => {
  await ctx.answerCbQuery();
  const h = db.data.history.filter((x) => x.uid === ctx.from.id).slice(-8).reverse();
  const em = { sukses: '✅', gagal: '❌', error: '⚠️', maintenance: '🚧', dibatalkan: '🛑', stuck: '⌛' };
  const body = h.length
    ? h.map((x) => `${em[x.status] || '•'} ${x.kind === 'web' ? 'Web' : 'Flutter ' + x.mode} • ${x.status} • ${fmtDur(x.dur)}\n   ${new Date(x.at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`).join('\n')
    : 'Belum ada riwayat build.';
  return show(ctx, `📜 <b>RIWAYAT BUILD</b>\n━━━━━━━━━━━━━━\n${body}`, kb([backBtn]));
});

bot.action('status', async (ctx) => {
  await ctx.answerCbQuery();
  const j = builder.getJob(ctx.from.id);
  if (!j) return show(ctx, '📊 <b>STATUS BUILD</b>\nTidak ada build yang berjalan.', kb([backBtn]));
  return show(ctx, builder.render(j), kb([[btn.callback('❌ Batalkan', `cancel:${j.uid}`)], backBtn]));
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return show(ctx, `❓ <b>BANTUAN</b>\n━━━━━━━━━━━━━━\n🛠 Fix Base/API (VIP): kirim ZIP project Node.js/Python/PHP yang error, bot memperbaiki otomatis\n🎨 Copy Tampilan: kirim file .dart + gambar UI + prompt, AI menyalin tampilan ke Dart\n\n1. Pilih Build Flutter / Web\n2. Kirim ZIP project (atau link direct)\n3. Tunggu, hasil APK dikirim otomatis\n4. Kalau gagal, log error lengkap dikirim\n\n<b>Command</b>\n/start • menu utama\n/addcredit &lt;id&gt; [jumlah] • reseller/owner\n/addreseller &lt;id&gt; • owner\n/addowner &lt;id&gt; • owner\n\nOwner: ${T.ownerUsername}`, kb([backBtn]));
});

// ---------------- panel reseller & owner ----------------
bot.action('reseller', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isUnlimited(ctx.from.id)) return ctx.answerCbQuery('Khusus reseller/owner', { show_alert: true });
  return show(ctx, `🏪 <b>PANEL RESELLER</b>\n━━━━━━━━━━━━━━\nTambah credit user:\n<code>/addcredit ID_USER [jumlah]</code>\n\nContoh: <code>/addcredit 123456789 10</code>\n(jumlah kosong = ${S.limits.freeCredit})\n\n💰 Harga credit: ${esc(db.data.prices.credit)}\n💰 Harga reseller: ${esc(db.data.prices.reseller)}`, kb([backBtn]));
});

function ownerPanel() {
  const on = db.data.maintenance;
  return {
    text: `👑 <b>PANEL OWNER</b>\n━━━━━━━━━━━━━━\n🛠 Maintenance: <b>${on ? '🔴 ON' : '🟢 OFF'}</b>\n🔧 Build aktif: <b>${builder.allJobs().length}</b>\n\nCommand:\n/addcredit • /addreseller • /addowner\n/addserver • /delserver • /setcost • /setharga\n/addvip • /delvip • /setvipdays\n/buildyml • /setupgithub • /delreseller • /ban • /unban • /cekuser\n/broadcast • /maintenance on|off`,
    keyboard: kb([
      [btn.callback(on ? '🟢 Matikan Maintenance' : '🔴 Nyalakan Maintenance', 'mt:toggle')],
      [btn.callback('📊 Statistik', 'stats'), btn.callback('🔧 Build Aktif', 'active')],
      [btn.callback('🖥 Kelola Server', 'servers'), btn.callback('⚙️ Setup GitHub', 'setupgh')],
      [btn.callback('📄 Buat build.yml Baru', 'buildyml')],
      backBtn,
    ]),
  };
}

bot.action('owner', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const p = ownerPanel();
  return show(ctx, p.text, p.keyboard);
});

function setMaintenance(on) {
  db.data.maintenance = on; db.save();
  return on ? builder.abortAllForMaintenance() : 0;
}

bot.action('mt:toggle', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const n = setMaintenance(!db.data.maintenance);
  await ctx.answerCbQuery(db.data.maintenance ? `Maintenance ON, ${n} build dihentikan` : 'Maintenance OFF', { show_alert: true });
  const p = ownerPanel();
  return show(ctx, p.text, p.keyboard);
});

async function runSetup() {
  const out = [];
  for (const sv of db.data.servers) {
    try { out.push(`✅ ${sv.label} (${sv.repo})\n${await setup.ensure(sv)}`); }
    catch (e) { out.push(`❌ ${sv.label} (${sv.repo}): ${e.message.slice(0, 200)}`); }
  }
  return `⚙️ <b>Setup GitHub</b>\n<pre>${esc(out.join('\n\n') || 'Belum ada server')}</pre>`;
}
bot.action('setupgh', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery('Menyiapkan GitHub...');
  return show(ctx, await runSetup(), kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});
bot.command('setupgithub', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  return ctx.reply(await runSetup(), { parse_mode: 'HTML' });
});


// ---- Generator build.yml baru (owner) ----
async function sendYmls(ctx) {
  const bad = setup.selfCheck();
  if (bad.length) return ctx.reply(`❌ Template workflow bermasalah:\n<pre>${esc(bad.join('\n'))}</pre>`, { parse_mode: 'HTML' });
  for (const [name, y] of Object.entries(setup.files())) {
    await ctx.replyWithDocument({ source: Buffer.from(y), filename: name }, { caption: `📄 ${name} (terbaru, auto-detect versi Flutter + fallback)` });
  }
  return ctx.reply('✅ Build.yml baru dibuat & lolos pengecekan.\nPasang otomatis ke semua server (repo) sekarang?', kb([
    [btn.callback('⚙️ Pasang Otomatis ke Semua Server', 'setupgh2')],
    [btn.callback('⬅️ Panel Owner', 'owner')],
  ]));
}
bot.command('buildyml', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  return sendYmls(ctx);
});
bot.action('buildyml', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery('Membuat build.yml...');
  return sendYmls(ctx);
});
bot.action('setupgh2', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery('Memasang ke GitHub...');
  return ctx.reply(await runSetup(), { parse_mode: 'HTML' });
});

function serverPanel() {
  const rows = db.data.servers.map((sv) => `#${sv.id} <b>${esc(sv.label)}</b> ${sv.enabled ? '🟢' : '🔴'}\n   <code>${esc(sv.repo)}</code> • 💳${sv.cost} • aktif ${serverLoad(sv.id)}`);
  return {
    text: `🖥 <b>KELOLA SERVER</b>\n━━━━━━━━━━━━━━\n${rows.join('\n') || 'Belum ada server.'}\n\n<code>/addserver owner/repo [nama]</code>\n<code>/delserver ID</code>\n<code>/setcost ID credit</code>\n<code>/setharga credit|reseller teks</code>`,
    keyboard: kb([
      ...db.data.servers.map((sv) => [btn.callback(`${sv.enabled ? '🔴 Matikan' : '🟢 Nyalakan'} #${sv.id} ${sv.label}`, `svt:${sv.id}`)]),
      [btn.callback('⬅️ Panel Owner', 'owner')],
    ]),
  };
}
bot.action('servers', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return;
  const p = serverPanel();
  return show(ctx, p.text, p.keyboard);
});
bot.action(/^svt:(\d+)$/, async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const sv = db.serverById(ctx.match[1]);
  if (sv) { sv.enabled = !sv.enabled; db.save(); }
  await ctx.answerCbQuery(sv ? (sv.enabled ? 'Server aktif' : 'Server dimatikan') : 'Tidak ada');
  const p = serverPanel();
  return show(ctx, p.text, p.keyboard);
});

bot.command('addserver', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [repo, ...lab] = args(ctx);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return ctx.reply('Format: <code>/addserver owner/repo [nama server]</code>', { parse_mode: 'HTML' });
  if (db.data.servers.some((x) => x.repo.toLowerCase() === repo.toLowerCase())) return ctx.reply('❌ Repo itu sudah jadi server.');
  const m = await ctx.reply('⏳ Memeriksa repo & memasang workflow...');
  const sv = { id: 0, repo, label: lab.join(' ').slice(0, 24) || '', branch: S.github.branch };
  try {
    const rep = await setup.ensure(sv);
    const real = db.addServer(repo, sv.label);
    real.branch = sv.branch; db.save();
    return ctx.reply(`✅ Server <b>#${real.id} ${esc(real.label)}</b> ditambahkan.\n<pre>${esc(rep)}</pre>`, { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(`❌ Gagal: ${esc(e.message).slice(0, 400)}\nPastikan repo ada & token punya akses (repo + workflow).`, { parse_mode: 'HTML' });
  }
});

bot.command('delserver', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  const sv = db.serverById(id);
  if (!sv) return ctx.reply('Format: /delserver ID (lihat di Kelola Server)');
  if (serverLoad(sv.id)) return ctx.reply('❌ Masih ada build aktif di server itu.');
  db.delServer(sv.id);
  return ctx.reply(`✅ Server #${sv.id} ${sv.label} dihapus.`);
});

bot.command('setcost', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id, n] = args(ctx);
  const sv = db.serverById(id);
  const c = parseInt(n, 10);
  if (!sv || !Number.isInteger(c) || c < 1 || c > 1000) return ctx.reply('Format: /setcost ID_SERVER jumlah_credit (1-1000)');
  sv.cost = c; db.save();
  return ctx.reply(`✅ Biaya ${sv.label}: ${c} credit/build (berlaku untuk member).`);
});

bot.command('addvip', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id, d] = args(ctx);
  if (!validId(id)) return ctx.reply('Format: <code>/addvip ID_USER [hari]</code>\nContoh: <code>/addvip 123456789 30</code>', { parse_mode: 'HTML' });
  const r = db.roleOf(id);
  if (r === 'owner' || r === 'reseller') return ctx.reply(`❌ User itu sudah ${BADGE[r]}. VIP hanya untuk member.`);
  const days = d === undefined ? db.data.vipDays : parseInt(d, 10);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return ctx.reply('❌ Jumlah hari tidak valid (1 - 3650).');
  const u = db.addVip(id, days);
  const until = new Date(u.vipUntil).toLocaleDateString('id-ID');
  notify(id, `💎 Kamu sekarang <b>VIP</b> selama <b>${days} hari</b> (sampai ${until}).\nFitur 🛠 Fix Base/API sudah aktif. Ketik /start.`);
  return ctx.reply(`✅ <code>${id}</code> jadi 💎 VIP +${days} hari (sampai ${until}).`, { parse_mode: 'HTML' });
});

bot.command('delvip', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  if (!validId(id) || !db.delVip(id)) return ctx.reply('❌ ID bukan VIP aktif. Format: /delvip ID_USER');
  return ctx.reply(`✅ VIP <code>${id}</code> dicabut.`, { parse_mode: 'HTML' });
});

bot.command('setvipdays', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const n = parseInt(args(ctx)[0], 10);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return ctx.reply('Format: /setvipdays jumlah_hari (1-3650)');
  db.data.vipDays = n; db.save();
  return ctx.reply(`✅ Masa VIP bawaan: ${n} hari.`);
});

bot.command('setharga', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [k, ...rest] = args(ctx);
  const txt = rest.join(' ').trim().slice(0, 120);
  if (!['credit', 'reseller', 'vip'].includes(k) || !txt) return ctx.reply('Format:\n/setharga credit Rp2.000 / credit\n/setharga reseller Rp50.000\n/setharga vip Rp30.000\n(hari VIP: /setvipdays 30)');
  db.data.prices[k] = txt; db.save();
  return ctx.reply(`✅ Harga ${k}: ${txt}`);
});

bot.action('stats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return;
  const us = Object.values(db.data.users);
  const c = (r) => us.filter((u) => db.roleOf(u.id) === r).length;
  const s = db.data.stats;
  return show(ctx, `📊 <b>STATISTIK</b>\n━━━━━━━━━━━━━━\n👥 User: <b>${us.length}</b> (verified ${us.filter((u) => u.verified).length})\n👑 Owner ${c('owner')} • 🏪 Reseller ${c('reseller')} • 💎 VIP ${c('vip')} • 👤 Member ${c('member')}\n🏗 Total build: <b>${s.builds}</b>\n✅ Sukses ${s.ok} • ❌ Gagal ${s.fail}`, kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});

bot.action('active', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return;
  const js = builder.allJobs();
  const body = js.length
    ? js.map((j) => `• <code>${j.uid}</code> ${j.kind} ${j.mode} • ${esc(j.server.label)} • ${fmtDur(Date.now() - j.startedAt)} • ${esc(j.steps.find((s) => s.st === 'run')?.t || '...')}`).join('\n')
    : 'Tidak ada build aktif.';
  return show(ctx, `🔧 <b>BUILD AKTIF</b>\n━━━━━━━━━━━━━━\n${body}`, kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});

// ---------------- command ----------------
const args = (ctx) => ctx.message.text.trim().split(/\s+/).slice(1);
const validId = (s) => /^\d{5,15}$/.test(s || '');
const notify = (id, text) => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});

bot.command('addcredit', async (ctx) => {
  if (!db.isUnlimited(ctx.from.id)) return ctx.reply(denyReseller, { parse_mode: 'HTML' });
  const [id, n] = args(ctx);
  if (!validId(id)) return ctx.reply('Format: <code>/addcredit ID_USER [jumlah]</code>', { parse_mode: 'HTML' });
  const amount = n === undefined ? S.limits.freeCredit : parseInt(n, 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return ctx.reply('❌ Jumlah credit tidak valid (1 - 100000).');
  const u = db.addCredit(id, amount);
  notify(id, `💳 Kamu mendapat <b>+${amount} credit</b>!\nSaldo sekarang: <b>${u.credits}</b>`);
  return ctx.reply(`✅ Berhasil menambah <b>${amount} credit</b> ke <code>${id}</code>.\nSaldo: ${u.credits}`, { parse_mode: 'HTML' });
});

async function roleCmd(ctx, role) {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  if (!validId(id)) return ctx.reply(`Format: <code>${ctx.message.text.split(' ')[0]} ID_USER</code>`, { parse_mode: 'HTML' });
  if (role === 'reseller' && db.isOwner(id)) return ctx.reply('❌ User itu sudah OWNER.');
  db.setRole(id, role);
  notify(id, `🎉 Role kamu sekarang <b>${BADGE[role]}</b>!\nKetik /start untuk membuka menu.`);
  return ctx.reply(`✅ <code>${id}</code> sekarang <b>${BADGE[role]}</b>.`, { parse_mode: 'HTML' });
}
bot.command(['addreseller', 'address'], (ctx) => roleCmd(ctx, 'reseller'));
bot.command('addowner', (ctx) => roleCmd(ctx, 'owner'));

bot.command('delreseller', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  if (!validId(id) || db.data.users[id]?.role !== 'reseller') return ctx.reply('❌ ID bukan reseller. Format: /delreseller ID_USER');
  db.setRole(id, 'member');
  return ctx.reply(`✅ <code>${id}</code> dikembalikan jadi MEMBER.`, { parse_mode: 'HTML' });
});

bot.command('maintenance', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [a] = args(ctx);
  if (!['on', 'off'].includes((a || '').toLowerCase())) return ctx.reply('Format: /maintenance on|off');
  const on = a.toLowerCase() === 'on';
  const n = setMaintenance(on);
  return ctx.reply(on ? `🔴 Maintenance ON. ${n} build user dihentikan.` : '🟢 Maintenance OFF. Bot kembali normal.');
});

for (const [cmd, val] of [['ban', true], ['unban', false]]) {
  bot.command(cmd, async (ctx) => {
    if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
    const [id] = args(ctx);
    if (!validId(id) || db.isOwner(id)) return ctx.reply(`Format: /${cmd} ID_USER (owner tidak bisa di-ban)`);
    db.stub(id).banned = val; db.save();
    if (val) builder.cancel(id, 'user');
    return ctx.reply(`✅ <code>${id}</code> ${val ? 'diblokir' : 'dibuka blokirnya'}.`, { parse_mode: 'HTML' });
  });
}

bot.command('cekuser', async (ctx) => {
  if (!db.isUnlimited(ctx.from.id)) return ctx.reply(denyReseller, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  const u = db.data.users[id];
  if (!u) return ctx.reply('❌ User tidak ditemukan.');
  return ctx.reply(`👤 ${who(u)}\nRole: ${BADGE[db.roleOf(id)]}\nCredit: ${creditText(u, db.roleOf(id))}\nBuild: ${u.builds}\nVerified: ${u.verified ? 'ya' : 'belum'}\nBanned: ${u.banned ? 'ya' : 'tidak'}`, { parse_mode: 'HTML' });
});

bot.command('stats', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const s = db.data.stats;
  return ctx.reply(`👥 User: ${Object.keys(db.data.users).length}\n🏗 Build: ${s.builds} (✅ ${s.ok} / ❌ ${s.fail})\n🔧 Aktif: ${builder.allJobs().length}\n🛠 Maintenance: ${db.data.maintenance ? 'ON' : 'OFF'}`);
});

bot.command('broadcast', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const text = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/i, '').trim();
  if (!text) return ctx.reply('Format: /broadcast teks pesan');
  const ids = Object.values(db.data.users).filter((u) => u.verified).map((u) => u.id);
  await ctx.reply(`📢 Mengirim ke ${ids.length} user...`);
  (async () => {
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await bot.telegram.sendMessage(id, `📢 <b>PENGUMUMAN</b>\n\n${esc(text)}`, { parse_mode: 'HTML' }); ok++; } catch { fail++; }
      await sleep(60);
    }
    notify(ctx.from.id, `✅ Broadcast selesai. Terkirim ${ok}, gagal ${fail}.`);
  })();
});

// ---------------- jalankan ----------------
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => {
  await mt.init();
  const me = await bot.telegram.getMe();
  console.log(`✅ Bot @${me.username} berjalan | Owner: ${T.ownerIds.join(', ')}`);
  try {
    const m = await bot.telegram.getChatMember(S.channel.id, me.id);
    if (!['administrator', 'creator'].includes(m.status)) console.warn('⚠️ Bot BUKAN admin di channel! Jadikan admin agar verifikasi & notifikasi jalan.');
  } catch (e) {
    console.warn('⚠️ Channel tidak terbaca:', e.description || e.message, '-> cek setting.js channel.id & jadikan bot admin.');
  }
  for (const sv of db.data.servers) setup.ensure(sv).then((r) => console.log(`[setup ${sv.label}]\n` + r)).catch((e) => console.warn(`⚠️ Setup ${sv.label} gagal:`, e.message));
  bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error('Gagal launch:', e.message); process.exit(1); });
})();
