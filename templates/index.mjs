import { createRequire } from 'node:module';

const api = createRequire(import.meta.url)('./index.js');

export const path = api.path;
export const version = api.version;
export const manifest = api.manifest;
export const platformKey = api.platformKey;
