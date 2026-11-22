#!/usr/bin/env node
// 把 sources.json 中固定版本的上游 FFmpeg 构建重新打包为 npm 包：
//   @scope/<tool>-<platform>  每个平台一个，只含一个可执行文件
//   @scope/<tool>             主包，可选依赖各平台包，附带下载清单 manifest.json
//
//   node scripts/pack.mjs plan                                   列出上游文件，不联网
//   node scripts/pack.mjs pack   [--tool ffmpeg] [--platform x]   下载、校验、生成 dist/*.tgz
//   node scripts/pack.mjs verify [--tool ffmpeg] [--platform x]   发布后从每个源下载并核对 SHA-256

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLicense, extractConfiguration, hashFile, LICENSE_FILES, tarballName, tarballUrls, writeTarball } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, '.cache');
const workDir = join(root, '.work');
const distDir = join(root, 'dist');
const templatesDir = join(root, 'templates');
const releasePath = join(distDir, 'release.json');
const config = JSON.parse(await readFile(join(root, 'sources.json'), 'utf8'));

// ---------- 通用 ----------

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--tool') options.tool = rest[(i += 1)];
    else if (rest[i] === '--platform') options.platform = rest[(i += 1)];
    else throw new Error(`未知参数：${rest[i]}`);
  }
  return { command, options };
}

function pick(all, wanted, label) {
  if (!wanted) return all;
  if (!all.includes(wanted)) throw new Error(`未知${label} ${wanted}，可选：${all.join('、')}`);
  return [wanted];
}

const selectedTools = (options) => pick(config.tools, options.tool, '工具');
const selectedPlatforms = (options) => pick(Object.keys(config.platforms), options.platform, '平台');
const packageName = (tool, platform) => `${config.scope}/${tool}${platform ? `-${platform}` : ''}`;
const exeName = (tool, platform) => (config.platforms[platform].os === 'win32' ? `${tool}.exe` : tool);
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const rel = (file) => relative(process.cwd(), file).replaceAll('\\', '/');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 失败，退出码 ${result.status}`);
}

async function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : fallback;
}

// ---------- 下载与解压 ----------

// 用 curl 下载：遵循系统代理环境变量，支持重试。先写 .part，大小和 SHA-256 都对上才改名。
async function download(url, dest, expected, { force = false } = {}) {
  if (!force && existsSync(dest)) {
    if ((await hashFile(dest)) === expected.sha256) {
      console.log(`  已缓存 ${rel(dest)}`);
      return;
    }
    await rm(dest);
  }
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  await rm(part, { force: true });
  console.log(`  下载 ${url}`);
  run('curl', ['-fL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '--progress-bar', '-o', part, url]);
  const size = (await stat(part)).size;
  const actual = await hashFile(part);
  if ((expected.size && size !== expected.size) || actual !== expected.sha256) {
    await rm(part);
    throw new Error(`文件不符（${url}）：期望 ${expected.size} 字节 ${expected.sha256}，实际 ${size} 字节 ${actual}`);
  }
  await rename(part, dest);
}

async function downloadText(url, dest) {
  if (existsSync(dest)) return;
  await mkdir(dirname(dest), { recursive: true });
  run('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '20', '-o', dest, url]);
}

// bsdtar（libarchive）能同时解 zip 和 7z。Windows 10+ 自带的 tar.exe 和 macOS 的 tar 都是 bsdtar。
function findBsdtar() {
  const candidates = [process.env.BSDTAR, 'bsdtar'];
  if (process.platform === 'win32') candidates.push(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'));
  if (process.platform === 'darwin') candidates.push('/usr/bin/tar');
  for (const candidate of candidates.filter(Boolean)) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0 && /bsdtar/.test(probe.stdout)) return candidate;
  }
  return null;
}

async function extract(archive, dest) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const bsdtar = findBsdtar();
  if (bsdtar) return run(bsdtar, ['-xf', archive, '-C', dest]);
  if (archive.endsWith('.zip')) return run('unzip', ['-q', archive, '-d', dest]);
  if (archive.endsWith('.7z')) return run('7z', ['x', '-y', `-o${dest}`, archive], { stdio: ['ignore', 'ignore', 'inherit'] });
  throw new Error('找不到解压工具：请安装 bsdtar（libarchive），或 unzip 和 7z');
}

async function findFile(dir, name) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const matches = entries.filter((entry) => entry.isFile() && entry.name === name).map((entry) => join(entry.parentPath, entry.name));
  if (matches.length !== 1) throw new Error(`在 ${rel(dir)} 中找到 ${matches.length} 个 ${name}，应为 1 个`);
  return matches[0];
}

// 不运行二进制，直接从文件内容读出许可证和编译选项，并确认必需的编译选项都在。
async function inspectBinary(file) {
  const text = (await readFile(file)).toString('latin1');
  const configuration = extractConfiguration(text);
  const fail = (message) => new Error(`${message}\n  编译选项：${configuration || '未找到'}`);
  let license;
  try {
    license = detectLicense(text);
  } catch (error) {
    throw fail(error.message);
  }
  const missing = config.requiredConfigure.filter((flag) => !text.includes(flag));
  if (missing.length) throw fail(`缺少必需的编译选项：${missing.join(' ')}`);
  return { license, configuration };
}

async function licenseText(spdx) {
  const file = LICENSE_FILES[spdx];
  const dest = join(cacheDir, 'licenses', file);
  await downloadText(`${config.licenseBaseUrl}${file}`, dest);
  return dest;
}

async function packTarball(files, name) {
  const file = join(distDir, tarballName(name, config.packageVersion));
  const info = await writeTarball(files, file);
  console.log(`  生成 ${rel(file)}（${mib(info.size)}）`);
  return { package: name, version: config.packageVersion, file: basename(file), ...info, urls: tarballUrls(config.registries, name, config.packageVersion) };
}

function packageJson(fields) {
  const base = { ...fields };
  if (config.repository) base.repository = { type: 'git', url: `git+${config.repository}.git` };
  base.publishConfig = { access: 'public' };
  return json(base);
}

// ---------- 平台包 ----------

function platformReadme(tool, platform, name, upstream, license) {
  const main = packageName(tool);
  return `# ${name}

