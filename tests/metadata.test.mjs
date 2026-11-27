import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  inspectImage,
  stripMetadata,
  detectFormat,
  formatBytes,
  extensionForMime,
} from '../js/metadata.js';
import { createZip, crc32, sanitizeFileName, uniqueName } from '../js/zip.js';

const root = new URL('../', import.meta.url);

async function fixture(name, type) {
  const bytes = await readFile(new URL(`tests/fixtures/${name}`, root));
  return new File([bytes], name, { type });
}

async function sample(name) {
  const bytes = await readFile(new URL(`assets/samples/${name}`, root));
  return new File([bytes], name, { type: 'image/jpeg' });
}

function allRows(analysis) {
  return analysis.groupList.flatMap((group) => group.rows);
}

function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'EOCD exists');
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    assert.equal(view.getUint32(localOffset, true), 0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + size);
    entries.push({ name, flags, method, crc, size, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('sample JPEG exposes camera, GPS, XMP and IPTC metadata', async () => {
  const file = await sample('sample-01.jpg');
  const analysis = await inspectImage(file);
  assert.equal(analysis.format, 'jpeg');
  assert.equal(analysis.width, 1800);
  assert.equal(analysis.height, 1200);
  assert.equal(analysis.orientation, 1);
  assert.ok(analysis.metadataBytes > 1000);
  assert.equal(analysis.hasExif, true);
  assert.equal(analysis.hasXmp, true);
  assert.equal(analysis.hasIptc, true);
  assert.equal(analysis.hasGps, true);
  assert.ok(Math.abs(analysis.gps.latitude - 31.2401) < 0.00001);
  assert.ok(Math.abs(analysis.gps.longitude - 121.4904) < 0.00001);
  const rows = allRows(analysis);
  assert.ok(rows.some((row) => row.label === '相机型号' && row.value.includes('X-T5')));
  assert.ok(rows.some((row) => row.label === '作者' && row.value.includes('林屿')));
  assert.ok(rows.some((row) => row.label === '关键词' && row.value.includes('外滩')));
  assert.ok(analysis.risks.some((risk) => risk.id === 'gps'));
  assert.ok(analysis.risks.some((risk) => risk.id === 'serial'));
});

test('JPEG metadata is removed without changing dimensions', async () => {
  const file = await sample('sample-01.jpg');
  const before = await inspectImage(file);
  const output = await stripMetadata(file, before, { keepColorProfile: true });
  const after = await inspectImage(output.blob, 'clean.jpg');
  assert.equal(output.method, 'container-stripped');
  assert.equal(output.blob.type, 'image/jpeg');
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  assert.equal(after.metadataBytes, 0);
  assert.equal(after.hasExif, false);
  assert.equal(after.hasXmp, false);
  assert.equal(after.hasIptc, false);
  assert.equal(after.gps, null);
  assert.ok(output.blob.size < file.size);
  const signature = new Uint8Array(await output.blob.arrayBuffer()).subarray(0, 3);
  assert.deepEqual([...signature], [0xff, 0xd8, 0xff]);
});

test('PNG text, iTXt and eXIf metadata is parsed and stripped', async () => {
  const file = await fixture('metadata.png', 'image/png');
  const before = await inspectImage(file, 'metadata.png');
  assert.equal(before.format, 'png');
  assert.equal(before.width, 720);
  assert.equal(before.hasExif, true);
  const rows = allRows(before);
  assert.ok(rows.some((row) => row.label === '标题' && row.value.includes('PNG 元数据测试')));
  assert.ok(rows.some((row) => row.label === '注释' && row.value.includes('Unicode iTXt')));
  assert.ok(before.metadataBytes > 0);

  const output = await stripMetadata(file, before);
  const after = await inspectImage(output.blob, 'clean.png');
  assert.equal(after.format, 'png');
  assert.equal(after.width, 720);
  assert.equal(after.height, 480);
  assert.equal(after.metadataBytes, 0);
  assert.equal(after.hasExif, false);
  assert.equal(after.groupList.length, 1, 'only the file group remains');
  const signature = new Uint8Array(await output.blob.arrayBuffer()).subarray(0, 8);
  assert.deepEqual([...signature], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('WebP EXIF and XMP metadata is parsed and stripped', async () => {
  const file = await fixture('metadata.webp', 'image/webp');
  const before = await inspectImage(file, 'metadata.webp');
  assert.equal(before.format, 'webp');
  assert.equal(before.width, 720);
  assert.equal(before.hasExif, true);
  assert.equal(before.hasXmp, true);
  const rows = allRows(before);
  assert.ok(rows.some((row) => row.label === '作者（XMP）' && row.value.includes('WebP Author')));
  assert.ok(before.metadataBytes > 0);

  const output = await stripMetadata(file, before);
  const after = await inspectImage(output.blob, 'clean.webp');
  assert.equal(after.format, 'webp');
  assert.equal(after.width, 720);
  assert.equal(after.height, 480);
  assert.equal(after.metadataBytes, 0);
  assert.equal(after.hasExif, false);
  assert.equal(after.hasXmp, false);
  const bytes = new Uint8Array(await output.blob.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), 'WEBP');
});

test('EXIF orientation is reported for rotated files', async () => {
  const file = await fixture('orientation-6.jpg', 'image/jpeg');
  const analysis = await inspectImage(file);
  assert.equal(analysis.orientation, 6);
  assert.ok(allRows(analysis).some((row) => row.label === '方向' && row.value.includes('90°')));
});

test('format helpers are predictable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('image/webp'), 'webp');
  const jpegHeader = new Uint8Array(12);
  jpegHeader.set([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(detectFormat(jpegHeader), 'jpeg');
  assert.equal(detectFormat(new Uint8Array(12)), null);
});

test('CRC32 and ZIP32 store entries are valid', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(sanitizeFileName('  坏/名字?.jpg  '), '坏-名字-.jpg');
  const used = new Set();
  assert.equal(uniqueName('photo.jpg', used), 'photo.jpg');
  assert.equal(uniqueName('photo.jpg', used), 'photo-2.jpg');

  const first = new Blob(['hello ']);
  const second = new Blob(['世界']);
  const zip = await createZip([
    { name: 'photo.jpg', blob: first },
    { name: 'photo.jpg', blob: second },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const entries = readZipEntries(bytes);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'photo.jpg');
  assert.equal(entries[1].name, 'photo-2.jpg');
  assert.equal(entries[0].method, 0);
  assert.equal(entries[0].crc, crc32(new TextEncoder().encode('hello ')));
  assert.equal(new TextDecoder().decode(entries[0].data), 'hello ');
  assert.equal(new TextDecoder().decode(entries[1].data), '世界');
  assert.equal(entries[0].flags & 0x0800, 0x0800);
  assert.equal(entries[1].flags & 0x0800, 0x0800);
});
