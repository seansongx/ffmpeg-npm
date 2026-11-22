#!/usr/bin/env node
// 发布 dist/ 中 npm run pack 生成的 tarball，供 GitHub Actions 使用，也可在本机运行。
//
//   node scripts/publish.mjs publish        按 release.json 顺序发布（先平台包，后主包），已发布的版本跳过
//   node scripts/publish.mjs wait-mirror    等 npmmirror 能下载到全部 tarball，最多 30 分钟
//
// 发布需要 NODE_AUTH_TOKEN（GitHub Actions 中来自仓库密钥 NPM_TOKEN）。在 GitHub Actions 中会附带来源证明（provenance）。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const releasePath = join(distDir, 'release.json');
const isWindows = process.platform === 'win32';

function npm(args, options = {}) {
  return spawnSync(isWindows ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: isWindows, ...options });
}

async function readRelease() {
  if (!existsSync(releasePath)) throw new Error('找不到 dist/release.json，请先运行 npm run pack');
  return JSON.parse(await readFile(releasePath, 'utf8'));
}

function isPublished(item) {
  const result = npm(['view', `${item.package}@${item.version}`, 'version', '--json']);
  return result.status === 0 && result.stdout.trim() !== '';
}

async function commandPublish() {
  if (process.env.GITHUB_ACTIONS === 'true' && !process.env.NODE_AUTH_TOKEN) {
    throw new Error('缺少 NODE_AUTH_TOKEN：请在仓库 Settings → Secrets and variables → Actions 中添加 NPM_TOKEN');
  }
  const release = await readRelease();
  const provenance = process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : [];
  for (const item of release.tarballs) {
    const label = `${item.package}@${item.version}`;
    if (isPublished(item)) {
      console.log(`跳过 ${label}：已发布`);
      continue;
    }
    console.log(`发布 ${label}`);
    const result = npm(['publish', join(distDir, item.file), '--access', 'public', ...provenance], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`发布 ${label} 失败，退出码 ${result.status}`);
  }
  console.log('全部发布完成。');
}

function mirrorReady(url) {
  const result = spawnSync('curl', ['-fsSIL', '--max-time', '60', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', url]);
  return result.status === 0;
}

async function commandWaitMirror() {
  const release = await readRelease();
  const pending = new Map(release.tarballs.map((item) => [item.package, item.urls[0]]));
  const deadline = Date.now() + 30 * 60_000;
  while (pending.size) {
    for (const [name, url] of pending) if (mirrorReady(url)) pending.delete(name);
    if (!pending.size) break;
    if (Date.now() > deadline) throw new Error(`npmmirror 30 分钟内仍未同步：${[...pending.keys()].join('、')}`);
    console.log(`等待 npmmirror 同步：还剩 ${pending.size} 个包`);
    await sleep(30_000);
  }
  console.log('npmmirror 已能下载全部 tarball。');
}

try {
  const command = process.argv[2];
  if (command === 'publish') await commandPublish();
  else if (command === 'wait-mirror') await commandWaitMirror();
  else console.log('用法：node scripts/publish.mjs <publish|wait-mirror>');
} catch (error) {
  console.error(`\n错误：${error.message}`);
  process.exitCode = 1;
}