Static ${tool} binary from FFmpeg ${config.ffmpegVersion} for \`${platform}\`. Install [${main}](https://www.npmjs.com/package/${main}) instead of this package; it selects the right platform automatically.

- Binary: \`bin/${exeName(tool, platform)}\`, unmodified from the upstream build
- Upstream: ${upstream.provider}, ${upstream.url}${upstream.version ? ` (FFmpeg ${upstream.version})` : ''}
- Upstream SHA-256: \`${upstream.sha256}\`
- Build information: ${upstream.buildInfo}
- License: ${license}, see LICENSE
- FFmpeg source code: ${upstream.sourceCode ?? config.sourceTarball}
`;
}

async function packPlatform(tool, platform) {
  const spec = config.platforms[platform];
  const upstream = spec.upstream[tool];
  const name = packageName(tool, platform);
  console.log(`\n[${name}@${config.packageVersion}]`);

  const archive = join(cacheDir, upstream.sha256.slice(0, 12), basename(new URL(upstream.url).pathname));
  await download(upstream.url, archive, upstream);

  const extractDir = join(workDir, `${tool}-${platform}-extract`);
  await extract(archive, extractDir);
  const binary = await findFile(extractDir, exeName(tool, platform));
  const { license, configuration } = await inspectBinary(binary);
  console.log(`  许可证 ${license}，必需编译选项齐全`);

  const pkgDir = join(workDir, `${tool}-${platform}`);
  const binaryPath = `bin/${exeName(tool, platform)}`;
  await rm(pkgDir, { recursive: true, force: true });
  await mkdir(join(pkgDir, 'bin'), { recursive: true });
  await copyFile(binary, join(pkgDir, binaryPath));
  await rm(extractDir, { recursive: true, force: true });
  await copyFile(await licenseText(license), join(pkgDir, 'LICENSE'));

  const binaryInfo = { sha256: await hashFile(join(pkgDir, binaryPath)), size: (await stat(join(pkgDir, binaryPath))).size };
  await writeFile(
    join(pkgDir, 'package.json'),
    packageJson({
      name,
      version: config.packageVersion,
      description: `Static ${tool} binary from FFmpeg ${config.ffmpegVersion} for ${platform}`,
      license,
      os: [spec.os],
      cpu: spec.cpu,
      preferUnplugged: true,
    }),
  );
  await writeFile(
    join(pkgDir, 'BUILDINFO.json'),
    json({ tool, ffmpegVersion: config.ffmpegVersion, platform, license, upstream, binary: { path: binaryPath, ...binaryInfo }, configuration, sourceCode: upstream.sourceCode ?? config.sourceTarball }),
  );
  await writeFile(join(pkgDir, 'README.md'), platformReadme(tool, platform, name, upstream, license));

  const files = ['package.json', 'BUILDINFO.json', 'LICENSE', 'README.md'].map((path) => ({ path, source: join(pkgDir, path), mode: 0o644 }));
  files.push({ path: binaryPath, source: join(pkgDir, binaryPath), mode: 0o755 });
  const tarball = await packTarball(files, name);

  return {
    release: { ...tarball, kind: 'platform', tool, platform },
    entry: {
      package: name,
      version: config.packageVersion,
      file: tarball.file,
      size: tarball.size,
      sha256: tarball.sha256,
      integrity: tarball.integrity,
      binary: binaryPath,
      binarySha256: binaryInfo.sha256,
      binarySize: binaryInfo.size,
      license,
      rustTargets: spec.rustTargets,
      urls: tarball.urls,
    },
  };
}

