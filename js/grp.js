// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.196';

// uDuke - GRP archive reader (Ken Silverman group file).
// See FORMATS.md section 1.

const MAGIC = 'KenSilverman';

/**
 * Read a GRP archive.
 * Entries are zero-copy Uint8Array views into the supplied buffer, so the
 * caller must keep the buffer alive for as long as the entries are used.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{entries: Map<string, Uint8Array>, order: string[]}}
 */
export function readGrp(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 16) throw new Error('GRP: file too short');

  let magic = '';
  for (let i = 0; i < 12; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== MAGIC) throw new Error(`GRP: bad magic "${magic}"`);

  const view = new DataView(buffer);
  const numFiles = view.getInt32(12, true);
  if (numFiles < 0 || numFiles > 0x100000) {
    throw new Error(`GRP: implausible file count ${numFiles}`);
  }

  const dirEnd = 16 + numFiles * 16;
  if (dirEnd > bytes.length) throw new Error('GRP: directory truncated');

  const entries = new Map();
  const order = [];
  let offset = dirEnd;

  for (let i = 0; i < numFiles; i++) {
    const base = 16 + i * 16;
    let name = '';
    for (let c = 0; c < 12; c++) {
      const ch = bytes[base + c];
      if (ch === 0 || ch === 0x20) break;
      name += String.fromCharCode(ch);
    }
    const size = view.getInt32(base + 12, true);
    if (size < 0 || offset + size > bytes.length) {
      throw new Error(`GRP: entry "${name}" overruns file`);
    }
    entries.set(name.toUpperCase(), bytes.subarray(offset, offset + size));
    order.push(name.toUpperCase());
    offset += size;
  }

  return { entries, order };
}

/** Fetch one entry or throw with a useful message. */
export function grpEntry(grp, name) {
  const e = grp.entries.get(name.toUpperCase());
  if (!e) throw new Error(`GRP: no such entry "${name}"`);
  return e;
}

/** All entries whose name matches a suffix, e.g. '.MAP'. Preserves GRP order. */
export function grpByExtension(grp, ext) {
  const want = ext.toUpperCase();
  return grp.order.filter((n) => n.endsWith(want));
}
