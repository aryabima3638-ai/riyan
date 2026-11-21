// Auto setup GitHub: bot membuat / memperbarui file workflow di repo lewat API (tanpa upload manual)
const S = require('../setting');
const gh = require('./github');

// "§" diganti "$" supaya tidak bentrok dengan template literal JS
const fix = (x) => x.replace(/§/g, '$');

const CHAIN = () => (S.flutterChain && S.flutterChain.length ? S.flutterChain : [{ label: 'Terbaru', value: '' }]);

// Error yang kemungkinan besar karena versi Flutter/Gradle/AGP tidak cocok -> coba Flutter berikutnya
const VERSIONISH = "minimum supported version|No named parameter|isn.t defined|is not defined|Undefined (name|class|method)|The (getter|method|named parameter)|Dart SDK|SDK version|version solving|requires Flutter|Unsupported (class file|Gradle|Kotlin)|Android Gradle Plugin|incompatible|Kotlin.*version|NoSuchMethod|compileSdk";

const FIND_ROOT = `
          mkdir -p source
          gh release download "§{{ inputs.tag }}" --repo §{{ github.repository }} --pattern "*.zip" --dir source
          cd source
          unzip -q -o ./source.zip || unzip -q -o ./*.zip
          PUB=$(find . -name pubspec.yaml -not -path '*/__MACOSX/*' -not -path '*/.dart_tool/*' -not -path '*/ephemeral/*' -not -path '*/example/*' -not -path '*/.symlinks/*' | awk '{print length, $0}' | sort -n | sed -n '1p' | cut -d' ' -f2- || true)
          if [ -z "$PUB" ]; then
            echo "Isi ZIP (3 level teratas):"
            find . -maxdepth 3 | head -60 || true
            echo "::error::pubspec.yaml tidak ditemukan di dalam ZIP. Zip folder project Flutter yang ada pubspec.yaml."
            exit 1
          fi
          ROOT=$(cd "$(dirname "$PUB")" && pwd)
          echo "PROJECT_ROOT=$ROOT" >> "$GITHUB_ENV"
          echo "Project root: $ROOT"`;

const FIXMS = String.raw`          cat > /tmp/fixminsdk.py <<'PY'
          import re, glob, os
          t = int(os.environ['MS'])
          files = glob.glob('android/app/build.gradle') + glob.glob('android/app/build.gradle.kts')
          rx = re.compile(r'(minSdk(?:Version)?)(\s*=?\s*)(\d+|flutter\.minSdkVersion)')
          def fix(m):
              v = m.group(3)
              if v.isdigit() and int(v) >= t:
                  return m.group(0)
              return m.group(1) + m.group(2) + str(t)
          for f in files:
              src = open(f, encoding='utf-8').read()
              out = rx.sub(fix, src)
              if out != src:
                  open(f, 'w', encoding='utf-8').write(out)
                  print('minSdk dinaikkan ke', t, 'di', f)
          PY`;