// ---------- 主包 ----------

function mainReadme(tool, manifest, license) {
  const name = packageName(tool);
  const rows = Object.entries(manifest.platforms)
    .map(([platform, entry]) => `| \`${platform}\` | \`${entry.package}\` | ${mib(entry.size)} |`)
    .concat(Object.entries(manifest.aliases).map(([alias, target]) => `| \`${alias}\` | uses \`${target}\` | — |`))
    .join('\n');
  return `# ${name}

Static \`${tool}\` binaries from FFmpeg ${config.ffmpegVersion} for Windows, macOS and Linux, plus a manifest for apps that download the binary at runtime.

## Use from Node.js

\`\`\`sh
npm install ${name}
\`\`\`

\`\`\`js
const { path } = require('${name}');
// or: import { path } from '${name}';
\`\`\`

Only the package for the current platform is installed, through optional dependencies. \`path\` is \`null\` on unsupported platforms or when optional dependencies were skipped (for example \`npm install --omit=optional\`).

## Platforms

| Platform | Package | Tarball |
| --- | --- | --- |
${rows}

Windows on ARM runs the x64 build through emulation.

## Download at runtime

\`manifest.json\` (also available as \`require('${name}/manifest.json')\`) lists, for each platform, the tarball URLs (npmmirror first, then npmjs; every URL serves the same file), size, SHA-256, and the binary path. Files in the tarball sit under \`package/\`, so the binary is at \`package/<binary>\`. On macOS and Linux, set the executable bit after extracting if your extractor drops it.

## License

The binaries are ${license} builds and include libx264 and libmp3lame. Each platform package contains the license text, the upstream build details in \`BUILDINFO.json\`, and a link to the matching FFmpeg source code.
`;
}

async function packMain(tool, manifest) {
  const name = packageName(tool);
  const licenses = [...new Set(Object.values(manifest.platforms).map((entry) => entry.license))];
  if (licenses.length !== 1) throw new Error(`${tool} 各平台许可证不一致：${licenses.join(' / ')}`);
  console.log(`\n[${name}@${config.packageVersion}]`);

  const pkgDir = join(workDir, tool);
  await rm(pkgDir, { recursive: true, force: true });
  await mkdir(pkgDir, { recursive: true });
  for (const file of ['index.js', 'index.mjs', 'index.d.ts']) await copyFile(join(templatesDir, file), join(pkgDir, file));
  await copyFile(await licenseText(licenses[0]), join(pkgDir, 'LICENSE'));
  await writeFile(join(pkgDir, 'manifest.json'), json(manifest));
  await writeFile(join(pkgDir, 'README.md'), mainReadme(tool, manifest, licenses[0]));
  await writeFile(
    join(pkgDir, 'package.json'),
    packageJson({
      name,
      version: config.packageVersion,
      description: `Static ${tool} binaries from FFmpeg ${config.ffmpegVersion} for Windows, macOS and Linux, with a download manifest`,
      license: licenses[0],
      keywords: [tool, 'ffmpeg', 'static', 'binary', 'prebuilt'],
      main: 'index.js',
      types: 'index.d.ts',
      exports: {
        '.': { types: './index.d.ts', import: './index.mjs', require: './index.js' },
        './manifest.json': './manifest.json',
        './package.json': './package.json',
      },
      engines: { node: '>=18' },
      optionalDependencies: Object.fromEntries(Object.values(manifest.platforms).map((entry) => [entry.package, entry.version])),
    }),
  );

  const files = ['package.json', 'index.js', 'index.mjs', 'index.d.ts', 'manifest.json', 'README.md', 'LICENSE'].map((path) => ({
    path,
    source: join(pkgDir, path),
    mode: 0o644,
  }));
  return { ...(await packTarball(files, name)), kind: 'main', tool };
}

