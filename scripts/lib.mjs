// 与具体版本无关的打包工具函数，单独放置以便测试。

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, constants as zlibConstants } from 'node:zlib';

// 与 npm pack 相同的固定时间戳，保证同样的输入得到同样的 tarball。
export const TAR_MTIME = Math.floor(Date.parse('1985-10-26T08:15:00Z') / 1000);

export const LICENSE_FILES = {
  'GPL-3.0-or-later': 'COPYING.GPLv3',
  'GPL-2.0-or-later': 'COPYING.GPLv2',
  'LGPL-3.0-or-later': 'COPYING.LGPLv3',
  'LGPL-2.1-or-later': 'COPYING.LGPLv2.1',
};

export async function hashFile(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

export const tarballName = (name, version) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;

export function tarballUrls(registries, name, version) {
  const bare = name.split('/').pop();
  return registries.map((registry) => `${registry.replace(/\/$/, '')}/${name}/-/${bare}-${version}.tgz`);
}

const spdx = (lesser, version) => `${lesser ? 'L' : ''}GPL-${version.includes('.') ? version : `${version}.0`}-or-later`;

// 从 FFmpeg 可执行文件的内容判断许可证，不运行它。
// 优先取 libavutil 的 FFMPEG_LICENSE 字符串（如 "GPL version 3 or later"），取不到时用 -L 输出的许可证文本。
export function detectLicense(text) {
  if (text.includes('not legally redistributable') || text.includes('nonfree and unredistributable')) {
    throw new Error('该构建包含 nonfree 组件，不能再分发');
  }
  const fromMarker = [...text.matchAll(/(L?)GPL version (2\.1|2|3) or later/g)].map(([, lesser, version]) => spdx(lesser, version));
  const fromText = [
    ...text.matchAll(
      /GNU\s+(Lesser\s+)?General\s+Public\s+License\s+as\s+published\s+by\s+the\s+Free\s+Software\s+Foundation;\s+either\s+version\s+(2\.1|2|3)\s+of\s+the\s+License/g,
    ),
  ].map(([, lesser, version]) => spdx(lesser, version));
  const licenses = [...new Set(fromMarker.length ? fromMarker : fromText)];
  if (licenses.length !== 1 || !LICENSE_FILES[licenses[0]]) {
    throw new Error(`无法确定许可证，找到：${licenses.join(' / ') || '无'}`);
  }
  return licenses[0];
}

// FFMPEG_CONFIGURATION 以 NUL 结尾，取包含 "--enable-" 的最长字符串。
export function extractConfiguration(text) {
  let configuration = '';
  for (let index = text.indexOf('--enable-'); index !== -1; index = text.indexOf('--enable-', index + 1)) {
    const start = text.lastIndexOf('\0', index) + 1;
    const end = text.indexOf('\0', index);
    const segment = text.slice(start, end === -1 ? undefined : end);
    if (segment.length > configuration.length) configuration = segment;
    if (end === -1) break;
    index = end;
  }
  return configuration.trim();
}

// ---------- 升级版本用 ----------

// 读取 .sha256 文件：可能只有哈希，也可能是 "<哈希>  文件名"。
export function parseSha256(text) {
  const match = text.trim().match(/^([0-9a-f]{64})(?:\s|$)/i);
  if (!match) throw new Error(`无法解析 SHA-256：${text.trim().slice(0, 80)}`);
  return match[1].toLowerCase();
}

// npm 版本前两位跟随 FFmpeg 主、次版本，第三位只增不减。
export function nextPackageVersion(currentPackage, nextFfmpeg) {
  const [major, minor] = nextFfmpeg.split('.').map(Number);
  const [currentMajor, currentMinor, currentPatch] = currentPackage.split('.').map(Number);
  if (major === currentMajor && minor === currentMinor) return `${major}.${minor}.${currentPatch + 1}`;
  if (major < currentMajor || (major === currentMajor && minor < currentMinor)) {
    throw new Error(`FFmpeg ${nextFfmpeg} 低于当前包版本 ${currentPackage}，请用 --package-version 指定一个更高的版本号`);
  }
  return `${major}.${minor}.0`;
}

// 从 martin-riedl.de 的发布历史页面中找出某版本最新一次构建的编号（同一版本可能重新构建过）。
export function findRiedlRelease(html, os, arch, version) {
  const pattern = new RegExp(`/info/detail/${os}/${arch}/(\\d+)_${version.replaceAll('.', '\\.')}(?=["'<\\s])`, 'g');
  const epochs = [...html.matchAll(pattern)].map((match) => Number(match[1]));
  return epochs.length ? Math.max(...epochs) : null;
}

// ---------- BtbN/FFmpeg-Builds ----------
// BtbN 每天构建一次，只保留最近 14 天和每月最后一次（保留两年）。固定版本时只用每月最后一次构建。

const BTBN_ASSET = /^ffmpeg-n([0-9.]+)(?:-(\d+)-g([0-9a-f]+))?-(linux64|linuxarm64|win64|winarm64)-([a-z]+(?:-[a-z]+)*)-(\d+\.\d+)\.(tar\.xz|zip)$/;

// 解析资产文件名，如 ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0.tar.xz。
export function parseBtbnAsset(name) {
  const match = name.match(BTBN_ASSET);
  if (!match) return null;
  const [, version, commits, commit, target, variant, branch, ext] = match;
  return { version, commits: commits ? Number(commits) : 0, commit: commit ?? null, target, variant, branch, ext };
}

// 从 autobuild 标签中取出每个月最后一次构建，去掉尚未结束的最新月份，按时间从新到旧排列。
export function btbnMonthEndTags(tags) {
  const lastOfMonth = new Map();
  for (const tag of tags) {
    const match = tag.match(/^autobuild-(\d{4}-\d{2})-\d{2}-\d{2}-\d{2}$/);
    if (match && (!lastOfMonth.has(match[1]) || tag > lastOfMonth.get(match[1]))) lastOfMonth.set(match[1], tag);
  }
  const months = [...lastOfMonth.keys()].sort().reverse();
  return months.slice(1).map((month) => lastOfMonth.get(month));
}

// 在 checksums.sha256 中找指定 FFmpeg 版本、平台和变体的资产。
export function findBtbnAsset(checksums, version, { target, variant, ext }) {
  for (const line of checksums.split('\n')) {
    const [sha256, name] = line.trim().split(/\s+\*?/);
    const asset = name && parseBtbnAsset(name);
    if (asset && asset.version === version && asset.target === target && asset.variant === variant && asset.ext === ext) {
      return { name, sha256: sha256.toLowerCase(), ...asset };
    }
  }
  return null;
}

// 两格缩进的 JSON；只含基本类型、且一行放得下的数组写成一行，与手写的 sources.json 格式一致。
export function formatJson(value, width = 80) {
  const text = JSON.stringify(value, null, 2).replace(/^( *)("[^"\n]*": )?\[\n([\s\S]*?)\n\1\]/gm, (whole, indent, key = '', body) => {
    const items = body.split(',\n').map((item) => item.trim());
    if (items.some((item) => item.startsWith('{') || item.startsWith('['))) return whole;
    const line = `${indent}${key}[${items.join(', ')}]`;
    return line.length + 1 <= width ? line : whole;
  });
  return `${text}\n`;
}

