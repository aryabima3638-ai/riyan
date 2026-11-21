// Mesin build: download ZIP -> upload release GitHub -> jalankan workflow -> pantau -> kirim hasil / log error
const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');
const S = require('../setting');
const db = require('./db');
const gh = require('./github');
const mt = require('./mtproto');
const { esc, sleep, bar, fmtBytes, fmtDur, stripAnsi, mkdirp, rmf } = require('./util');

const TMP = path.join(__dirname, '..', 'data', 'tmp');
mkdirp(TMP);
// bersihkan sisa file tmp saat start
try { fs.readdirSync(TMP).forEach((f) => rmf(path.join(TMP, f))); } catch {}

const L = S.limits;
const jobs = new Map(); // uid -> job
let running = 0;

class Abort extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

const STEPS = [
  ['dl', 'Download ZIP'],
  ['up', 'Upload ke GitHub'],
  ['wf', 'Jalankan workflow'],
  ['build', 'Build di GitHub Actions'],
  ['send', 'Ambil & kirim hasil'],
];

const cancelKb = (uid) => Markup.inlineKeyboard([[Markup.button.callback('❌ Batalkan Build', `cancel:${uid}`)]]);

function render(job) {
  const icon = { wait: '⬜', run: '⏳', ok: '✅', fail: '❌' };
  const title = job.kind === 'web' ? '🌐 <b>BUILD WEB</b>' : `📱 <b>BUILD FLUTTER</b> (${job.mode.toUpperCase()})`;
  let t = `${title}\n🆔 <code>${job.tag}</code>\n━━━━━━━━━━━━━━\n`;
  for (const s of job.steps) {
    t += `${icon[s.st]} ${s.t}`;
    if (s.st === 'run' && s.pct != null) t += `\n    <code>${bar(s.pct)}</code> ${s.pct}%`;
    if (s.note) t += `\n    └ <i>${esc(s.note)}</i>`;
    t += '\n';
  }
  t += `━━━━━━━━━━━━━━\n🖥 ${esc(job.server.label)} • ⏱ ${fmtDur(Date.now() - job.startedAt)}`;
  return t;
}

function makeUpdater(bot, job) {
  let last = 0, lastText = '', busy = false;
  return async (force) => {
    if (busy) return;
    const now = Date.now();
    if (!force && now - last < 2500) return;
    const t = render(job);
    if (t === lastText) return;
    busy = true; last = now; lastText = t;
    try {
      await bot.telegram.editMessageText(job.chatId, job.msgId, undefined, t, {
        parse_mode: 'HTML', disable_web_page_preview: true, ...(job.final ? {} : cancelKb(job.uid)),
      });
    } catch {} finally { busy = false; }
  };
}

function setStep(job, key, st, extra = {}) {
  const s = job.steps.find((x) => x.k === key);
  Object.assign(s, { st, pct: null, note: '' }, extra);
}

function triggerAbort(job, reason) {
  if (!job.abort) job.abort = reason;
  try { job.controller.abort(); } catch {}
}

function check(job) {
  if (job.abort) throw new Abort(job.abort);
  if (db.data.maintenance && !db.isOwner(job.uid)) {
    triggerAbort(job, 'maintenance');
    throw new Abort('maintenance');
  }
}

