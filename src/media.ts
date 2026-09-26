import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from './logger.js';
import { mediaDir } from './paths.js';
import type { ImageRef } from './types.js';

const log = createLogger('media');

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/avif': 'avif',
};

export interface FetchedImage {
  bytes: Buffer;
  mime: string;
  sha1: string;
  /** content-addressed path on disk (may be reused from cache) */
  filePath: string;
}

function sniffMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

function normalizeMime(raw: string | undefined | null, bytes: Buffer): string {
  const fromHeader = raw?.split(';')[0]?.trim().toLowerCase();
  if (fromHeader && fromHeader.startsWith('image/')) return fromHeader;
  return sniffMime(bytes) ?? 'image/jpeg';
}

function extensionFor(mime: string, sourceName?: string): string {
  const byMime = EXT_BY_MIME[mime];
  if (byMime) return byMime;
  const ext = sourceName ? path.extname(sourceName).replace('.', '').toLowerCase() : '';
  return ext && /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'bin';
}

/**
 * Downloads (or reads) an image and stores it content-addressed on disk.
 * Returns null when the image cannot be obtained or exceeds `maxBytes`.
 */
export async function fetchAndStoreImage(
  ref: ImageRef,
  getImageUrl: (file: string) => Promise<string | null>,
  maxBytes: number,
): Promise<FetchedImage | null> {
  const source = await resolveSource(ref, getImageUrl);
  if (!source) {
    log.warn('image source unavailable (file=%s)', ref.file);
    return null;
  }

  let bytes: Buffer;
  let rawMime: string | null = null;
  try {
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rawMime = res.headers.get('content-type');
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > maxBytes) {
        log.warn('image too large (declared %d > %d)', declared, maxBytes);
        return null;
      }
      bytes = Buffer.from(await res.arrayBuffer());
    } else {
      bytes = await fsp.readFile(source);
    }
  } catch (e) {
    log.warn('image fetch failed: %s', (e as Error).message);
    return null;
  }

  if (bytes.length === 0) return null;
  if (bytes.length > maxBytes) {
    log.warn('image too large (%d > %d)', bytes.length, maxBytes);
    return null;
  }

  const mime = normalizeMime(rawMime, bytes);
  const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
  const ext = extensionFor(mime, ref.file || source);
  const bucket = new Date().toISOString().slice(0, 7);
  const dir = path.join(mediaDir, bucket);
  const filePath = path.join(dir, `${sha1}.${ext}`);

  if (!fs.existsSync(filePath)) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, filePath);
  }

  return { bytes, mime, sha1, filePath };
}

async function resolveSource(
  ref: ImageRef,
  getImageUrl: (file: string) => Promise<string | null>,
): Promise<string | null> {
  if (ref.url && /^https?:\/\//i.test(ref.url)) return ref.url;
  if (ref.file && /^https?:\/\//i.test(ref.file)) return ref.file;
  if (ref.file && fs.existsSync(ref.file)) return ref.file;
  if (ref.file) {
    const url = await getImageUrl(ref.file);
    if (url) return url;
  }
  if (ref.url) return ref.url;
  return null;
}

export function toDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export async function readAsDataUrl(filePath: string, mime: string): Promise<string | null> {
  try {
    const bytes = await fsp.readFile(filePath);
    return toDataUrl(bytes, mime);
  } catch {
    return null;
  }
}

/** Removes media files older than `keepDays`. */
export function pruneMediaFiles(keepDays: number): void {
  const cutoff = Date.now() - keepDays * 86_400_000;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try {
          if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } catch {
          /* ignore */
        }
      } else if (entry.isFile()) {
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(mediaDir);
}
