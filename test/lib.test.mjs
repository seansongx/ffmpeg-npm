import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { detectLicense, extractConfiguration, TAR_MTIME, tarballName, tarballUrls, writeTarball } from '../scripts/lib.mjs';

function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('ascii').replace(/\0.*$/s, '').trim();
    const stored = parseInt(field(148, 8), 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    const sum = copy.reduce((total, byte) => total + byte, 0);
    const size = parseInt(field(124, 12), 8);
    entries.push({
      name: field(0, 100),
      mode: parseInt(field(100, 8), 8),
      size,
      mtime: parseInt(field(136, 12), 8),
      type: field(156, 1),
      magic: header.subarray(257, 263).toString('ascii'),
      checksumOk: stored === sum,
      data: buffer.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('writeTarball', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'seankit-tar-'));
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'package.json'), '{"name":"@seankit/demo","version":"1.0.0"}\n');
    await writeFile(join(dir, 'README.md'), '# demo\n');
    await writeFile(join(dir, 'bin', 'ffmpeg'), Buffer.alloc(1000, 7));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const files = () => [
    { path: 'README.md', source: join(dir, 'README.md'), mode: 0o644 },
    { path: 'bin/ffmpeg', source: join(dir, 'bin', 'ffmpeg'), mode: 0o755 },
    { path: 'package.json', source: join(dir, 'package.json'), mode: 0o644 },
  ];

  it('writes package.json first under package/ with valid ustar headers', async () => {
    const out = join(dir, 'out', 'a.tgz');
    await writeTarball(files(), out);
    const entries = readTar(gunzipSync(await readFile(out)));
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['package/package.json', 'package/README.md', 'package/bin/ffmpeg'],
    );
    for (const entry of entries) {
      assert.equal(entry.checksumOk, true, entry.name);
      assert.equal(entry.type, '0');
      assert.equal(entry.magic, 'ustar\0');
      assert.equal(entry.mtime, TAR_MTIME);
    }
  });

  it('keeps the executable mode for binaries and file contents intact', async () => {
    const out = join(dir, 'out', 'b.tgz');
    await writeTarball(files(), out);
    const entries = readTar(gunzipSync(await readFile(out)));
    const binary = entries.find((entry) => entry.name === 'package/bin/ffmpeg');
    assert.equal(binary.mode, 0o755);
    assert.deepEqual(binary.data, Buffer.alloc(1000, 7));
    assert.equal(entries.find((entry) => entry.name === 'package/README.md').mode, 0o644);
  });

  it('produces identical tarballs for identical input', async () => {
    const first = await writeTarball(files(), join(dir, 'out', 'c.tgz'));
    const second = await writeTarball(files(), join(dir, 'out', 'd.tgz'));
    assert.equal(first.sha256, second.sha256);
    assert.match(first.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  });
});

describe('detectLicense', () => {
  it('reads the FFMPEG_LICENSE marker', () => {
    assert.equal(detectLicense('abc\0GPL version 3 or later\0xyz'), 'GPL-3.0-or-later');
    assert.equal(detectLicense('\0GPL version 2 or later\0'), 'GPL-2.0-or-later');
  });

  it('does not mistake LGPL markers for GPL', () => {
    assert.equal(detectLicense('\0LGPL version 3 or later\0'), 'LGPL-3.0-or-later');
    assert.equal(detectLicense('\0LGPL version 2.1 or later\0'), 'LGPL-2.1-or-later');
  });

  it('falls back to the -L license text', () => {
    const gpl3 =
      '%s is free software; you can redistribute it and/or modify\nit under the terms of the GNU General Public License as published by\nthe Free Software Foundation; either version 3 of the License, or\n(at your option) any later version.\n';
    const lgpl21 =
      '%s is free software; you can redistribute it and/or\nmodify it under the terms of the GNU Lesser General Public\nLicense as published by the Free Software Foundation; either\nversion 2.1 of the License, or (at your option) any later version.\n';
    assert.equal(detectLicense(gpl3), 'GPL-3.0-or-later');
    assert.equal(detectLicense(lgpl21), 'LGPL-2.1-or-later');
  });

  it('rejects nonfree builds and unknown licenses', () => {
    assert.throws(() => detectLicense('This version of %s has nonfree parts compiled in.\nTherefore it is not legally redistributable.\n'), /nonfree/);
    assert.throws(() => detectLicense('no license here'), /无法确定许可证/);
    assert.throws(() => detectLicense('GPL version 3 or later\0GPL version 2 or later'), /无法确定许可证/);
  });
});

describe('extractConfiguration', () => {
  it('returns the longest NUL-terminated string with --enable- flags', () => {
    const text = '\0use --enable-foo\0--prefix=/opt --enable-gpl --enable-libx264 --enable-libmp3lame\0tail';
    assert.equal(extractConfiguration(text), '--prefix=/opt --enable-gpl --enable-libx264 --enable-libmp3lame');
  });
});

describe('tarball naming', () => {
  it('matches the npm registry layout', () => {
    assert.equal(tarballName('@seankit/ffmpeg-win32-x64', '9.1.0'), 'seankit-ffmpeg-win32-x64-9.1.0.tgz');
    assert.deepEqual(tarballUrls(['https://registry.npmmirror.com/', 'https://registry.npmjs.org'], '@seankit/ffmpeg', '9.1.0'), [
      'https://registry.npmmirror.com/@seankit/ffmpeg/-/ffmpeg-9.1.0.tgz',
      'https://registry.npmjs.org/@seankit/ffmpeg/-/ffmpeg-9.1.0.tgz',
    ]);
  });
});
