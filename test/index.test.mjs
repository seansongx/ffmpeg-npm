import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

const templates = new URL('../templates/', import.meta.url);
const hostKey = `${process.platform}-${process.arch}`;
const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const dirs = [];

// 在临时目录里搭一个 node_modules：主包 + 可选的当前平台包。
async function install({ withPlatformPackage }) {
  const dir = await mkdtemp(join(tmpdir(), 'seankit-index-'));
  dirs.push(dir);
  const main = join(dir, 'node_modules', '@seankit', 'ffmpeg');
  await mkdir(main, { recursive: true });
  for (const file of ['index.js', 'index.mjs']) await copyFile(new URL(file, templates), join(main, file));
  const manifest = {
    tool: 'ffmpeg',
    ffmpegVersion: '9.1',
    packageVersion: '9.1.0',
    aliases: { 'win32-arm64': 'win32-x64' },
    platforms: {
      'win32-x64': { package: '@seankit/ffmpeg-win32-x64', binary: 'bin/ffmpeg.exe' },
      [hostKey]: { package: `@seankit/ffmpeg-${hostKey}`, binary: `bin/${binaryName}` },
    },
  };
  await writeFile(join(main, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(main, 'package.json'), JSON.stringify({ name: '@seankit/ffmpeg', version: '9.1.0', main: 'index.js' }));

  let binary = null;
  if (withPlatformPackage) {
    const platformDir = join(dir, 'node_modules', '@seankit', `ffmpeg-${hostKey}`);
    await mkdir(join(platformDir, 'bin'), { recursive: true });
    await writeFile(join(platformDir, 'package.json'), JSON.stringify({ name: `@seankit/ffmpeg-${hostKey}`, version: '9.1.0' }));
    binary = join(platformDir, 'bin', binaryName);
    await writeFile(binary, 'fake');
  }
  return { require: createRequire(join(dir, 'app.js')), main, binary };
}

after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('main package entry', () => {
  it('resolves the binary from the installed platform package', async () => {
    const { require, binary } = await install({ withPlatformPackage: true });
    const api = require('@seankit/ffmpeg');
    assert.equal(api.path, binary);
    assert.equal(api.version, '9.1');
  });

  it('returns null when the platform package is missing', async () => {
    const { require } = await install({ withPlatformPackage: false });
    assert.equal(require('@seankit/ffmpeg').path, null);
  });

  it('maps Windows on ARM to the x64 build and rejects unknown platforms', async () => {
    const { require } = await install({ withPlatformPackage: false });
    const { platformKey } = require('@seankit/ffmpeg');
    assert.equal(platformKey('win32', 'arm64'), 'win32-x64');
    assert.equal(platformKey('win32', 'x64'), 'win32-x64');
    assert.equal(platformKey('freebsd', 'x64'), null);
  });

  it('exposes the same values through the ESM entry', async () => {
    const { main, binary } = await install({ withPlatformPackage: true });
    const esm = await import(pathToFileURL(join(main, 'index.mjs')).href);
    assert.equal(esm.path, binary);
    assert.equal(esm.version, '9.1');
    assert.equal(typeof esm.platformKey, 'function');
  });
});