function attempt(kind, i, v, label, cond = '') {
  const apk = kind === 'apk';
  return `
      - name: Setup Flutter ${label}
        if: env.BUILD_DONE != '1'${cond}
        uses: subosito/flutter-action@v2
        with:
          flutter-version: '${v}'
          channel: stable
          cache: true

      - name: Build dengan Flutter ${label}
        if: env.BUILD_DONE != '1'${cond}
        run: |
          cd "$PROJECT_ROOT"
          set +e
          rm -rf .dart_tool build
          flutter --version
          LOG=/tmp/build-${i}.log
${apk ? `          if [ "§{{ inputs.build_type }}" = "debug" ]; then
            ARGS="--debug --target-platform android-arm64"
          else
            ARGS="--release --target-platform android-arm64 --no-shrink"
          fi
` : ''}          flutter pub get 2>&1 | tee $LOG
          RC=§{PIPESTATUS[0]}
          if [ "$RC" -eq 0 ]; then
            for n in 1 2 3 4 5; do
              ${apk ? 'flutter build apk $ARGS' : 'flutter build web --release'} 2>&1 | tee $LOG
              RC=§{PIPESTATUS[0]}
              [ "$RC" -eq 0 ] && break
${apk ? `              M=$(grep -o "cannot be smaller than version [0-9]*" $LOG | head -1 | grep -o '[0-9]*$')
              [ -z "$M" ] && break
              echo "::notice::minSdk dinaikkan ke $M lalu build diulang"
              MS=$M python3 /tmp/fixminsdk.py
` : ''}            done
          fi
          if [ "$RC" -eq 0 ]; then
            echo "BUILD_DONE=1" >> "$GITHUB_ENV"
            echo "BUILD_OK=1" >> "$GITHUB_ENV"
            echo "::notice::Build sukses dengan Flutter ${label}"
          elif ! grep -Eiq '${VERSIONISH}' $LOG; then
            echo "BUILD_DONE=1" >> "$GITHUB_ENV"
            echo "Error bukan masalah versi Flutter, tidak mencoba versi lain."
          else
            echo "::warning::Gagal di Flutter ${label}, mencoba versi lain..."
          fi
          exit 0
`;
}