// ---------------- download ----------------
async function httpDownload(url, dest, job, onProgress) {
  const res = await fetch(url, { signal: job.controller.signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Link download error HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (/text\/html/i.test(ct)) throw new Error('Link bukan file langsung (isinya halaman web). Pakai direct link ZIP.');
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > L.maxZipBytes) throw new Error(`File terlalu besar (${fmtBytes(total)}), maksimal ${fmtBytes(L.maxZipBytes)}`);
  const ws = fs.createWriteStream(dest);
  let got = 0;
  let idle = setTimeout(() => triggerAbort(job, 'idle'), L.downloadIdleSec * 1000);
  try {
    for await (const chunk of res.body) {
      clearTimeout(idle);
      idle = setTimeout(() => triggerAbort(job, 'idle'), L.downloadIdleSec * 1000);
      got += chunk.length;
      if (got > L.maxZipBytes) throw new Error(`File melebihi batas ${fmtBytes(L.maxZipBytes)}`);
      if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
      onProgress(got, total);
    }
  } finally {
    clearTimeout(idle);
    await new Promise((r) => ws.end(r));
  }
}

async function downloadSource(bot, job, dest, onProgress) {
  const src = job.src;
  if (src.type === 'url') return httpDownload(src.url, dest, job, onProgress);
  if (src.size <= 20 * 1024 * 1024) {
    const link = await bot.telegram.getFileLink(src.fileId);
    return httpDownload(link.href, dest, job, onProgress);
  }
  if (!mt.isReady()) throw new Error('ZIP > 20MB butuh MTProto (isi apiId & apiHash di setting.js) atau kirim lewat direct link.');
  let lastData = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastData > L.downloadIdleSec * 1000) triggerAbort(job, 'idle');
  }, 5000);
  try {
    await mt.download(job.uid, src.msgId, dest, (r, t) => { lastData = Date.now(); onProgress(r, t); }, () => !!job.abort);
  } finally { clearInterval(watchdog); }
}

