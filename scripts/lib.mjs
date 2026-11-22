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
