export interface PlatformEntry {
  /** npm package that holds this platform's binary, e.g. "@seankit/ffmpeg-win32-x64". */
  package: string;
  version: string;
  /** Tarball file name as published to the registry. */
  file: string;
  /** Tarball size in bytes. */
  size: number;
  /** SHA-256 of the tarball, hex. */
  sha256: string;
  /** npm integrity string (sha512) of the tarball. */
  integrity: string;
  /** Binary path inside the package. Inside the tarball it is prefixed with "package/". */
  binary: string;
  binarySha256: string;
  binarySize: number;
  license: string;
  rustTargets: string[];
  /** Tarball URLs, mirror first. Every URL serves the same file. */
  urls: string[];
}

export interface Manifest {
  tool: 'ffmpeg' | 'ffprobe';
  ffmpegVersion: string;
  packageVersion: string;
  /** Platform keys that reuse another platform's build, e.g. win32-arm64 runs the x64 build. */
  aliases: Record<string, string>;
  platforms: Record<string, PlatformEntry>;
}

/** Absolute path of the binary for the current platform, or null when unavailable. */
export declare const path: string | null;
/** FFmpeg release version of the bundled binaries, e.g. "9.1". */
export declare const version: string;
export declare const manifest: Manifest;
/** Manifest platform key for a Node.js platform and arch, after aliases; null when unsupported. */
export declare function platformKey(platform?: string, arch?: string): string | null;
