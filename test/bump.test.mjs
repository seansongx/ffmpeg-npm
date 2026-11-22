import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  btbnMonthEndTags,
  findBtbnAsset,
  findRiedlRelease,
  formatJson,
  nextPackageVersion,
  parseBtbnAsset,
  parseSha256,
} from '../scripts/lib.mjs';

const HASH = '1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1';

describe('parseSha256', () => {
  it('accepts a bare hash or sha256sum output', () => {
    assert.equal(parseSha256(`${HASH}\n`), HASH);
    assert.equal(parseSha256(`${HASH}  ffmpeg.zip\n`), HASH);
    assert.equal(parseSha256(HASH.toUpperCase()), HASH);
  });

  it('rejects anything else', () => {
    assert.throws(() => parseSha256('<html>Not Found</html>'), /无法解析/);
    assert.throws(() => parseSha256(`${HASH}abc`), /无法解析/);
  });
});

describe('nextPackageVersion', () => {
  it('bumps the revision within the same FFmpeg minor version', () => {
    assert.equal(nextPackageVersion('9.1.0', '9.1.1'), '9.1.1');
    assert.equal(nextPackageVersion('9.1.3', '9.1.2'), '9.1.4');
  });

  it('starts at .0 for a new minor or major version', () => {
    assert.equal(nextPackageVersion('9.1.4', '9.2'), '9.2.0');
    assert.equal(nextPackageVersion('9.2.1', '10.0'), '10.0.0');
  });

  it('refuses to go backwards', () => {
    assert.throws(() => nextPackageVersion('9.1.0', '9.0.2'), /--package-version/);
  });
});

describe('findRiedlRelease', () => {
  const html = `
    <a href="/info/detail/macos/arm64/1789931890_9.0.2">9.0.2</a>
    <a href="/info/detail/macos/arm64/1795207104_9.1">9.1</a>
    <a href="/info/detail/macos/arm64/1795300000_9.1">9.1</a>
    <a href="/info/detail/macos/arm64/1796000000_9.1.1">9.1.1</a>
    <a href="/info/detail/linux/arm64/1795204341_9.1">9.1</a>`;

  it('picks the newest build of the exact version', () => {
    assert.equal(findRiedlRelease(html, 'macos', 'arm64', '9.1'), 1795300000);
    assert.equal(findRiedlRelease(html, 'macos', 'arm64', '9.1.1'), 1796000000);
    assert.equal(findRiedlRelease(html, 'linux', 'arm64', '9.1'), 1795204341);
  });

  it('returns null when the version or platform is missing', () => {
    assert.equal(findRiedlRelease(html, 'macos', 'arm64', '9.2'), null);
    assert.equal(findRiedlRelease(html, 'macos', 'amd64', '9.1'), null);
    assert.equal(findRiedlRelease(html, 'macos', 'arm64', '9'), null);
  });
});

describe('BtbN builds', () => {
  it('parses branch and tag asset names', () => {
    assert.deepEqual(parseBtbnAsset('ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0.tar.xz'), {
      version: '9.0.2',
      commits: 39,
      commit: '7adfbe40dc',
      target: 'linux64',
      variant: 'gpl',
      branch: '9.0',
      ext: 'tar.xz',
    });
    assert.equal(parseBtbnAsset('ffmpeg-n9.0.2-winarm64-gpl-shared-9.0.zip').variant, 'gpl-shared');
    assert.equal(parseBtbnAsset('ffmpeg-master-latest-linux64-gpl.tar.xz'), null);
  });

  it('keeps only the last build of each finished month, newest first', () => {
    const tags = [
      'autobuild-2026-11-22-12-36',
      'autobuild-2026-11-21-12-37',
      'autobuild-2026-10-31-12-59',
      'autobuild-2026-10-30-12-50',
      'autobuild-2026-09-29-12-40',
      'latest',
    ];
    assert.deepEqual(btbnMonthEndTags(tags), ['autobuild-2026-10-31-12-59', 'autobuild-2026-09-29-12-40']);
  });

  it('finds the matching asset in checksums.sha256', () => {
    const checksums = [
      `${'a'.repeat(64)}  ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-lgpl-9.0.tar.xz`,
      `${'b'.repeat(64)}  ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0.tar.xz`,
      `${'c'.repeat(64)}  ffmpeg-n9.0.2-39-g7adfbe40dc-linuxarm64-gpl-9.0.tar.xz`,
      `${'d'.repeat(64)}  ffmpeg-N-129219-g359c825152-linux64-gpl.tar.xz`,
    ].join('\n');
    const wanted = { target: 'linux64', variant: 'gpl', ext: 'tar.xz' };
    assert.equal(findBtbnAsset(checksums, '9.0.2', wanted).sha256, 'b'.repeat(64));
    assert.equal(findBtbnAsset(checksums, '9.0.2', { ...wanted, target: 'linuxarm64' }).sha256, 'c'.repeat(64));
    assert.equal(findBtbnAsset(checksums, '9.1', wanted), null);
  });
});

describe('formatJson', () => {
  it('reproduces the hand-written sources.json exactly', async () => {
    const text = await readFile(new URL('../sources.json', import.meta.url), 'utf8');
    assert.equal(formatJson(JSON.parse(text)), text.replace(/\r\n/g, '\n'));
  });

  it('keeps long or nested arrays on multiple lines', () => {
    assert.equal(formatJson({ a: [1, 2] }), '{\n  "a": [1, 2]\n}\n');
    assert.equal(formatJson({ a: [{ b: 1 }] }), '{\n  "a": [\n    {\n      "b": 1\n    }\n  ]\n}\n');
    assert.equal(formatJson({ a: ['x'.repeat(40), 'y'.repeat(40)] }).split('\n').length, 7);
  });
});
