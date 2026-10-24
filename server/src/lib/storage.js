// Where media lives on disk. Everything goes through here so that moving
// renditions elsewhere later (R2) touches one module.
//
// The database stores *keys*, paths relative to MEDIA_DIR, never absolute paths:
//   originals/<yyyy>/<mm>/<id>.<ext>    never served
//   renditions/<id>/<name>.<ext>        served by /media (voice notes use their own id)
//   uploads/                            tus scratch space
//   backups/                            the worker's nightly database snapshots
//
// In production MEDIA_DIR is the Seagate drive. A sentinel file there
// (MEDIA_SENTINEL, ".gma-media") proves the drive is mounted: init() refuses
// to create anything without it, so an unplugged drive can't mean photos
// quietly written to the SSD under an empty mount point.

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class UnsafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

export class MediaNotMountedError extends Error {
  constructor(root, sentinel) {
    super(
      `The media folder ${root} has no ${sentinel} file, so the photo drive looks unplugged or unmounted. ` +
        `Nothing was written. Mount the drive (or, for a brand-new empty media folder, create ${path.join(root, sentinel)}) and start again.`,
    );
    this.name = 'MediaNotMountedError';
    this.code = 'media_not_mounted';
    this.root = root;
    this.sentinel = sentinel;
  }
}

// Throws MediaNotMountedError unless <mediaDir>/<sentinel> exists. No sentinel
// configured (development and tests) means no check.
export function assertMediaMounted(mediaDir, sentinel) {
  if (!sentinel) return;
  const root = path.resolve(mediaDir);
  if (!fsSync.existsSync(safeJoin(root, sentinel))) throw new MediaNotMountedError(root, sentinel);
}

// Joins `parts` under `root` and refuses anything that would escape it.
export function safeJoin(root, ...parts) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts.map(String));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new UnsafePathError(`Path escapes ${base}`);
  }
  return target;
}

function segment(value, what) {
  const s = String(value);
  if (!SAFE_SEGMENT.test(s) || s.includes('..')) throw new UnsafePathError(`Unsafe ${what}: ${s}`);
  return s;
}

function extension(ext) {
  const clean = String(ext).replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(clean)) throw new UnsafePathError(`Unsafe extension: ${ext}`);
  return clean;
}

// Options: `sentinel` (config.mediaSentinel): init() checks it first.
export function createStorage(mediaDir, { sentinel = '' } = {}) {
  const root = path.resolve(mediaDir);
  const dirs = {
    originals: path.join(root, 'originals'),
    renditions: path.join(root, 'renditions'),
    uploads: path.join(root, 'uploads'),
    backups: path.join(root, 'backups'),
  };

  return {
    root,
    sentinel,
    originalsDir: dirs.originals,
    renditionsDir: dirs.renditions,
    uploadsDir: dirs.uploads,
    backupsDir: dirs.backups,

    // False when the sentinel has gone (the drive dropped or was unplugged
    // while running). Always true when no sentinel is configured.
    isMounted() {
      if (!sentinel) return true;
      try {
        return fsSync.existsSync(safeJoin(root, sentinel));
      } catch {
        return false;
      }
    },

    async init() {
      assertMediaMounted(root, sentinel);
      await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
    },

    originalKey(id, ext, createdAt = Date.now()) {
      const d = new Date(createdAt);
      const yyyy = String(d.getUTCFullYear());
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      return ['originals', yyyy, mm, `${segment(id, 'id')}.${extension(ext)}`].join('/');
    },

    renditionKey(id, name, ext) {
      return ['renditions', segment(id, 'id'), `${segment(name, 'name')}.${extension(ext)}`].join('/');
    },

    // Absolute path for a stored key. Throws UnsafePathError on traversal.
    resolve(key) {
      if (typeof key !== 'string' || key === '' || path.isAbsolute(key)) {
        throw new UnsafePathError('A media key must be a relative path');
      }
      return safeJoin(root, key);
    },

    async ensureDirFor(key) {
      const abs = this.resolve(key);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      return abs;
    },

    // A temp path next to the final file: write there, then rename into place.
    tempPathFor(key) {
      return `${this.resolve(key)}.tmp-${randomBytes(6).toString('hex')}`;
    },

    async remove(key) {
      if (!key) return;
      await fs.rm(this.resolve(key), { force: true });
    },

    async removeRenditions(id) {
      await fs.rm(safeJoin(dirs.renditions, segment(id, 'id')), { recursive: true, force: true });
    },
  };
}
