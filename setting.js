// =====================================================
//  setting.js  -  PENGATURAN BOT
//  Semua nilai bisa juga diisi lewat Environment Variable panel
//  (BOT_TOKEN, GH_TOKEN, GH_REPO, API_ID, API_HASH)
// =====================================================
module.exports = {
  // ---- Bot ----
  botToken: process.env.BOT_TOKEN || 'ISI_TOKEN_BOT_DARI_BOTFATHER',

  // ---- MTProto (WAJIB kalau mau terima ZIP > 20MB sampai 2GB) ----
  // Ambil di https://my.telegram.org -> API development tools
  apiId: Number(process.env.API_ID || 0),
  apiHash: process.env.API_HASH || '',

  // ---- Logo / foto ----
  // Ditampilkan saat user berhasil join channel + di menu + di channel log
  photoUrl: 'https://telegra.ph/file/ganti-dengan-url-foto-kamu.jpg',

  // ---- Channel wajib follow ----
  // Bot HARUS jadi admin di channel ini (untuk cek member & kirim notif)
  channel: {
    id: '@namachannelkamu',               // @username channel atau -100xxxxxxxxxx
    link: 'https://t.me/namachannelkamu', // link tombol "Follow Channel"
  },
  // Channel tujuan notifikasi user baru / register (boleh sama dengan channel di atas)
  logChannel: '@namachannelkamu',

  // ---- GitHub ----
  github: {
    token: process.env.GH_TOKEN || 'ISI_GITHUB_TOKEN',   // scope: repo + workflow
    repo: process.env.GH_REPO || 'username/nama-repo',   // repo yang berisi .github/workflows
    branch: 'main',
    flutterWorkflow: 'build.yml',
    webWorkflow: 'build-web.yml',
  },

  // ---- Batas & credit ----
  limits: {
    maxZipBytes: 2 * 1024 * 1024 * 1024, // 2GB
    freeCredit: 5,                       // credit awal / maksimal isi ulang member
    refillHours: 24,                     // credit habis -> balik setelah 24 jam
    buildTimeoutMin: 60,                 // build lebih dari ini dianggap stuck -> dibatalkan
    pollSec: 8,                          // interval cek status GitHub
    maxConcurrent: 3,                    // build bersamaan maksimal (sisanya antri)
    downloadIdleSec: 90,
    retryFree: true, // ulang build setelah gagal (atas izin user) gratis; false = potong credit lagi                 // download tanpa data selama ini = stuck
  },

  // ---- AI untuk fitur Copy Tampilan ----
  // provider 'gemini' = GRATIS (free tier, ada batas per menit/hari) -> key dari https://aistudio.google.com/apikey
  // provider 'anthropic' = berbayar -> key dari https://platform.claude.com/settings/keys
  ai: {
    provider: 'gemini',
    apiKey: process.env.AI_API_KEY || 'ISI_API_KEY_AI',
    model: 'gemini-3.7-flash', // cadangan jika error: 'gemini-3.5-flash-lite' atau 'gemini-2.5-flash'
    maxTokens: 16000,
    timeoutSec: 300,
    maxConcurrent: 2,        // proses AI bersamaan (free tier punya limit per menit)
    cost: 1,                 // credit per proses (member). Reseller & owner gratis
    maxDartBytes: 60 * 1024, // ukuran maksimal file .dart
    maxImageBytes: 5 * 1024 * 1024,
  },

  // ---- Fitur Fix Base/API (khusus role VIP) ----
  fix: {
    dailyLimit: 10,                    // maks proses per VIP per hari (owner tanpa batas) -> menjaga biaya AI
    maxZipBytes: 15 * 1024 * 1024,     // ukuran ZIP maksimal
    maxFiles: 2000,
    maxUnzippedBytes: 60 * 1024 * 1024,
    defaultVipDays: 30,                // masa aktif VIP bawaan (bisa diubah owner: /setvipdays)
  },

  // ---- Urutan versi Flutter yang dicoba OTOMATIS oleh workflow ----
  // Mulai dari paling baru; kalau gagal karena versi tidak cocok, lanjut ke versi berikutnya.
  // value kosong = stable terbaru. Boleh wildcard seperti '3.35.x'. Makin banyak = makin kebal error (tapi worst-case makin lama)
  flutterChain: [
    { label: 'terbaru', value: '' },
    { label: '3.38.x', value: '3.38.x' },
    { label: '3.35.x', value: '3.35.x' },
    { label: '3.32.x', value: '3.32.x' },
    { label: '3.29.x', value: '3.29.x' },
  ],

  // ---- Teks ----
  texts: {
    maintenance: 'MAAF BOT SEDANG DITUTUP OLEH OWNER DIKARENAKAN ADA SEDIKIT MASALAH',
  },
};
