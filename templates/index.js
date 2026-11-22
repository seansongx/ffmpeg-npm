'use strict';

const manifest = require('./manifest.json');

function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const resolved = manifest.aliases[key] ?? key;
  return manifest.platforms[resolved] ? resolved : null;
}

function resolveBinary() {
  const key = platformKey();
  if (!key) return null;
  const entry = manifest.platforms[key];
  try {
    return require.resolve(`${entry.package}/${entry.binary}`);
  } catch {
    return null;
  }
}

module.exports = {
  path: resolveBinary(),
  version: manifest.ffmpegVersion,
  manifest,
  platformKey,
};
