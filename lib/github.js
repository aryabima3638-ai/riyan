// Wrapper GitHub API (release, workflow dispatch, run, job log, artifact) - mendukung banyak repo (server)
const fs = require('fs');
const https = require('https');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const S = require('../setting');
const { sleep } = require('./util');

const BASE = 'https://api.github.com';
const HEAD = () => ({
  Authorization: `Bearer ${S.github.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'flutter-build-bot',
});

async function api(method, pathname, { body, raw, retries = 3 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(BASE + pathname, {
        method,
        headers: { ...HEAD(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if (res.status >= 500 && i < retries) { await sleep(2000 * (i + 1)); continue; }
      if (raw) return res;
      if (res.status === 204) return null;
      const txt = await res.text();
      let json; try { json = JSON.parse(txt); } catch { json = txt; }
      if (!res.ok) {
        const err = new Error(`GitHub ${res.status}: ${json?.message || txt}`);
        err.status = res.status;
        throw err;
      }
      return json;
    } catch (e) {
      if (e.status) throw e;
      if (i < retries) { await sleep(2000 * (i + 1)); continue; }
      throw e;
    }
  }
}

// Unduh file besar dengan beberapa koneksi paralel (Range). getUrl(true) dipanggil ulang kalau URL kedaluwarsa.
async function rangedDownload(getUrl, firstUrl, dest, total, onProgress, conns = 6, chunk = 8 * 1024 * 1024) {
  const fh = await fs.promises.open(dest, 'w');
  try {
    await fh.truncate(total);
    const parts = [];
    for (let st = 0; st < total; st += chunk) parts.push([st, Math.min(st + chunk, total) - 1]);
    let next = 0, done = 0, url = firstUrl;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= parts.length) return;
        const [a, b] = parts[i];
        for (let t = 0; ; t++) {
          try {
            const res = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, signal: AbortSignal.timeout(120000) });
            if (res.status === 401 || res.status === 403) { url = await getUrl(); throw new Error('URL kedaluwarsa'); }
            if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length !== b - a + 1) throw new Error('ukuran potongan salah');
            await fh.write(buf, 0, buf.length, a);
            done += buf.length;
            onProgress && onProgress(done, total);
            break;
          } catch (e) {
            if (t >= 3) throw e;
            await sleep(500 * (t + 1));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(conns, parts.length) }, worker));
  } finally {
    await fh.close();
  }
}

// Buat klien untuk satu repo (server). getBranch dipanggil saat dibutuhkan agar selalu terbaru.
function forRepo(repo, getBranch = () => S.github.branch) {
  const R = `/repos/${repo}`;

  const createRelease = (tag) => api('POST', `${R}/releases`, {
    body: {
      tag_name: tag, target_commitish: getBranch(), name: tag,
      body: 'Source ZIP sementara (otomatis dihapus setelah build)', prerelease: true,
    },
  });

  // Upload file besar (sampai 2GB) secara streaming
  const uploadAsset = (releaseId, file, name, onProgress, shouldAbort) => new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const u = new URL(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`);
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: { ...HEAD(), 'Content-Type': 'application/zip', 'Content-Length': size },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(JSON.parse(buf));
        reject(new Error(`Upload asset gagal (${res.statusCode}): ${buf.slice(0, 300)}`));
      });
    });
    req.setTimeout(180000, () => req.destroy(new Error('Upload ke GitHub timeout (tidak ada aktivitas 3 menit)')));
    req.on('error', reject);
    const rs = fs.createReadStream(file);
    let sent = 0;
    rs.on('data', (c) => {
      sent += c.length;
      if (shouldAbort && shouldAbort()) { rs.destroy(); req.destroy(new Error('ABORT')); return; }
      onProgress && onProgress(sent, size);
    });
    rs.on('error', reject);
    rs.pipe(req);
  });

  const dispatch = (workflow, inputs) =>
    api('POST', `${R}/actions/workflows/${workflow}/dispatches`, { body: { ref: getBranch(), inputs } });
  const listRuns = (workflow) =>
    api('GET', `${R}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`);
  const getRun = (id) => api('GET', `${R}/actions/runs/${id}`);
  const getJobs = (id) => api('GET', `${R}/actions/runs/${id}/jobs?per_page=30`);
  const cancelRun = (id) => api('POST', `${R}/actions/runs/${id}/cancel`).catch(() => {});
  const listArtifacts = (id) => api('GET', `${R}/actions/runs/${id}/artifacts`);

  async function jobLog(jobId) {
    const res = await api('GET', `${R}/actions/jobs/${jobId}/logs`, { raw: true });
    if (!res.ok) throw new Error(`Gagal ambil log job (${res.status})`);
    return res.text();
  }

  async function downloadArtifact(id, dest, onProgress) {
    const apiUrl = `${BASE}${R}/actions/artifacts/${id}/zip`;
    // URL bertanda tangan (tanpa header Authorization) dari redirect GitHub
    const getUrl = async () => {
      const r = await fetch(apiUrl, { headers: HEAD(), redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`Tidak ada redirect download (HTTP ${r.status})`);
      return loc;
    };
    // coba unduh paralel (cepat); kalau gagal, jatuh ke unduh biasa
    try {
      const url = await getUrl();
      const probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) });
      const m = /\/(\d+)$/.exec(probe.headers.get('content-range') || '');
      await probe.arrayBuffer();
      const total = m ? Number(m[1]) : 0;
      if (probe.status === 206 && total > 8 * 1024 * 1024) {
        await rangedDownload(getUrl, url, dest, total, onProgress);
        return;
      }
    } catch (e) {
      console.warn('[artifact] unduh paralel gagal, pakai unduh biasa:', e.message);
    }
    const res = await fetch(apiUrl, { headers: HEAD(), redirect: 'follow', signal: AbortSignal.timeout(15 * 60e3) });
    if (!res.ok) throw new Error(`Download artifact gagal (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    let got = 0;
    const src = Readable.fromWeb(res.body);
    src.on('data', (c) => { got += c.length; onProgress && onProgress(got, total); });
    await pipeline(src, fs.createWriteStream(dest));
  }

  async function cleanup({ releaseId, tag, runId, artifactIds = [] }) {
    const q = [];
    if (releaseId) q.push(api('DELETE', `${R}/releases/${releaseId}`));
    if (tag) q.push(api('DELETE', `${R}/git/refs/tags/${tag}`));
    artifactIds.forEach((a) => q.push(api('DELETE', `${R}/actions/artifacts/${a}`)));
    if (runId) q.push(api('DELETE', `${R}/actions/runs/${runId}`));
    await Promise.allSettled(q);
  }

  return { createRelease, uploadAsset, dispatch, listRuns, getRun, getJobs, cancelRun, listArtifacts, jobLog, downloadArtifact, cleanup };
}

module.exports = { api, forRepo, rangedDownload };
