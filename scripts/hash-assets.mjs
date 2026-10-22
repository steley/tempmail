#!/usr/bin/env node
/**
 * Asset fingerprinting without a build system.
 *
 * The HTML pages reference /js/app.js?v=… and /css/modern.css?v=… with a
 * hand-maintained version string. That is the cache-bust equivalent of a
 * comment: someone forgets to bump it and users run stale code for 30 days
 * behind immutable CDN caching. This script replaces the version query with
 * the first 8 hex chars of the asset's SHA-256, so every content change
 * produces a new URL automatically.
 *
 * Run before every deploy:
 *   node scripts/hash-assets.mjs
 * Exit code 0 even when nothing changed, 1 on I/O errors.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// assets whose ?v= stamp is content-derived
const ASSETS = ['/js/app.js', '/css/modern.css', '/logo.svg', '/logo.png', '/favicon.png'];

// every .html under public/, including subdirectories such as /for/
const htmlFiles = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.html'));

let changed = 0;
for (const asset of ASSETS) {
  const hash = createHash('sha256')
    .update(await readFile(path.join(root, asset)))
    .digest('hex')
    .slice(0, 8);
  // Match whatever is currently after ?v=, not just hex. The hand-written
  // stamps in the HTML are arbitrary strings ("del3"): a hex-only class would
  // replace just the leading "de" and leave "l3" behind, producing "?v=<hash>l3".
  const pattern = new RegExp(`(${asset.replace(/[/.]/g, '\\$&')}\\?v=)[^"']*`);
  for (const file of htmlFiles) {
    const file_ = path.join(root, file);
    const html = await readFile(file_, 'utf8');
    const next = html.replace(pattern, `$1${hash}`);
    if (next !== html) {
      await writeFile(file_, next);
      changed++;
      console.log(`${file}: ${asset} -> ?v=${hash}`);
    }
  }
}
console.log(changed === 0 ? 'all fingerprints up to date' : `${changed} reference(s) updated`);