// ---------- tarball ----------

export function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512);
  const put = (value, offset, length) => header.write(value, offset, length, 'ascii');
  const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;
  if (Buffer.byteLength(name) > 100) throw new Error(`路径过长：${name}`);
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(TAR_MTIME, 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

async function* tarStream(files) {
  for (const file of files) {
    const { size } = await stat(file.source);
    yield tarHeader(`package/${file.path}`, size, file.mode);
    for await (const chunk of createReadStream(file.source)) yield chunk;
    if (size % 512) yield Buffer.alloc(512 - (size % 512));
  }
  yield Buffer.alloc(1024);
}

// 直接写 ustar + gzip，而不是调用 npm pack：在 Windows 上打包时也能给 macOS/Linux 可执行文件写入 0755，
// 条目顺序和时间戳固定。npm publish <tgz> 发布的就是这个文件本身。
// files: [{ path: 'bin/ffmpeg', source: 绝对路径, mode: 0o755 }]，package.json 排在最前。
export async function writeTarball(files, outFile) {
  await mkdir(dirname(outFile), { recursive: true });
  // 按码点排序，不用 localeCompare，避免不同机器的区域设置导致条目顺序不同。
  const order = (file) => (file.path === 'package.json' ? '' : file.path);
  const sorted = [...files].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  await pipeline(
    Readable.from(tarStream(sorted), { objectMode: false }),
    createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }),
    createWriteStream(outFile),
  );
  return {
    size: (await stat(outFile)).size,
    sha256: await hashFile(outFile),
    integrity: `sha512-${await hashFile(outFile, 'sha512', 'base64')}`,
  };
}