// ---------- 命令 ----------

async function commandPack(options) {
  const release = await readJson(releasePath, { packageVersion: config.packageVersion, tarballs: [] });
  if (release.packageVersion !== config.packageVersion) Object.assign(release, { packageVersion: config.packageVersion, tarballs: [] });
  const record = (item) => {
    release.tarballs = release.tarballs.filter((existing) => existing.package !== item.package).concat(item);
  };

  for (const tool of selectedTools(options)) {
    const manifestPath = join(distDir, `${tool}.manifest.json`);
    const saved = await readJson(manifestPath, null);
    const manifest =
      saved?.packageVersion === config.packageVersion
        ? saved
        : { tool, ffmpegVersion: config.ffmpegVersion, packageVersion: config.packageVersion, aliases: config.aliases, platforms: {} };

    for (const platform of selectedPlatforms(options)) {
      const { release: item, entry } = await packPlatform(tool, platform);
      manifest.platforms[platform] = entry;
      record(item);
    }
    manifest.platforms = Object.fromEntries(
      Object.keys(config.platforms)
        .filter((platform) => manifest.platforms[platform])
        .map((platform) => [platform, manifest.platforms[platform]]),
    );
    await mkdir(distDir, { recursive: true });
    await writeFile(manifestPath, json(manifest));

    const missing = Object.keys(config.platforms).filter((platform) => !manifest.platforms[platform]);
    if (missing.length) console.log(`\n${packageName(tool)} 主包暂不生成，还缺平台：${missing.join('、')}`);
    else record(await packMain(tool, manifest));
  }

  release.tarballs.sort((a, b) => (a.kind === b.kind ? a.package.localeCompare(b.package) : a.kind === 'platform' ? -1 : 1));
  await writeFile(releasePath, json(release));

  console.log(`\n清单：${rel(releasePath)}`);
  console.log('\n发布（先 npm login；先发平台包，再发主包）：');
  for (const item of release.tarballs) console.log(`  npm publish "${rel(join(distDir, item.file))}" --access public`);
  console.log('\n发布后让 npmmirror 立即同步：');
  console.log(`  npx --yes cnpm sync ${release.tarballs.map((item) => item.package).join(' ')}`);
  console.log('\n同步后核对两个源：');
  console.log('  npm run verify');
}

async function commandVerify(options) {
  const release = await readJson(releasePath, null);
  if (!release) throw new Error(`找不到 ${rel(releasePath)}，请先运行 pack`);
  const tools = selectedTools(options);
  const items = release.tarballs.filter(
    (item) => tools.includes(item.tool) && (!options.platform || item.kind === 'main' || item.platform === options.platform),
  );
  let failed = 0;
  for (const item of items) {
    console.log(`\n[${item.package}@${item.version}]`);
    for (const [index, url] of item.urls.entries()) {
      try {
        await download(url, join(cacheDir, 'verify', `${index}-${item.file}`), item, { force: true });
        console.log(`  一致 ${url}`);
      } catch (error) {
        failed += 1;
        console.error(`  失败 ${url}\n    ${error.message}`);
      }
    }
  }
  if (failed) throw new Error(`${failed} 个地址未通过核对`);
  console.log('\n所有源的文件与清单一致。');
}

function commandPlan(options) {
  const downloads = new Map();
  console.log(`FFmpeg ${config.ffmpegVersion}，npm 包版本 ${config.packageVersion}`);
  for (const tool of selectedTools(options)) {
    console.log(`\n${packageName(tool)}`);
    for (const platform of selectedPlatforms(options)) {
      const upstream = config.platforms[platform].upstream[tool];
      downloads.set(upstream.sha256, upstream);
      console.log(`  ${packageName(tool, platform)}  ← ${upstream.provider}  ${upstream.url}（${mib(upstream.size)}）`);
    }
  }
  const total = [...downloads.values()].reduce((sum, upstream) => sum + upstream.size, 0);
  console.log(`\n需下载 ${downloads.size} 个上游文件，共 ${mib(total)}`);
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'plan') commandPlan(options);
  else if (command === 'pack') await commandPack(options);
  else if (command === 'verify') await commandVerify(options);
  else console.log('用法：node scripts/pack.mjs <plan|pack|verify> [--tool ffmpeg|ffprobe] [--platform <平台>]');
} catch (error) {
  console.error(`\n错误：${error.message}`);
  process.exitCode = 1;
}
