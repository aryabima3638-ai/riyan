# Flutter Build Bot (Panel)

Bot Telegram: kirim ZIP project Flutter -> dibuild di GitHub Actions -> APK dikirim balik. Jalan di panel (Node.js), tanpa VPS.

## File
- `index.js` menu utama bot
- `telegram.js` ID owner (+ username owner)
- `setting.js` token bot, apiId/apiHash, foto, channel, GitHub, limit
- `lib/` db, github, mtproto, builder
- Workflow `build.yml` & `build-web.yml` dibuat OTOMATIS oleh bot di repo GitHub (lib/setup.js)

## Setup
1. Buat repo GitHub (private boleh). Tidak perlu upload yml: bot membuat/menimpa otomatis saat start, lewat tombol Setup GitHub Otomatis, atau `/setupgithub`.
2. Repo > Settings > Actions: aktifkan Actions. Buat token (classic) scope `repo` + `workflow`.
3. Isi `setting.js`: botToken, github.token, github.repo, channel, logChannel, photoUrl.
4. Isi `telegram.js`: ID Telegram owner.
5. Jadikan bot **admin** di channel (untuk cek follow & kirim notif).
6. ZIP > 20MB sampai 2GB: isi `apiId` & `apiHash` dari https://my.telegram.org. Tanpa ini, ZIP maks 20MB (atau kirim link direct).
7. Panel: upload semua file, Startup command `npm install && node index.js` (atau `npm start`), Node 18+.
   Pastikan disk panel >= 2x ukuran ZIP terbesar.

## Role & command
| Role | Akses |
|---|---|
| member | semua fitur build, 5 credit gratis, habis -> reset 24 jam |
| reseller | build unlimited, `/addcredit` |
| owner | semuanya + `/addreseller` (`/address`), `/addowner`, `/delreseller`, `/maintenance on\|off`, `/ban`, `/unban`, `/broadcast`, `/stats` |

`/addcredit ID [jumlah]` (default 5).

## Server (multi repo) - owner
- `/addserver owner/repo [nama]` tambah server (bot otomatis memasang workflow di repo itu; token GitHub harus punya akses ke repo tsb)
- `/delserver ID`, `/setcost ID credit` (biaya credit per build di server itu, berlaku untuk member)
- `/setharga credit|reseller teks` mengatur daftar harga yang tampil di menu Credit
- Panel Owner > Kelola Server: nyalakan/matikan server
Setelah user kirim ZIP, user memilih server (kalau hanya 1 server aktif, langsung jalan).

 Owner = ID di `telegram.js` + yang ditambah lewat `/addowner`.

## Copy Tampilan (gambar -> Dart)
Menu 🎨 Copy Tampilan: user kirim file `.dart`, gambar UI, dan teks prompt; bot memakai Claude API untuk menulis ulang file Dart agar tampilannya sama dengan gambar.
Default memakai Gemini (free tier, gratis dengan batas pemakaian): isi `ai.apiKey` (key dari https://aistudio.google.com/apikey) atau env `AI_API_KEY`. Bisa ganti `ai.provider` ke `anthropic` (berbayar). Biaya credit diatur di `ai.cost`.

## 🛠 Fix Base/API (khusus VIP)
- Role **VIP** (bukan member/reseller; owner boleh). Harga & masa aktif diatur owner.
- User kirim ZIP project (Node.js / Python / PHP, tanpa pubspec.yaml) + opsional tempel log error → bot kirim `fixed_*.zip` + `FIX_REPORT.txt`.
- Bot TIDAK menjalankan kode user: hanya cek sintaks (`node --check`, `ast.parse`, `php -l`), cek require/import & dependensi, lalu AI memperbaiki. Bahasa lain (Go/Java/Ruby/TS) hanya via AI + log yang ditempel.
- Token/secret disamarkan sebelum dikirim ke AI. Batas harian: `fix.dailyLimit` di setting.js.
- Butuh API key AI (Gemini gratis) di `setting.js` / env `AI_API_KEY`. Server opsional: `python3`, `php` untuk lint.
- Command owner: `/addvip ID [hari]`, `/delvip ID`, `/setvipdays N`, `/setharga vip Rp30.000`.
