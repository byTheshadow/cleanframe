/**
 * Minimal, dependency-free ZIP writer.
 * Images are already compressed, so entries use STORE (method 0).
 * UTF-8 file names are flagged for cross-platform extraction.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function sanitizeFileName(name, fallback = 'image') {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

export function uniqueName(name, used) {
  const safe = sanitizeFileName(name);
  if (!used.has(safe.toLowerCase())) {
    used.add(safe.toLowerCase());
    return safe;
  }
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : '';
  let counter = 2;
  let candidate = `${base}-${counter}${extension}`;
  while (used.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${base}-${counter}${extension}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Build a ZIP archive from [{ name, blob }].
 * @param {{name: string, blob: Blob}[]} files
 * @param {{onProgress?: (ratio:number, index:number, total:number)=>void, now?: Date}} [options]
 * @returns {Promise<Blob>}
 */
export async function createZip(files, options = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('没有可打包的文件');
  if (files.length > 1000) throw new Error('单次 ZIP 最多支持 1000 个文件');

  const { onProgress = null, now = new Date() } = options;
  const encoder = new TextEncoder();
  const used = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = dosDateTime(now);
  let totalBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const entry = files[index];
    if (!entry?.blob) throw new Error(`第 ${index + 1} 个文件为空`);
    const name = uniqueName(entry.name, used);
    const nameBytes = encoder.encode(name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(data);

    if (data.length > 0xfffffff0) throw new Error(`${name} 超过 ZIP32 单文件大小限制`);
    if (offset > 0xfffffff0) throw new Error('导出文件超过 4 GB，请分批下载');

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
    totalBytes += data.length;

    onProgress?.((index + 1) / files.length, index + 1, files.length);
    if (index % 5 === 4) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

export function suggestedZipName(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `净帧导出-${year}${month}${day}-${hour}${minute}.zip`;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}
