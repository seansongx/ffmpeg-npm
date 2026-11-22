#!/usr/bin/env node
// 把 sources.json 升级到新的 FFmpeg 版本：沿用每个平台现有的上游来源，查找该版本的文件，
// 读取上游发布的 SHA-256 和文件大小后写回。改完后照常 npm run pack、发布、核对。
//
//   npm run bump -- <FFmpeg 版本> [--package-version x.y.z] [--dry-run]
//
// 例：npm run bump -- 9.1.1            FFmpeg 9.1.1，npm 包版本自动加一
//     npm run bump -- 9.2 --dry-run    只显示会改成什么，不写文件

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRiedlRelease, formatJson, nextPackageVersion, parseSha256 } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcesPath = join(root, 'sources.json');

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--package-version') options.packageVersion = argv[(i += 1)];
    else if (!options.version && !argv[i].startsWith('-')) options.version = argv[i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!options.version) throw new Error('用法：npm run bump -- <FFmpeg 版本> [--package-version x.y.z] [--dry-run]');
  if (!/^\d+\.\d+(\.\d+)?$/.test(options.version)) throw new Error(`FFmpeg 版本格式不对：${options.version}（例：9.1 或 9.1.1）`);
  if (options.packageVersion && !/^\d+\.\d+\.\d+$/.test(options.packageVersion)) {
    throw new Error(`npm 包版本格式不对：${options.packageVersion}（例：9.1.2）`);
  }
  return options;
}

// 用 curl 访问上游：遵循系统代理环境变量，与打包脚本一致。
function curl(args) {
  const result = spawnSync('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '20', '--max-time', '90', ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function fetchText(url) {
  const result = curl([url]);
  if (result.status !== 0) throw new Error(`无法访问（curl 退出码 ${result.status}）：${url}`);
  return result.stdout;
}

function fetchSize(url) {
  const result = curl(['-I', url]);
  if (result.status !== 0) throw new Error(`文件不存在或无法访问（curl 退出码 ${result.status}）：${url}`);
  const lengths = [...result.stdout.matchAll(/^content-length:\s*(\d+)/gim)].map((match) => Number(match[1]));
  if (!lengths.length) throw new Error(`取不到文件大小：${url}`);
  return lengths.at(-1);
}

// 每个上游来源如何找到指定版本的文件。新增来源时在这里加一项。
const resolvers = {
  'gyan.dev'(upstream, version) {
    const match = upstream.url.match(/\/packages\/ffmpeg-[^/]+?-([a-z]+_build\.(?:7z|zip))$/);
    if (!match) throw new Error(`无法识别 gyan.dev 地址：${upstream.url}`);
    return `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${version}-${match[1]}`;
  },
  'ffmpeg.martin-riedl.de'(upstream, version, pages) {
    const match = upstream.url.match(/\/download\/([a-z]+)\/([a-z0-9]+)\/\d+_[^/]+\/([^/]+)$/);
    if (!match) throw new Error(`无法识别 martin-riedl.de 地址：${upstream.url}`);
    const [, os, arch, file] = match;
    const key = `${os}/${arch}`;
    if (!pages.has(key)) pages.set(key, fetchText(`https://ffmpeg.martin-riedl.de/info/history/${key}/release`));
    const epoch = findRiedlRelease(pages.get(key), os, arch, version);
    if (!epoch) throw new Error(`martin-riedl.de 没有 ${key} 的 ${version} 正式版，需要等它发布或换用其他上游`);
    return `https://ffmpeg.martin-riedl.de/download/${key}/${epoch}_${version}/${file}`;
  },
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const { version } = options;
  if (version === config.ffmpegVersion && !options.packageVersion) {
    throw new Error(`已经是 FFmpeg ${version}。只重新打包同一版本时，用 --package-version 指定新的包版本`);
  }
  const packageVersion = options.packageVersion ?? nextPackageVersion(config.packageVersion, version);

  console.log(`FFmpeg ${config.ffmpegVersion} → ${version}，npm 包 ${config.packageVersion} → ${packageVersion}\n`);

  const sourceTarball = `https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`;
  const licenseBaseUrl = `https://raw.githubusercontent.com/FFmpeg/FFmpeg/n${version}/`;
  try {
    fetchSize(sourceTarball);
  } catch {
    throw new Error(`ffmpeg.org 上没有 FFmpeg ${version} 的源代码，请确认该版本已经发布：${sourceTarball}`);
  }
  fetchSize(`${licenseBaseUrl}COPYING.GPLv3`);
  console.log(`源代码 ${sourceTarball}`);
  console.log(`许可证 ${licenseBaseUrl}\n`);

  const pages = new Map();
  const resolved = new Map();
  for (const [platform, spec] of Object.entries(config.platforms)) {
    for (const [tool, upstream] of Object.entries(spec.upstream)) {
      const resolver = resolvers[upstream.provider];
      if (!resolver) throw new Error(`${platform} ${tool} 的上游 ${upstream.provider} 不支持自动升级，请手动修改 sources.json`);
      const url = resolver(upstream, version, pages);
      if (!resolved.has(url)) resolved.set(url, { sha256: parseSha256(fetchText(`${url}.sha256`)), size: fetchSize(url) });
      spec.upstream[tool] = { ...upstream, url, ...resolved.get(url) };
      console.log(`${`${platform} ${tool}`.padEnd(22)} ${url}`);
      console.log(`${''.padEnd(22)} ${resolved.get(url).sha256}  ${(resolved.get(url).size / 1024 / 1024).toFixed(1)} MiB`);
    }
  }

  Object.assign(config, { ffmpegVersion: version, packageVersion, sourceTarball, licenseBaseUrl });
  if (options.dryRun) {
    console.log('\n--dry-run：未写入 sources.json');
    return;
  }
  await writeFile(sourcesPath, formatJson(config));
  console.log('\n已写入 sources.json。下一步：检查改动后 npm run pack，再按输出发布并 npm run verify。');
}

main().catch((error) => {
  console.error(`\n错误：${error.message}`);
  process.exitCode = 1;
});