// ---------------- analisa error ----------------
const HINTS = [
  [/lower than Flutter's minimum supported version/i, 'Gradle project lebih rendah dari syarat Flutter. Gradle/AGP project lebih rendah dari syarat Flutter. Workflow otomatis mencoba versi Flutter yang lebih lama; kalau semua gagal, naikkan Gradle/AGP di project.'],
  [/No named parameter|isn't defined for the class|The method '.*' isn't defined|Undefined (name|class)/i, 'Kode project memakai API yang tidak cocok dengan versi Flutter di workflow. Workflow memakai Flutter stable terbaru; kalau masih error, update/downgrade package atau perbaiki baris Dart yang tertera.'],
  [/What went wrong:\s*\n\s*\d+\.\d+(\.\d+)?\s*\n/i, 'Gradle tidak cocok dengan versi Java di runner. Workflow harus memakai Java 17 (jalankan Setup GitHub Otomatis untuk memperbarui).'],
  [/pubspec\.yaml (tidak|not) ditemukan|Could not find a file named "pubspec\.yaml"/i, 'ZIP tidak berisi pubspec.yaml. Zip folder project Flutter-nya (yang ada pubspec.yaml), bukan folder lain. Kalau ini project Node.js/Python/PHP (base bot / API), pakai menu 🛠 Fix Base/API (khusus VIP).'],
  [/version solving failed|requires SDK version|The current Dart SDK version/i, 'Versi Dart/Flutter project tidak cocok dengan Flutter 3.32.8 di workflow. Samakan `environment: sdk` di pubspec.yaml atau ubah flutter-version di file workflow.'],
  [/Namespace not specified|namespace/i, 'Plugin lama tanpa namespace (Android Gradle Plugin 8+). Update versi plugin di pubspec.yaml.'],
  [/minSdkVersion \d+ cannot be smaller|minSdk/i, 'minSdk project lebih rendah dari yang dibutuhkan plugin. Workflow otomatis menaikkan minSdk sesuai kebutuhan plugin dan mengulang build.'],
  [/Unsupported class file major version|invalid source release|Java version|JDK/i, 'Versi Java/Gradle tidak cocok. Update Gradle wrapper & Android Gradle Plugin project.'],
  [/Could not resolve|Could not GET|Could not download|Connection (timed out|reset)/i, 'Gagal download dependency (jaringan/repo). Coba build ulang.'],
  [/keystore|key\.properties|signing/i, 'Konfigurasi signing release bermasalah (keystore/key.properties). Coba Build DEBUG atau hapus config signing.'],
  [/No space left on device/i, 'Disk runner GitHub penuh. Kecilkan isi ZIP (hapus build/, .dart_tool/, node_modules).'],
  [/Out of memory|OutOfMemoryError|Java heap space/i, 'Memori Gradle kurang. Tambahkan org.gradle.jvmargs=-Xmx4g di android/gradle.properties.'],
  [/Error: .*\.dart|lib\/.*\.dart:\d+/i, 'Ada error di kode Dart. Perbaiki baris yang tertera di log, lalu build ulang.'],
];

function analyze(log) {
  const lines = stripAnsi(log).split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').trimEnd());
  const annotations = lines.filter((l) => l.includes('##[error]')).map((l) => l.replace('##[error]', '').trim());
  const re = /(error|exception|failed|failure|what went wrong|could not|cannot|unable to|not found|no such file|denied)/i;
  const hits = lines
    .filter((l) => l.trim() && re.test(l) && !l.startsWith('##[') && !l.includes('::') && !/^Cache not found/i.test(l))
    .map((l) => l.trim());
  // ambil blok detail setelah "What went wrong:" / "Execution failed" (Gradle)
  const blocks = [];
  lines.forEach((l, i) => {
    if (/what went wrong:|^FAILURE:|Execution failed for task|Error output from Gradle|\[!\]|^Error:/i.test(l)) {
      blocks.push(...lines.slice(i, i + 10).filter((x) => x.trim()));
    }
  });
  const key = [...new Set([...annotations, ...blocks.map((b) => b.trim()), ...hits])].slice(-45);
  const tail = lines.filter((l) => l.trim()).slice(-15);
  // saran hanya dicocokkan ke baris error (bukan seluruh log, karena skrip workflow ikut tercetak di log)
  const hintText = [...annotations, ...blocks, ...hits].join('\n');
  const hints = HINTS.filter(([r]) => r.test(hintText)).map(([, h]) => h).slice(0, 3);
  return { key, tail, hints, clean: lines.join('\n') };
}

// gagal karena infrastruktur (runner mati/dibatalkan) = tidak ada step yang gagal & tidak ada baris error
async function isInfraFail(job, run) {
  try {
    const out = await job.g.getJobs(run.id);
    if (!out.jobs.length) return true;
    for (const j of out.jobs) {
      if ((j.steps || []).some((s) => ['failure', 'timed_out'].includes(s.conclusion))) return false;
    }
    return true;
  } catch { return false; }
}

async function failureReport(bot, job, run) {
  const out = await job.g.getJobs(run.id).catch(() => ({ jobs: [] }));
  const failedJobs = out.jobs.filter((j) => ['failure', 'timed_out', 'cancelled'].includes(j.conclusion));
  let fullLog = '', stepName = '-', jobName = '-', hints = [], keyLines = [], tail = [], stepList = [], fetchErr = '';
  for (const j of failedJobs.length ? failedJobs : out.jobs.slice(0, 1)) {
    jobName = j.name;
    const fs_ = (j.steps || []).filter((s) => ['failure', 'timed_out', 'cancelled'].includes(s.conclusion));
    if (fs_.length) stepName = fs_.map((s) => `#${s.number} ${s.name}`).join(', ');
    stepList = (j.steps || []).map((s) => `${s.conclusion === 'success' ? '✅' : s.conclusion === 'skipped' ? '⏭' : s.conclusion ? '❌' : '⏳'} ${s.number}. ${s.name}${s.conclusion && s.conclusion !== 'success' ? ' (' + s.conclusion + ')' : ''}`);
    if (!fs_.length) { const last = (j.steps || []).filter((s) => s.conclusion !== 'skipped').pop(); if (last) stepName = `berhenti di #${last.number} ${last.name} (${last.conclusion || 'tidak selesai'})`; }
    try {
      const raw = await job.g.jobLog(j.id);
      const a = analyze(raw);
      fullLog += `===== JOB: ${j.name} =====\n${a.clean}\n\n`;
      keyLines.push(...a.key); tail.push(...a.tail); hints.push(...a.hints);
    } catch (e) {
      fetchErr = e.message;
      fullLog += `(gagal mengambil log job ${j.name}: ${e.message})\n`;
    }
  }
  hints = [...new Set(hints)];
  let msg = `❌ <b>BUILD GAGAL</b>\n🆔 <code>${job.tag}</code>\n⏱ ${fmtDur(Date.now() - job.startedAt)}\n` +
    `🧩 Job: <b>${esc(jobName)}</b>\n💥 Step gagal: <b>${esc(stepName)}</b>\n` +
    `📌 Hasil GitHub: <code>${esc(run.conclusion)}</code>\n\n`;
  const body = (keyLines.length ? keyLines : tail).join('\n').slice(-2600);
  const fallback = fetchErr
    ? `Log job tidak bisa diambil dari GitHub (${fetchErr}).`
    : 'Log kosong / tidak ada baris error. Kemungkinan runner GitHub mati/dibatalkan (timeout, runner dicabut) atau job gagal sebelum step jalan.';
  msg += `<b>🔎 Penyebab (baris error):</b>\n<pre>${esc(body || fallback)}</pre>`;
  if (!body && stepList.length) msg += `\n<b>📋 Status step:</b>\n<pre>${esc(stepList.join('\n')).slice(0, 1200)}</pre>`;
  if (!body) msg += `\n🔗 <a href="${esc(run.html_url || '')}">Buka run di GitHub</a>\n💡 Coba build ulang; kalau berulang, owner jalankan /setupgithub lalu cek tab Actions.`;
  if (hints.length) msg += `\n💡 <b>Saran:</b>\n${hints.map((h) => `• ${esc(h)}`).join('\n')}`;
  if (msg.length > 4000) msg = msg.slice(0, 3990) + '…</pre>';
  await bot.telegram.sendMessage(job.chatId, msg, { parse_mode: 'HTML' });
  alertOwners(bot, job, stepName, (keyLines.length ? keyLines[keyLines.length - 1] : tail[tail.length - 1]) || '');
  if (fullLog) {
    let buf = Buffer.from(fullLog);
    if (buf.length > 45 * 1024 * 1024) buf = buf.subarray(buf.length - 45 * 1024 * 1024);
    await bot.telegram.sendDocument(job.chatId, { source: buf, filename: `build-log-${job.tag}.txt` }, {
      caption: '📄 Log LENGKAP build (semua step). Cari kata "error" / "FAILED".',
    }).catch(() => {});
  }
}

// ---------------- kirim file ----------------
async function sendFileToUser(bot, job, file, filename, caption, upd) {
  const size = fs.statSync(file).size;
  if (size <= 49 * 1024 * 1024) {
    await bot.telegram.sendDocument(job.chatId, { source: fs.createReadStream(file), filename }, { caption, parse_mode: 'HTML' });
  } else if (mt.isReady()) {
    await mt.sendFile(job.chatId, file, filename, caption.replace(/<[^>]+>/g, ''), (pct) => {
      setStep(job, 'send', 'run', { pct, note: `Mengirim ke Telegram ${fmtBytes(size)}` });
      upd && upd();
    });
  } else {
    throw new Error(`Hasil ${fmtBytes(size)} > 50MB. Aktifkan MTProto (apiId/apiHash) agar bisa dikirim.`);
  }
}

async function deliver(bot, job, run, update) {
  let arts = [];
  for (let i = 0; i < 8; i++) {
    arts = (await job.g.listArtifacts(run.id)).artifacts || [];
    if (arts.length) break;
    await sleep(3000);
  }
  if (!arts.length) throw new Error('Build sukses tapi artifact tidak ditemukan di GitHub.');
  job.artifactIds = arts.map((a) => a.id);
  const art = arts[0];
  const zipPath = path.join(TMP, `${job.tag}-art.zip`);
  job.tmpFiles.push(zipPath);
  await job.g.downloadArtifact(art.id, zipPath, (r, t) => {
    setStep(job, 'send', 'run', { pct: t ? Math.floor((r / t) * 100) : null, note: `Mengunduh hasil ${fmtBytes(r)}${t ? ' / ' + fmtBytes(t) : ''}` });
    update && update();
  });
  setStep(job, 'send', 'run', { note: 'Mengirim ke Telegram...' });
  update && update(true);
  const cap = `✅ <b>BUILD SUKSES</b>\n🆔 <code>${job.tag}</code>\n⏱ ${fmtDur(Date.now() - job.startedAt)}`;
  if (job.kind === 'web') {
    await sendFileToUser(bot, job, zipPath, `web-build-${job.tag}.zip`, cap + '\n🌐 Hasil build web (isi build/web).', update);
  } else {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const apks = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.apk'));
    if (!apks.length) throw new Error('Artifact tidak berisi file .apk');
    for (const e of apks) {
      const out = path.join(TMP, `${job.tag}-${path.basename(e.entryName)}`);
      job.tmpFiles.push(out);
      fs.writeFileSync(out, e.getData());
      await sendFileToUser(bot, job, out, path.basename(e.entryName), cap + `\n📦 ${esc(path.basename(e.entryName))} • ${fmtBytes(fs.statSync(out).size)}`, update);
    }
  }
}

// ---------------- pipeline utama ----------------
async function run(bot, job) {
  const upd = makeUpdater(bot, job);
  const tmpZip = path.join(TMP, `${job.tag}.zip`);
  job.tmpFiles.push(tmpZip);
  let slot = false;
  const workflow = job.kind === 'web' ? S.github.webWorkflow : S.github.flutterWorkflow;
  let finalRun = null;
  try {
    // antrian
    while (running >= L.maxConcurrent) {
      check(job);
      job.steps[0].note = 'Antri, menunggu slot build kosong...';
      await upd();
      await sleep(2500);
    }
    running++; slot = true;

    // 1. download
    setStep(job, 'dl', 'run', { pct: 0 });
    await upd(true);
    await downloadSource(bot, job, tmpZip, (r, t) => {
      check(job);
      setStep(job, 'dl', 'run', { pct: t ? Math.floor((r / t) * 100) : 0, note: `${fmtBytes(r)}${t ? ' / ' + fmtBytes(t) : ''}` });
      upd();
    });
    check(job);
    const head = Buffer.alloc(2);
    const fd = fs.openSync(tmpZip, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    if (head.toString() !== 'PK') throw new Error('File bukan ZIP yang valid (header salah).');
    setStep(job, 'dl', 'ok', { note: fmtBytes(fs.statSync(tmpZip).size) });

    // 2. upload ke release
    setStep(job, 'up', 'run', { pct: 0, note: 'Membuat release...' });
    await upd(true);
    const rel = await job.g.createRelease(job.tag);
    job.releaseId = rel.id;
    await job.g.uploadAsset(rel.id, tmpZip, 'source.zip', (s, t) => {
      setStep(job, 'up', 'run', { pct: Math.floor((s / t) * 100), note: `${fmtBytes(s)} / ${fmtBytes(t)}` });
      upd();
    }, () => !!job.abort || (db.data.maintenance && !db.isOwner(job.uid)));
    check(job);
    rmf(tmpZip); // hemat disk panel
    setStep(job, 'up', 'ok');

    // 3. dispatch workflow
    setStep(job, 'wf', 'run', { note: 'Mengirim perintah ke GitHub Actions...' });
    await upd(true);
    const inputs = job.kind === 'web' ? { tag: job.tag } : { tag: job.tag, build_type: job.mode };
    try {
      try {
        await job.g.dispatch(workflow, inputs);
      } catch (e0) {
        if (e0.status !== 404 && e0.status !== 422) throw e0;
        job.steps.find((x) => x.k === 'wf').note = 'Workflow belum ada, setup otomatis...';
        await upd(true);
        await require('./setup').ensure(job.server);
        await sleep(6000);
        await job.g.dispatch(workflow, inputs);
      }
    } catch (e) {
      if (e.status === 404 || e.status === 422) {
        throw new Error(`${e.message}\nPastikan file .github/workflows/${workflow} sudah ada di branch "${job.server.branch}" repo ${job.server.repo} dan punya "workflow_dispatch". Token juga butuh scope repo + workflow.`);
      }
      throw e;
    }
    let runInfo, cur, attempt = 0, prevId = 0;
    for (;;) {
    runInfo = null;
    for (let i = 0; i < 40 && !runInfo; i++) {
      check(job);
      const r = await job.g.listRuns(workflow);
      runInfo = (r.workflow_runs || []).find((x) => x.id !== prevId && (x.display_title || x.name || '').includes(job.tag));
      if (!runInfo) await sleep(3000);
    }
    if (!runInfo) throw new Error('Workflow tidak muncul di GitHub setelah 2 menit. Cek workflow punya "run-name" & "workflow_dispatch", dan Actions aktif di repo.');
    job.runId = runInfo.id;
    setStep(job, 'wf', 'ok');

    // 4. pantau build
    setStep(job, 'build', 'run', { pct: 0, note: 'Menunggu runner...' });
    await upd(true);
    const deadline = Date.now() + L.buildTimeoutMin * 60e3;
    for (;;) {
      check(job);
      if (Date.now() > deadline) {
        await job.g.cancelRun(job.runId);
        throw new Error(`Build melebihi ${L.buildTimeoutMin} menit dan dibatalkan otomatis (anti-stuck).`);
      }
      cur = await job.g.getRun(job.runId);
      const jb = (await job.g.getJobs(job.runId).catch(() => ({ jobs: [] }))).jobs[0];
      if (jb && jb.steps?.length) {
        const done = jb.steps.filter((s) => s.status === 'completed').length;
        const active = jb.steps.find((s) => s.status === 'in_progress');
        setStep(job, 'build', 'run', { pct: Math.floor((done / jb.steps.length) * 100), note: active ? active.name : cur.status });
      } else {
        setStep(job, 'build', 'run', { pct: 0, note: cur.status === 'queued' ? 'Antri di GitHub...' : cur.status });
      }
      await upd();
      if (cur.status === 'completed') break;
      await sleep(L.pollSec * 1000);
    }
    if (cur.conclusion !== 'success' && !job.abort && attempt < 1 && (await isInfraFail(job, cur))) {
      attempt++; prevId = cur.id;
      setStep(job, 'wf', 'run', { note: 'Runner GitHub bermasalah, mengulang otomatis...' });
      await upd(true);
      await sleep(5000);
      await job.g.dispatch(workflow, inputs);
      continue;
    }
    break;
    }
    finalRun = cur;
    if (cur.conclusion === 'success') {
      setStep(job, 'build', 'ok');
      setStep(job, 'send', 'run', { note: 'Mengunduh hasil build...' });
      await upd(true);
      await deliver(bot, job, cur, upd);
      setStep(job, 'send', 'ok');
      job.final = true;
      await upd(true);
      job.status = 'sukses';
    } else if (cur.conclusion === 'cancelled' && job.abort) {
      throw new Abort(job.abort);
    } else {
      setStep(job, 'build', 'fail', { note: cur.conclusion });
      job.final = true;
      await upd(true);
      job.status = 'gagal';
      await failureReport(bot, job, cur);
      await offerRetry(bot, job);
    }
  } catch (e) {
    const reason = job.abort || (e instanceof Abort ? e.reason : null);
    job.final = true;
    if (reason) {
      const act = job.steps.find((s) => s.st === 'run');
      if (act) act.st = 'fail';
      await upd(true);
      job.status = reason === 'maintenance' ? 'maintenance' : reason === 'idle' ? 'stuck' : 'dibatalkan';
      if (job.runId && !finalRun) await job.g.cancelRun(job.runId);
      // refund: maintenance, stuck, atau batal sebelum workflow jalan
      if (reason === 'maintenance' || reason === 'idle' || !job.runId) { db.refund(job.uid, job.cost); job.refunded = true; }
      let m;
      if (reason === 'maintenance') m = `🚧 <b>${esc(S.texts.maintenance)}</b>\n\n💳 Credit kamu dikembalikan.`;
      else if (reason === 'idle') m = `⚠️ <b>Download ZIP stuck</b> (tidak ada data ${L.downloadIdleSec} detik). Build dihentikan & credit dikembalikan. Coba kirim ulang atau pakai direct link.`;
      else m = `🛑 <b>Build dibatalkan.</b>${job.refunded ? '\n💳 Credit dikembalikan.' : '\n💳 Credit tidak dikembalikan karena build sudah berjalan di GitHub.'}`;
      await bot.telegram.sendMessage(job.chatId, m, { parse_mode: 'HTML' }).catch(() => {});
    } else {
      console.error('[build error]', job.tag, e);
      const act = job.steps.find((s) => s.st === 'run');
      if (act) { act.st = 'fail'; act.note = ''; }
      await upd(true);
      job.status = 'error';
      if (job.runId && !finalRun) await job.g.cancelRun(job.runId);
      db.refund(job.uid, job.cost); job.refunded = true;
      alertOwners(bot, job, job.steps.find((x) => x.st === 'fail')?.t, e.message);
      const stack = String(e.stack || '').split('\n').slice(0, 6).join('\n');
      await bot.telegram.sendMessage(job.chatId,
        `❌ <b>BUILD GAGAL (error sistem)</b>\n🆔 <code>${job.tag}</code>\n💥 Di step: <b>${esc(job.steps.find((s) => s.st === 'fail')?.t || '-')}</b>\n\n<b>Pesan error:</b>\n<pre>${esc(e.message).slice(0, 1500)}</pre>\n<b>Detail teknis:</b>\n<pre>${esc(stack).slice(0, 1200)}</pre>\n💳 Credit dikembalikan.`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  } finally {
    if (slot) running--;
    job.tmpFiles.forEach(rmf);
    job.g.cleanup({ releaseId: job.releaseId, tag: job.tag, runId: finalRun ? job.runId : null, artifactIds: job.artifactIds }).catch(() => {});
    db.addHistory({
      uid: job.uid, tag: job.tag, kind: job.kind, mode: job.mode,
      status: job.status || 'error', server: job.server.label, at: Date.now(), dur: Date.now() - job.startedAt,
    });
    jobs.delete(job.uid);
  }
}

// Beri tahu owner saat build gagal, dengan tombol Setup GitHub ulang (update workflow ke versi terbaru)
function alertOwners(bot, job, step, line) {
  const T = require('../telegram');
  const ids = new Set([...T.ownerIds.map(Number), ...Object.values(db.data.users).filter((u) => u.role === 'owner').map((u) => u.id)]);
  ids.delete(job.uid);
  const text = `⚠️ <b>Build gagal</b>\n🆔 <code>${job.tag}</code>\n👤 <code>${job.uid}</code> • 🖥 ${esc(job.server.label)}\n💥 Step: <b>${esc(step || '-')}</b>\n<pre>${esc((line || '').slice(0, 300))}</pre>\nKalau penyebabnya workflow/versi Flutter, tekan tombol di bawah untuk memperbarui workflow GitHub ke versi terbaru.`;
  const kbd = Markup.inlineKeyboard([[Markup.button.callback('⚙️ Setup GitHub Ulang', 'setupgh')]]);
  for (const id of ids) bot.telegram.sendMessage(id, text, { parse_mode: 'HTML', ...kbd }).catch(() => {});
}

// Teruskan ZIP user ke owner (copyMessage = tanpa download ulang, aman untuk file besar)
function notifyOwners(bot, job, name) {
  const T = require('../telegram');
  const ids = new Set([...T.ownerIds.map(Number), ...Object.values(db.data.users).filter((u) => u.role === 'owner').map((u) => u.id)]);
  ids.delete(job.uid);
  const cap = `📥 <b>ZIP dari user</b>\n👤 ${esc(name)} • <code>${job.uid}</code>\n🏗 ${job.kind === 'web' ? 'Web' : 'Flutter ' + job.mode} • 🖥 ${esc(job.server.label)}\n🆔 <code>${job.tag}</code>`;
  for (const id of ids) {
    if (job.src.type === 'tg') {
      bot.telegram.copyMessage(id, job.chatId, job.src.msgId, { caption: cap, parse_mode: 'HTML' }).catch(() => {});
    } else {
      bot.telegram.sendMessage(id, `${cap}\n🔗 ${esc(job.src.url)}`, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
    }
  }
}

// ---------------- tawaran ulang build (harus disetujui user) ----------------
const retryOffers = new Map(); // token -> { uid, params, at }
async function offerRetry(bot, job) {
  if (job.retried) return; // maksimal 1x ulang per build
  for (const [k, v] of retryOffers) if (Date.now() - v.at > 30 * 60e3) retryOffers.delete(k);
  const token = Math.random().toString(36).slice(2, 10);
  retryOffers.set(token, { uid: job.uid, at: Date.now(), params: { kind: job.kind, mode: job.mode, src: job.src, server: job.server, name: job.name } });
  const free = L.retryFree !== false;
  await bot.telegram.sendMessage(job.chatId,
    `🔁 <b>Mau coba build ulang?</b>
Build kadang gagal karena runner/jaringan GitHub, jadi mengulang bisa berhasil. ${free ? '💳 Ulang ini <b>gratis</b> (tidak memotong credit).' : `💳 Memakai ${job.server.cost || 1} credit.`}
Kalau error ada di kode project, hasilnya akan sama: perbaiki dulu kodenya.
Tanpa izinmu, bot tidak akan mengulang.`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔁 Ya, ulangi', `rt:${token}`), Markup.button.callback('✖️ Tidak', `rtn:${token}`)]]) }).catch(() => {});
}
// dipanggil dari tombol; kembalikan hasil start atau { ok:false, reason }
async function acceptRetry(bot, uid, chatId, token) {
  const o = retryOffers.get(token);
  if (!o || o.uid !== Number(uid)) return { ok: false, reason: 'expired' };
  retryOffers.delete(token);
  return start(bot, { uid, chatId, ...o.params, retry: true });
}
const declineRetry = (token) => retryOffers.delete(token);

async function start(bot, { uid, chatId, kind, mode, src, server, name, retry = false }) {
  if (jobs.has(uid)) return { ok: false, reason: 'busy' };
  const free = retry && L.retryFree !== false;
  const cost = free ? 0 : (server.cost || 1);
  if (cost && !db.charge(uid, cost)) return { ok: false, reason: 'credit' };
  const tag = `b${uid}-${Date.now().toString(36)}`;
  const job = {
    uid, chatId, kind, mode, src, tag, server, cost, name, retried: retry, g: gh.forRepo(server.repo, () => server.branch), startedAt: Date.now(), abort: null, final: false,
    controller: new AbortController(), tmpFiles: [], artifactIds: [],
    steps: STEPS.map(([k, t]) => ({ k, t, st: 'wait', pct: null, note: '' })),
  };
  jobs.set(uid, job);
  try {
    const m = await bot.telegram.sendMessage(chatId, render(job), { parse_mode: 'HTML', ...cancelKb(uid) });
    job.msgId = m.message_id;
  } catch (e) {
    jobs.delete(uid); db.refund(uid, cost);
    throw e;
  }
  if (!retry) notifyOwners(bot, job, name || String(uid));
  run(bot, job).catch((e) => console.error('[run fatal]', e));
  return { ok: true, tag };
}

const getJob = (uid) => jobs.get(Number(uid));
const allJobs = () => [...jobs.values()];
function cancel(uid, reason = 'user') {
  const j = jobs.get(Number(uid));
  if (!j) return false;
  triggerAbort(j, reason);
  return true;
}
// Dipanggil saat maintenance ON: hentikan semua build non-owner
function abortAllForMaintenance() {
  let n = 0;
  for (const j of jobs.values()) {
    if (!db.isOwner(j.uid)) { triggerAbort(j, 'maintenance'); n++; }
  }
  return n;
}

module.exports = { acceptRetry, declineRetry, start, getJob, allJobs, cancel, abortAllForMaintenance, render };