function workflow(kind) {
  const apk = kind === 'apk';
  // Flutter terbaru hanya dicoba PERTAMA kalau project sudah Gradle/AGP 9+ (atau web); selain itu dicoba TERAKHIR
  const chain = CHAIN();
  const latest = chain.find((c) => c.value === '') || { label: 'terbaru', value: '' };
  const rest = chain.filter((c) => c.value !== '');
  const attempts = attempt(kind, 'a', latest.value, latest.label + ' (prioritas)', " && env.PREFER_LATEST == '1'")
    + rest.map((c, i) => attempt(kind, i, c.value, c.label)).join('')
    + attempt(kind, 'z', latest.value, latest.label + ' (terakhir)', " && env.PREFER_LATEST != '1'");
  return fix(`name: ${apk ? 'Build Flutter' : 'Build Flutter Web'}
run-name: Build §{{ inputs.tag }} (${apk ? '§{{ inputs.build_type }}' : 'web'})

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag yang berisi source ZIP
        required: true
${apk ? `      build_type:
        description: release atau debug
        default: release
` : ''}
permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - uses: actions/cache@v4
        with:
          path: |
            ~/.gradle/caches
            ~/.gradle/wrapper
            ~/.pub-cache
          key: gradle-pub-§{{ runner.os }}-§{{ github.run_id }}
          restore-keys: |
            gradle-pub-§{{ runner.os }}-

      - name: Download & extract source ZIP
        env:
          GH_TOKEN: §{{ secrets.GITHUB_TOKEN }}
        run: |${FIND_ROOT}
${apk ? `
      - name: Auto-fix minSdk (minimal 24)
        run: |
          cd "$PROJECT_ROOT"
${FIXMS}
          MS=24 python3 /tmp/fixminsdk.py
` : ''}
${apk ? `
      - name: Deteksi Gradle/AGP project
        run: |
          cd "$PROJECT_ROOT"
          GV=$(grep -o 'gradle-[0-9]*' android/gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -1 | grep -o '[0-9]*$' || true)
          AV=$(cat android/settings.gradle android/settings.gradle.kts android/build.gradle android/build.gradle.kts 2>/dev/null | grep -oE 'com[.]android[.](application|tools[.]build:gradle)[^0-9]{0,40}[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)
          echo "Gradle major: §{GV:-?}, AGP major: §{AV:-?}"
          if [ "§{GV:-0}" -ge 9 ] || [ "§{AV:-0}" -ge 9 ]; then
            echo "PREFER_LATEST=1" >> "$GITHUB_ENV"
            echo "::notice::Project Gradle/AGP 9+, mulai dari Flutter terbaru"
          fi
` : `
      - name: Prioritas Flutter terbaru (web)
        run: echo "PREFER_LATEST=1" >> "$GITHUB_ENV"
`}
      - name: Optimasi Gradle
        run: |
          AV=$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
          if [ "§{AV:-99}" -lt 8 ]; then sudo rm -rf /usr/share/dotnet /opt/ghc /usr/local/share/boost; fi
          mkdir -p ~/.gradle
          {
            echo 'org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g'
            echo 'org.gradle.parallel=true'
            echo 'org.gradle.caching=true'
            echo 'org.gradle.configureondemand=true'
          } >> ~/.gradle/gradle.properties
${attempts}
      - name: Cek hasil build
        if: env.BUILD_OK != '1'
        run: |
          echo "::error::Build gagal. Versi Flutter yang dicoba: ${[...CHAIN().filter((c) => c.value !== ''), CHAIN().find((c) => c.value === '') || { label: 'terbaru' }].map((c) => c.label).join(', ')}"
          for f in /tmp/build-*.log; do
            echo "=== $f ==="
            grep -iE 'error|failed|went wrong|minimum|cannot be smaller' "$f" | tail -30 || true
          done
          exit 1

      - uses: actions/upload-artifact@v4
        with:
          name: ${apk ? 'app-§{{ inputs.build_type }}' : 'web-build'}
          path: §{{ env.PROJECT_ROOT }}/${apk ? 'build/app/outputs/flutter-apk/*.apk' : 'build/web'}
          if-no-files-found: error
          retention-days: 1
          compression-level: 0
`);
}

const FLUTTER = workflow('apk');
const WEB = workflow('web');

async function put(server, file, content, branch) {
  const p = `/repos/${server.repo}/contents/.github/workflows/${file}`;
  let sha;
  try {
    const cur = await gh.api('GET', `${p}?ref=${encodeURIComponent(branch)}`);
    if (Buffer.from(cur.content, 'base64').toString('utf8') === content) return 'sudah terbaru';
    sha = cur.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const body = { message: `bot: ${sha ? 'update' : 'tambah'} ${file}`, content: Buffer.from(content).toString('base64'), branch };
  if (sha) body.sha = sha;
  try {
    await gh.api('PUT', p, { body });
  } catch (e) {
    if (e.status === 404 || e.status === 409 || e.status === 422) { // repo kosong / branch belum ada
      delete body.branch;
      await gh.api('PUT', p, { body });
    } else throw e;
  }
  return sha ? 'diperbarui' : 'dibuat';
}

// Mengembalikan teks laporan; throw kalau token/repo salah
async function ensure(server) {
  const repo = await gh.api('GET', `/repos/${server.repo}`);
  if (!repo.permissions?.push) throw new Error('Token tidak punya akses push ke repo ini (butuh scope repo + workflow).');
  try {
    await gh.api('GET', `/repos/${server.repo}/branches/${encodeURIComponent(server.branch)}`);
  } catch (e) {
    if (e.status === 404 && repo.default_branch) { server.branch = repo.default_branch; require('./db').save(); }
  }
  const b = server.branch;
  const r1 = await put(server, S.github.flutterWorkflow, FLUTTER, b);
  const r2 = await put(server, S.github.webWorkflow, WEB, b);
  return `📱 ${S.github.flutterWorkflow}: ${r1}\n🌐 ${S.github.webWorkflow}: ${r2}\n🌿 Branch: ${server.branch}`;
}

const files = () => ({ [S.github.flutterWorkflow]: FLUTTER, [S.github.webWorkflow]: WEB });

// cek cepat sebelum dipasang: harus ada trigger, run-name, dan tidak ada sisa placeholder
function selfCheck() {
  const bad = [];
  for (const [name, y] of Object.entries(files())) {
    if (!/workflow_dispatch/.test(y)) bad.push(`${name}: tanpa workflow_dispatch`);
    if (!/run-name:/.test(y)) bad.push(`${name}: tanpa run-name`);
    if (/§|\$\{\{\s*\}\}/.test(y)) bad.push(`${name}: sisa placeholder`);
    if (/\t/.test(y)) bad.push(`${name}: ada karakter TAB`);
  }
  return bad;
}

module.exports = { ensure, files, selfCheck };
