/**
 * Build the uploadable mini-tool zip. Dev-only helper, not shipped.
 *
 *   node dev/pack.mjs
 *
 * Rules it enforces (XHS-MINITOOL-BRIEF.md):
 *   - index.html sits at the zip ROOT, no wrapper folder
 *   - only runtime files are packaged (allowlist, never a denylist)
 *   - no dev/, tests/, node_modules/, .git, screenshots, README
 *   - total uncompressed size <= 2 MiB (soft) with a 10 MiB hard stop
 *
 * The zip is written by hand so the output is byte-reproducible and the manifest
 * is explicit; dev/check.mjs + a real unzip are used to verify the result.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const distDir = join(root, 'dist');
const outFile = join(distDir, 'cleanframe-xhs.zip');

const SOFT_LIMIT = 2 * 1024 * 1024;
const HARD_LIMIT = 10 * 1024 * 1024;

// Allowlist: everything the runtime actually loads.
const ALLOW = [/^index\.html$/, /^assets\/[^/]+\.(js|css)$/];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...collect(full));
    else out.push(full);
  }
  return out;
}

// Fixed timestamp keeps the build byte-reproducible.
const DOS_TIME = 0x6000; // 12:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 28;

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const data = readFileSync(entry.path);
    const deflated = deflateRawSync(data, { level: 9 });
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(useDeflate ? 8 : 0, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBuffer.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([record, nameBuffer]));

    offset += local.length + nameBuffer.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** Re-read our own output the way a real unzipper would. */
function verifyZip(buffer, expected) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('no end-of-central-directory record');

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory entry');
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    names.push(name);
    cursor += 46 + nameLength;
  }

  const problems = [];
  if (names.indexOf('index.html') === -1) problems.push('index.html is not at the zip root');
  for (const name of names) {
    if (name.indexOf('/') !== -1 && name.split('/')[0] === 'dev') problems.push(`dev file packaged: ${name}`);
    if (/^(README|dist)/.test(name)) problems.push(`non-runtime file packaged: ${name}`);
    if (!ALLOW.some((pattern) => pattern.test(name))) problems.push(`unexpected entry: ${name}`);
  }
  const missing = expected.filter((name) => names.indexOf(name) === -1);
  if (missing.length) problems.push(`missing entries: ${missing.join(', ')}`);
  if (problems.length) throw new Error(problems.join('; '));

  return names;
}

function main() {
  const all = collect(root)
    .map((file) => relative(root, file).split(sep).join('/'))
    .filter((name) => ALLOW.some((pattern) => pattern.test(name)))
    .sort();

  if (!all.length) throw new Error('nothing to package');
  if (all.indexOf('index.html') === -1) throw new Error('index.html is missing from the allowlist');

  let uncompressed = 0;
  for (const name of all) uncompressed += statSync(join(root, name)).size;
  if (uncompressed > HARD_LIMIT) throw new Error(`uncompressed ${uncompressed} exceeds the 10 MiB hard limit`);

  const zip = buildZip(all.map((name) => ({ name, path: join(root, name) })));
  const names = verifyZip(zip, all);

  mkdirSync(distDir, { recursive: true });
  writeFileSync(outFile, zip);

  console.log(`packed ${names.length} files -> ${relative(root, outFile)}`);
  for (const name of names) {
    const size = statSync(join(root, name)).size;
    console.log(`  ${String(size).padStart(7)}  ${name}`);
  }
  console.log(`  uncompressed ${(uncompressed / 1024).toFixed(1)} KB, zip ${(zip.length / 1024).toFixed(1)} KB`);
  if (uncompressed > SOFT_LIMIT) console.log(`  ! above the ${SOFT_LIMIT / 1024 / 1024} MiB target`);
  console.log('OK');
}

try {
  main();
} catch (error) {
  console.error(`pack failed: ${error.message}`);
  process.exitCode = 1;
}
