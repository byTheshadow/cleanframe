/**
 * CleanFrame metadata engine
 * --------------------------
 * Reads EXIF / GPS / XMP / IPTC from JPEG, PNG and WebP and removes
 * metadata at the container level whenever possible. Pixel data is kept
 * byte-for-byte for the common (non-rotated) case; rotated JPEGs are
 * re-rendered upright so the picture never changes orientation after
 * the EXIF orientation tag is gone.
 *
 * No network, no dependencies. Runs entirely in the browser.
 */

const GROUP_ORDER = [
  'file',
  'camera',
  'capture',
  'location',
  'rights',
  'descriptions',
  'dates',
  'software',
  'xmp',
  'iptc',
  'technical',
];

const GROUP_META = {
  file: { label: '文件信息', icon: 'file', description: '文件本身的基本情况' },
  camera: { label: '拍摄设备', icon: 'camera', description: '手机或相机、镜头和设备编号' },
  capture: { label: '拍摄参数', icon: 'aperture', description: '快门、光圈等参数，通常不是隐私重点' },
  location: { label: '拍摄地点', icon: 'pin', description: '可能直接暴露你在哪里拍照' },
  rights: { label: '作者与版权', icon: 'user', description: '署名和版权信息，可能包含真实姓名' },
  descriptions: { label: '标题与关键词', icon: 'text', description: '软件写入的标题、说明和关键词' },
  dates: { label: '时间', icon: 'clock', description: '照片的拍摄和修改时间' },
  software: { label: '编辑软件', icon: 'spark', description: '处理过这张照片的软件' },
  xmp: { label: '扩展说明', icon: 'code', description: '软件写入的更多隐藏说明（XMP）' },
  iptc: { label: '新闻字段', icon: 'tag', description: '媒体常用的说明字段（IPTC）' },
  technical: { label: '技术细节', icon: 'sliders', description: '尺寸、方向和颜色等技术信息' },
};

const EXIF_TYPE_SIZE = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

const ORIENTATION_LABEL = {
  1: '正常',
  2: '水平镜像',
  3: '旋转 180°',
  4: '垂直镜像',
  5: '镜像后旋转 90°',
  6: '旋转 90° 顺时针',
  7: '镜像后旋转 270°',
  8: '旋转 270° 顺时针',
};

const EXPOSURE_PROGRAM = {
  0: '未定义',
  1: '手动',
  2: '程序自动',
  3: '光圈优先',
  4: '快门优先',
  5: '创意程序',
  6: '人像模式',
  7: '风景模式',
  8: '运动模式',
  9: '夜景模式',
};

const METERING_MODE = {
  0: '未知',
  1: '平均测光',
  2: '中央重点测光',
  3: '点测光',
  4: '多区测光',
  5: '评价测光',
  6: '局部测光',
  255: '其他',
};

const FLASH = {
  0x00: '未闪光',
  0x01: '闪光',
  0x05: '闪光，未检测到回光',
  0x07: '闪光，检测到回光',
  0x09: '强制闪光',
  0x0d: '强制闪光，未检测到回光',
  0x0f: '强制闪光，检测到回光',
  0x10: '关闭闪光',
  0x18: '自动，未闪光',
  0x19: '自动，闪光',
  0x1d: '自动，闪光，未检测到回光',
  0x1f: '自动，闪光，检测到回光',
  0x20: '无闪光功能',
  0x41: '红眼抑制',
  0x45: '红眼抑制，强制闪光',
  0x47: '红眼抑制，强制闪光，检测到回光',
  0x49: '红眼抑制，强制闪光',
  0x4d: '红眼抑制，强制闪光，未检测到回光',
  0x4f: '红眼抑制，强制闪光，检测到回光',
  0x59: '红眼抑制，自动闪光',
  0x5d: '红眼抑制，自动闪光，未检测到回光',
  0x5f: '红眼抑制，自动闪光，检测到回光',
};

const IPTC_LABELS = {
  '2:5': ['descriptions', '对象名称'],
  '2:10': ['iptc', '紧急程度'],
  '2:15': ['iptc', '类别'],
  '2:20': ['iptc', '补充类别'],
  '2:25': ['descriptions', '关键词'],
  '2:40': ['iptc', '特别说明'],
  '2:55': ['dates', '创建日期'],
  '2:60': ['dates', '创建时间'],
  '2:65': ['software', '来源程序'],
  '2:80': ['rights', '作者'],
  '2:85': ['rights', '作者头衔'],
  '2:90': ['location', '城市'],
  '2:92': ['location', '子位置'],
  '2:95': ['location', '省 / 州'],
  '2:100': ['location', '国家代码'],
  '2:101': ['location', '国家 / 地区'],
  '2:103': ['iptc', '传输参考'],
  '2:105': ['descriptions', '标题'],
  '2:110': ['rights', '署名'],
  '2:115': ['iptc', '来源'],
  '2:116': ['rights', '版权声明'],
  '2:118': ['descriptions', '联系地址'],
  '2:120': ['descriptions', '图片说明'],
  '2:122': ['rights', '撰写者'],
};

const PNG_TEXT_LABELS = {
  title: ['descriptions', '标题'],
  author: ['rights', '作者'],
  description: ['descriptions', '说明'],
  copyright: ['rights', '版权'],
  'creation time': ['dates', '创建时间'],
  software: ['software', '软件'],
  comment: ['descriptions', '注释'],
  disclaimer: ['iptc', '免责声明'],
  warning: ['iptc', '警告'],
  source: ['iptc', '来源'],
};

export const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function detectFormat(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export async function inspectImage(blob, fileName = blob?.name || '未命名') {
  if (!(blob instanceof Blob)) throw new TypeError('inspectImage 需要一个 Blob');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const format = detectFormat(bytes);
  if (!format) {
    throw new Error('无法读取这种格式。请使用 JPG、PNG 或 WebP。');
  }

  const record = {
    fileName,
    byteSize: blob.size,
    format,
    mime: mimeForFormat(format),
    width: 0,
    height: 0,
    bitDepth: null,
    colorSpace: '未标注',
    orientation: 1,
    metadataBytes: 0,
    hasExif: false,
    hasXmp: false,
    hasIptc: false,
    hasGps: false,
    hasIcc: false,
    hasThumbnail: false,
    gps: null,
    groups: new Map(),
    risks: [],
    notes: [],
    technical: {},
    raw: {},
    xmpPropertyCount: 0,
    method: '',
  };

  if (format === 'jpeg') parseJpeg(bytes, record);
  else if (format === 'png') await parsePng(bytes, record);
  else parseWebp(bytes, record);

  finalizeRecord(record);
  return record;
}

/**
 * Remove metadata from an image.
 * @param {Blob} blob
 * @param {object} [analysis] result from inspectImage (used for orientation)
 * @param {{keepColorProfile?: boolean, reencodeQuality?: number}} [options]
 */
export async function stripMetadata(blob, analysis = null, options = {}) {
  const { keepColorProfile = true, reencodeQuality = 0.95 } = options;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const format = detectFormat(bytes);
  if (!format) throw new Error('无法处理这种图片格式');

  const orientation = Number(analysis?.orientation || 1);
  if (orientation !== 1) {
    const mime = mimeForFormat(format);
    const upright = await reencodeImage(blob, mime, reencodeQuality);
    return {
      blob: upright.blob,
      mime,
      width: upright.width,
      height: upright.height,
      method: 'reencoded-upright',
      removedBytes: Math.max(0, blob.size - upright.blob.size),
    };
  }

  let result;
  if (format === 'jpeg') result = stripJpegBytes(bytes, keepColorProfile);
  else if (format === 'png') result = stripPngBytes(bytes);
  else result = stripWebpBytes(bytes);

  return {
    blob: new Blob([result.bytes], { type: mimeForFormat(format) }),
    mime: mimeForFormat(format),
    width: result.width || analysis?.width || 0,
    height: result.height || analysis?.height || 0,
    method: 'container-stripped',
    removedBytes: Math.max(0, blob.size - result.bytes.byteLength),
  };
}

export function mimeForFormat(format) {
  return format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp';
}

export function extensionForMime(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

export function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : value >= 100 ? 0 : decimals)} ${units[exponent]}`;
}

export function formatDate(value) {
  if (!value) return '';
  const match = String(value).match(
    /^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!match) return String(value);
  const [, year, month, day, hour, minute, second = '00'] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function summaryOf(record) {
  if (!record) return null;
  const megapixels = record.width && record.height ? (record.width * record.height) / 1e6 : 0;
  return {
    format: record.format === 'jpeg' ? 'JPEG' : record.format === 'png' ? 'PNG' : 'WebP',
    dimensions: record.width && record.height ? `${record.width} × ${record.height}` : '—',
    megapixels: megapixels
      ? `${megapixels >= 10 ? megapixels.toFixed(1) : megapixels.toFixed(2)} MP`
      : '',
    colorSpace: record.colorSpace,
    metadata: formatBytes(record.metadataBytes),
    size: formatBytes(record.byteSize),
  };
}

export function groupList(record) {
  return GROUP_ORDER.map((id) => ({
    id,
    ...GROUP_META[id],
    rows: record.groups.get(id) || [],
  })).filter((group) => group.rows.length > 0);
}

/* -------------------------------------------------------------------------- */
/* JPEG                                                                        */
/* -------------------------------------------------------------------------- */

function parseJpeg(bytes, record) {
  record.method = 'jpeg-segments';
  if (bytes.length < 4) throw new Error('JPEG 文件不完整');

  let offset = 2;
  let sofSeen = false;
  const segments = [];

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      record.notes.push('JPEG 段结构提前结束');
      break;
    }
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, markerStart, offset, end: offset });
      continue;
    }
    if (marker === 0xd9) {
      segments.push({ marker, markerStart, offset, end: offset });
      break;
    }
    if (marker === 0xda) {
      segments.push({ marker, markerStart, offset, end: bytes.length });
      break;
    }
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2) {
      record.notes.push('JPEG 段长度异常');
      break;
    }
    const payloadStart = offset + 2;
    const segmentEnd = offset + length;
    if (segmentEnd > bytes.length) {
      record.notes.push('JPEG 段数据被截断');
      break;
    }
    const payload = bytes.subarray(payloadStart, segmentEnd);

    if (isSofMarker(marker)) {
      if (payload.length >= 6) {
        record.bitDepth = payload[0];
        record.height = (payload[1] << 8) | payload[2];
        record.width = (payload[3] << 8) | payload[4];
        sofSeen = true;
      }
    }

    let label = '';
    let removable = false;
    if (marker >= 0xe0 && marker <= 0xef) {
      const appNumber = marker - 0xe0;
      if (appNumber === 0) {
        const isJfif = startsWithAscii(payload, 'JFIF\0');
        label = isJfif ? 'JFIF' : 'APP0（缩略图扩展）';
        removable = !isJfif;
      } else if (appNumber === 1) {
        if (startsWithAscii(payload, 'Exif\0\0')) {
          label = 'EXIF';
          removable = true;
          record.hasExif = true;
          try {
            parseTiff(bytes, payloadStart + 6, record, 'EXIF');
          } catch (error) {
            record.notes.push('EXIF 数据部分无法读取');
          }
        } else if (startsWithAscii(payload, 'http://ns.adobe.com/xap/1.0/\0')) {
          label = 'XMP';
          removable = true;
          record.hasXmp = true;
          parseXmp(decodeText(payload.subarray(29)), record);
        } else {
          label = 'APP1';
          removable = true;
        }
      } else if (appNumber === 2) {
        if (startsWithAscii(payload, 'ICC_PROFILE\0')) {
          label = 'ICC 色彩配置';
          record.hasIcc = true;
          parseIccHeader(payload.subarray(12), record);
        } else if (startsWithAscii(payload, 'MPF\0')) {
          label = 'MPF 多图索引';
          removable = true;
        } else {
          label = 'APP2';
          removable = true;
        }
      } else if (appNumber === 13) {
        label = 'IPTC / Photoshop';
        removable = true;
        try {
          parsePhotoshopIptc(payload, record);
        } catch (error) {
          record.notes.push('IPTC 数据部分无法读取');
        }
      } else if (appNumber === 14) {
        label = 'Adobe 色彩标记';
      } else {
        label = `APP${appNumber}`;
        removable = true;
      }
    } else if (marker === 0xfe) {
      label = 'JPEG 注释';
      removable = true;
      const comment = cleanText(decodeText(payload));
      if (comment) addField(record, 'descriptions', 'JPEG 注释', truncate(comment, 180));
    } else if (isSofMarker(marker)) {
      label = '帧信息';
    }

    if (label) {
      segments.push({
        marker,
        markerStart,
        offset,
        end: segmentEnd,
        label,
        removable,
      });
    }
    if (removable) record.metadataBytes += segmentEnd - markerStart;
    offset = segmentEnd;
  }

  if (!sofSeen) record.notes.push('未找到 JPEG 尺寸信息');
  record.technical.segments = segments
    .filter((segment) => segment.label)
    .map((segment) => ({ label: segment.label, bytes: segment.end - segment.markerStart }));

  if (record.hasExif) addField(record, 'technical', 'EXIF', '已嵌入');
  if (record.hasXmp) addField(record, 'technical', 'XMP', '已嵌入');
  if (record.hasIptc) addField(record, 'technical', 'IPTC', '已嵌入');
  if (record.hasIcc) addField(record, 'technical', 'ICC 色彩配置', '已嵌入');
}

function stripJpegBytes(bytes, keepColorProfile) {
  const chunks = [bytes.subarray(0, 2)];
  let offset = 2;
  let sosFound = false;
  let width = 0;
  let height = 0;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];

    if (marker === 0xda) {
      chunks.push(bytes.subarray(markerStart));
      sosFound = true;
      break;
    }
    if (marker === 0xd9) {
      chunks.push(bytes.subarray(markerStart, offset));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    const payloadStart = offset + 2;
    const segmentEnd = offset + length;
    const payload = bytes.subarray(payloadStart, segmentEnd);

    if (isSofMarker(marker) && payload.length >= 6) {
      height = (payload[1] << 8) | payload[2];
      width = (payload[3] << 8) | payload[4];
    }

    let keep = true;
    if (marker === 0xe0) {
      keep = startsWithAscii(payload, 'JFIF\0');
    } else if (marker === 0xe1) {
      keep = false;
    } else if (marker === 0xe2) {
      keep = keepColorProfile && startsWithAscii(payload, 'ICC_PROFILE\0');
    } else if (marker >= 0xe3 && marker <= 0xed) {
      keep = false;
    } else if (marker === 0xee) {
      keep = true;
    } else if (marker === 0xef) {
      keep = false;
    } else if (marker === 0xfe) {
      keep = false;
    }

    if (keep) chunks.push(bytes.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }

  if (!sosFound) throw new Error('JPEG 图像数据不完整，无法安全清理');
  return { bytes: concatBytes(chunks), width, height };
}

function isSofMarker(marker) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                         */
/* -------------------------------------------------------------------------- */

async function parsePng(bytes, record) {
  record.method = 'png-chunks';
  if (bytes.length < 33) throw new Error('PNG 文件不完整');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      record.notes.push('PNG 数据块被截断');
      break;
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === 'IHDR' && data.length >= 13) {
      record.width = view.getUint32(dataStart);
      record.height = view.getUint32(dataStart + 4);
      record.bitDepth = data[8];
      record.colorSpace = pngColorSpace(data[9]);
    } else if (type === 'eXIf') {
      record.hasExif = true;
      record.metadataBytes += length + 12;
      try {
        parseTiff(bytes, dataStart, record, 'PNG eXIf');
      } catch (error) {
        record.notes.push('PNG eXIf 数据部分无法读取');
      }
    } else if (type === 'iCCP') {
      record.hasIcc = true;
      record.colorSpace = 'ICC 色彩配置';
    } else if (type === 'pHYs') {
      record.metadataBytes += length + 12;
      if (data.length >= 9 && data[8] === 1) {
        const ppuX = view.getUint32(dataStart);
        const ppuY = view.getUint32(dataStart + 4);
        if (ppuX && ppuY) {
          addField(
            record,
            'technical',
            '像素密度',
            `${Math.round(ppuX * 0.0254)} × ${Math.round(ppuY * 0.0254)} DPI`,
          );
        }
      }
    } else if (type === 'tIME') {
      record.metadataBytes += length + 12;
      if (data.length >= 7) {
        const year = (data[0] << 8) | data[1];
        const value = `${year}-${pad2(data[2])}-${pad2(data[3])} ${pad2(data[4])}:${pad2(data[5])}:${pad2(data[6])}`;
        addField(record, 'dates', 'PNG 修改时间', value);
      }
    } else if (type === 'tEXt') {
      record.metadataBytes += length + 12;
      const split = data.indexOf(0);
      if (split > 0) {
        handlePngText(decodeText(data.subarray(0, split)), decodeText(data.subarray(split + 1)), record);
      }
    } else if (type === 'zTXt') {
      record.metadataBytes += length + 12;
      const split = data.indexOf(0);
      if (split > 0 && data[split + 1] === 0) {
        const keyword = decodeText(data.subarray(0, split));
        try {
          const text = decodeText(await inflate(data.subarray(split + 2)));
          handlePngText(keyword, text, record);
        } catch {
          record.notes.push(`无法解压 PNG ${keyword} 文本`);
        }
      }
    } else if (type === 'iTXt') {
      record.metadataBytes += length + 12;
      const keywordEnd = data.indexOf(0);
      if (keywordEnd > 0) {
        const keyword = decodeText(data.subarray(0, keywordEnd));
        let cursor = keywordEnd + 1;
        const compressed = data[cursor] === 1;
        cursor += 2; // compression flag + compression method
        const languageEnd = data.indexOf(0, cursor);
        cursor = languageEnd >= 0 ? languageEnd + 1 : cursor;
        const translatedEnd = data.indexOf(0, cursor);
        cursor = translatedEnd >= 0 ? translatedEnd + 1 : cursor;
        const textBytes = data.subarray(cursor);
        try {
          const text = decodeText(compressed ? await inflate(textBytes) : textBytes);
          handlePngText(keyword, text, record);
        } catch {
          record.notes.push(`无法读取 PNG ${keyword} 文本`);
        }
      }
    } else if (type === 'cHRM' || type === 'gAMA' || type === 'sRGB') {
      record.technical.colorChunk = type;
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  if (!record.width || !record.height) record.notes.push('未找到 PNG 尺寸信息');
  if (record.hasExif) addField(record, 'technical', 'EXIF', '已嵌入');
  if (record.hasIcc) addField(record, 'technical', 'ICC 色彩配置', '已嵌入');
}

function handlePngText(keyword, value, record) {
  const clean = cleanText(value);
  if (!clean) return;
  const key = keyword.trim().toLowerCase();
  if (key === 'xml:com.adobe.xmp') {
    record.hasXmp = true;
    parseXmp(clean, record);
    return;
  }
  if (key === 'raw profile type exif' || key === 'raw profile type app1') {
    record.hasExif = true;
    return;
  }
  const mapping = PNG_TEXT_LABELS[key];
  if (mapping) addField(record, mapping[0], mapping[1], truncate(clean, 300));
  else addField(record, 'descriptions', `PNG ${keyword}`, truncate(clean, 300));
}

function stripPngBytes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  let width = 0;
  let height = 0;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) throw new Error('PNG 数据块被截断');
    if (type === 'IHDR' && length >= 8) {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
    }
    if (shouldKeepPngChunk(type)) parts.push(bytes.subarray(offset, chunkEnd));
    if (type === 'IEND') break;
    offset = chunkEnd;
  }

  return { bytes: concatBytes(parts), width, height };
}

function shouldKeepPngChunk(type) {
  if (type === 'IHDR' || type === 'PLTE' || type === 'IDAT' || type === 'IEND' || type === 'tRNS') {
    return true;
  }
  return ['iCCP', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'bKGD', 'acTL', 'fcTL', 'fdAT'].includes(type);
}

/* -------------------------------------------------------------------------- */
/* WebP                                                                        */
/* -------------------------------------------------------------------------- */

function parseWebp(bytes, record) {
  record.method = 'webp-chunks';
  if (bytes.length < 20) throw new Error('WebP 文件不完整');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  const riffEnd = Math.min(bytes.length, view.getUint32(4, true) + 8);

  while (offset + 8 <= riffEnd) {
    const type = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > riffEnd) {
      record.notes.push('WebP 数据块被截断');
      break;
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === 'VP8X' && data.length >= 10) {
      record.width = read24LE(data, 4) + 1;
      record.height = read24LE(data, 7) + 1;
      record.technical.webpFlags = data[0];
    } else if (type === 'VP8 ' && data.length >= 10) {
      if (!record.width && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
        record.width = ((data[6] | (data[7] << 8)) & 0x3fff) || 0;
        record.height = ((data[8] | (data[9] << 8)) & 0x3fff) || 0;
      }
    } else if (type === 'VP8L' && data.length >= 5) {
      if (!record.width && data[0] === 0x2f) {
        const bits = readUint32LE(data, 1);
        record.width = (bits & 0x3fff) + 1;
        record.height = ((bits >> 14) & 0x3fff) + 1;
      }
    } else if (type === 'EXIF') {
      record.hasExif = true;
      record.metadataBytes += size + 8;
      let tiff = data;
      if (startsWithAscii(data, 'Exif\0\0')) tiff = data.subarray(6);
      try {
        parseTiff(tiff, 0, record, 'WebP EXIF');
      } catch {
        record.notes.push('WebP EXIF 数据部分无法读取');
      }
    } else if (type === 'XMP ') {
      record.hasXmp = true;
      record.metadataBytes += size + 8;
      parseXmp(decodeText(data), record);
    } else if (type === 'ICCP') {
      record.hasIcc = true;
      record.colorSpace = 'ICC 色彩配置';
    }

    offset = dataEnd + (size % 2);
  }

  if (!record.width || !record.height) record.notes.push('未找到 WebP 尺寸信息');
  if (record.hasExif) addField(record, 'technical', 'EXIF', '已嵌入');
  if (record.hasXmp) addField(record, 'technical', 'XMP', '已嵌入');
  if (record.hasIcc) addField(record, 'technical', 'ICC 色彩配置', '已嵌入');
}

function stripWebpBytes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 12;
  const riffEnd = Math.min(bytes.length, view.getUint32(4, true) + 8);
  let width = 0;
  let height = 0;

  while (offset + 8 <= riffEnd) {
    const type = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const chunkEnd = offset + 8 + size + (size % 2);
    if (chunkEnd > bytes.length) throw new Error('WebP 数据块被截断');
    if (type === 'VP8X' && size >= 10) {
      width = read24LE(bytes, offset + 12) + 1;
      height = read24LE(bytes, offset + 15) + 1;
    }
    if (type === 'EXIF' || type === 'XMP ') {
      offset = chunkEnd;
      continue;
    }
    const raw = Uint8Array.from(bytes.subarray(offset, chunkEnd));
    if (type === 'VP8X' && raw.length >= 9) {
      raw[8] &= ~0x08;
      raw[8] &= ~0x04;
    }
    chunks.push(raw);
    offset = chunkEnd;
  }

  const payloadSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + 4;
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(header.buffer).setUint32(4, payloadSize, true);
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  const parts = [header, ...chunks];
  return { bytes: concatBytes(parts), width, height };
}

/* -------------------------------------------------------------------------- */
/* TIFF / EXIF                                                                 */
/* -------------------------------------------------------------------------- */

function parseTiff(bytes, tiffStart, record, source = 'EXIF') {
  if (tiffStart + 8 > bytes.length) throw new Error('TIFF 头不完整');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = ascii(bytes, tiffStart, 2);
  if (order !== 'II' && order !== 'MM') throw new Error('TIFF 字节序无效');
  const little = order === 'II';
  const u16 = (pos) => view.getUint16(pos, little);
  const u32 = (pos) => view.getUint32(pos, little);
  if (u16(tiffStart + 2) !== 42) throw new Error('TIFF 标识无效');
  const ifd0Offset = u32(tiffStart + 4);
  record.raw.tiffByteOrder = order;

  const readIfd = (relativeOffset, seen = new Set()) => {
    if (relativeOffset <= 0) return { entries: new Map(), next: 0 };
    const start = tiffStart + relativeOffset;
    if (start + 2 > bytes.length || seen.has(relativeOffset) || seen.size > 8) {
      return { entries: new Map(), next: 0 };
    }
    seen.add(relativeOffset);
    const count = u16(start);
    if (count > 512) return { entries: new Map(), next: 0 };
    const entries = new Map();
    for (let index = 0; index < count; index += 1) {
      const entryPos = start + 2 + index * 12;
      if (entryPos + 12 > bytes.length) break;
      const tag = u16(entryPos);
      const type = u16(entryPos + 2);
      const itemCount = u32(entryPos + 4);
      const typeSize = EXIF_TYPE_SIZE[type];
      if (!typeSize || itemCount > 1_000_000) continue;
      const valueSize = typeSize * itemCount;
      let valuePos = entryPos + 8;
      if (valueSize > 4) {
        const relative = u32(entryPos + 8);
        valuePos = tiffStart + relative;
        if (valuePos + valueSize > bytes.length) continue;
      }
      entries.set(tag, {
        tag,
        type,
        count: itemCount,
        value: readExifValue(view, bytes, valuePos, type, itemCount, little),
      });
    }
    return { entries, next: u32(start + 2 + count * 12) };
  };

  const ifd0Result = readIfd(ifd0Offset);
  const ifd0 = ifd0Result.entries;
  const exifIfd = ifd0.get(0x8769)
    ? readIfd(numberValue(ifd0.get(0x8769).value)).entries
    : new Map();
  const gpsIfd = ifd0.get(0x8825)
    ? readIfd(numberValue(ifd0.get(0x8825).value)).entries
    : new Map();

  record.raw.ifd0Count = ifd0.size;
  record.raw.exifCount = exifIfd.size;
  record.raw.gpsCount = gpsIfd.size;

  mapIfd0(ifd0, record);
  mapExifIfd(exifIfd, record);
  const gps = mapGpsIfd(gpsIfd, record);
  if (gps) {
    record.gps = gps;
    record.hasGps = true;
  }

  if (ifd0Result.next) {
    const ifd1 = readIfd(ifd0Result.next);
    if (ifd1.entries.size) {
      record.raw.ifd1Count = ifd1.entries.size;
      addField(record, 'technical', '内嵌缩略图', '存在');
      record.hasThumbnail = true;
    }
  }
  record.raw.tiffSource = source;
}

function readExifValue(view, bytes, pos, type, count, little) {
  if (type === 2) {
    const raw = bytes.subarray(pos, pos + count);
    const end = raw.indexOf(0);
    return decodeText(end === -1 ? raw : raw.subarray(0, end));
  }
  if (type === 7 || type === 1 || type === 6) return bytes.slice(pos, pos + count);
  if (type === 3) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(view.getUint16(pos + i * 2, little));
    return out.length === 1 ? out[0] : out;
  }
  if (type === 4 || type === 13) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(view.getUint32(pos + i * 4, little));
    return out.length === 1 ? out[0] : out;
  }
  if (type === 8) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(view.getInt16(pos + i * 2, little));
    return out.length === 1 ? out[0] : out;
  }
  if (type === 9) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(view.getInt32(pos + i * 4, little));
    return out.length === 1 ? out[0] : out;
  }
  if (type === 5 || type === 10) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const numerator = type === 5 ? view.getUint32(pos + i * 8, little) : view.getInt32(pos + i * 8, little);
      const denominator =
        type === 5 ? view.getUint32(pos + i * 8 + 4, little) : view.getInt32(pos + i * 8 + 4, little);
      out.push([numerator, denominator]);
    }
    return out.length === 1 ? out[0] : out;
  }
  if (type === 11) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(view.getFloat32(pos + i * 4, little));
    return out.length === 1 ? out[0] : out;
  }
  if (type === 12) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(view.getFloat64(pos + i * 8, little));
    return out.length === 1 ? out[0] : out;
  }
  return null;
}

function mapIfd0(ifd, record) {
  const description = stringValue(ifd, 0x010e);
  if (description) addField(record, 'descriptions', '图像描述', truncate(description, 300));

  const make = stringValue(ifd, 0x010f);
  const model = stringValue(ifd, 0x0110);
  if (make) addField(record, 'camera', '制造商', make);
  if (model) addField(record, 'camera', '相机型号', model);

  const orientation = numberValue(ifd.get(0x0112)?.value);
  if (orientation) {
    record.orientation = orientation;
    addField(record, 'technical', '方向', ORIENTATION_LABEL[orientation] || `值 ${orientation}`);
  }

  const software = stringValue(ifd, 0x0131);
  if (software) addField(record, 'software', '处理软件', software);

  const dateTime = stringValue(ifd, 0x0132);
  if (dateTime) addField(record, 'dates', '文件修改时间', formatDate(dateTime));

  const artist = stringValue(ifd, 0x013b);
  if (artist) addField(record, 'rights', '作者', artist);

  const copyright = stringValue(ifd, 0x8298);
  if (copyright) addField(record, 'rights', '版权', copyright);

  const xpAuthor = unicodeValue(bytesValue(ifd, 0x9c9d));
  const xpTitle = unicodeValue(bytesValue(ifd, 0x9c9b));
  const xpKeywords = unicodeValue(bytesValue(ifd, 0x9c9e));
  if (xpAuthor) addField(record, 'rights', '作者（Windows）', xpAuthor);
  if (xpTitle) addField(record, 'descriptions', '标题（Windows）', xpTitle);
  if (xpKeywords) addField(record, 'descriptions', '关键词（Windows）', xpKeywords);

  const resolutionX = rationalValue(ifd.get(0x011a)?.value);
  const resolutionY = rationalValue(ifd.get(0x011b)?.value);
  const unit = numberValue(ifd.get(0x0128)?.value);
  if (resolutionX) {
    const suffix = unit === 3 ? '像素 / 厘米' : 'DPI';
    addField(
      record,
      'technical',
      '分辨率',
      resolutionY && resolutionY !== resolutionX
        ? `${round(resolutionX)} × ${round(resolutionY)} ${suffix}`
        : `${round(resolutionX)} ${suffix}`,
    );
  }

  const imageWidth = numberValue(ifd.get(0x0100)?.value);
  const imageHeight = numberValue(ifd.get(0x0101)?.value);
  if (!record.width && imageWidth) record.width = imageWidth;
  if (!record.height && imageHeight) record.height = imageHeight;
}

function mapExifIfd(ifd, record) {
  const exposureTime = rationalValue(ifd.get(0x829a)?.value);
  if (exposureTime) addField(record, 'capture', '曝光时间', formatExposureTime(exposureTime));
  const fNumber = rationalValue(ifd.get(0x829d)?.value);
  if (fNumber) addField(record, 'capture', '光圈', `f/${round(fNumber, 1)}`);

  const exposureProgram = numberValue(ifd.get(0x8822)?.value);
  if (exposureProgram !== null) {
    addField(record, 'capture', '曝光程序', EXPOSURE_PROGRAM[exposureProgram] || `值 ${exposureProgram}`);
  }
  const iso = numberValue(ifd.get(0x8827)?.value);
  if (iso) addField(record, 'capture', 'ISO', `ISO ${iso}`);

  const original = stringValue(ifd, 0x9003);
  if (original) addField(record, 'dates', '拍摄时间', formatDate(original));
  const digitized = stringValue(ifd, 0x9004);
  if (digitized) addField(record, 'dates', '数字化时间', formatDate(digitized));

  const offsetTime = stringValue(ifd, 0x9010);
  const offsetOriginal = stringValue(ifd, 0x9011);
  if (offsetOriginal) addField(record, 'dates', '原始时区', offsetOriginal);
  else if (offsetTime) addField(record, 'dates', '时区', offsetTime);

  const exposureBias = rationalValue(ifd.get(0x9204)?.value);
  if (exposureBias !== null) {
    addField(record, 'capture', '曝光补偿', `${exposureBias > 0 ? '+' : ''}${round(exposureBias, 2)} EV`);
  }

  const metering = numberValue(ifd.get(0x9207)?.value);
  if (metering !== null) addField(record, 'capture', '测光模式', METERING_MODE[metering] || `值 ${metering}`);

  const flash = numberValue(ifd.get(0x9209)?.value);
  if (flash !== null) addField(record, 'capture', '闪光灯', FLASH[flash] || `值 ${flash}`);

  const focal = rationalValue(ifd.get(0x920a)?.value);
  if (focal) addField(record, 'capture', '焦距', `${round(focal, 1)} mm`);

  const focal35 = numberValue(ifd.get(0xa405)?.value);
  if (focal35) addField(record, 'capture', '35mm 等效焦距', `${focal35} mm`);

  const pixelX = numberValue(ifd.get(0xa002)?.value);
  const pixelY = numberValue(ifd.get(0xa003)?.value);
  if (pixelX) record.width = record.width || pixelX;
  if (pixelY) record.height = record.height || pixelY;

  const exposureMode = numberValue(ifd.get(0xa402)?.value);
  if (exposureMode !== null) {
    addField(
      record,
      'capture',
      '曝光模式',
      exposureMode === 1 ? '手动' : exposureMode === 2 ? '自动' : `值 ${exposureMode}`,
    );
  }
  const whiteBalance = numberValue(ifd.get(0xa403)?.value);
  if (whiteBalance !== null) {
    addField(
      record,
      'capture',
      '白平衡',
      whiteBalance === 0 ? '自动' : whiteBalance === 1 ? '手动' : `值 ${whiteBalance}`,
    );
  }

  const lensMake = stringValue(ifd, 0xa433);
  const lensModel = stringValue(ifd, 0xa434);
  if (lensMake) addField(record, 'camera', '镜头制造商', lensMake);
  if (lensModel) addField(record, 'camera', '镜头', lensModel);

  const owner = stringValue(ifd, 0xa430);
  if (owner) addField(record, 'rights', '相机所有者', owner);

  const bodySerial = stringValue(ifd, 0xa431);
  if (bodySerial) {
    addField(record, 'camera', '机身序列号', bodySerial);
    record.raw.bodySerial = bodySerial;
  }
  const lensSerial = stringValue(ifd, 0xa435);
  if (lensSerial) {
    addField(record, 'camera', '镜头序列号', lensSerial);
    record.raw.lensSerial = lensSerial;
  }

  const comment = decodeUserComment(ifd.get(0x9286)?.value);
  if (comment) addField(record, 'descriptions', '用户注释', truncate(comment, 300));

  const subjectArea = ifd.get(0x9214)?.value;
  if (Array.isArray(subjectArea) && subjectArea.length) {
    addField(record, 'capture', '主体区域', subjectArea.join(' / '));
  }
}

function mapGpsIfd(ifd, record) {
  if (!ifd.size) return null;
  const lat = gpsCoordinate(ifd.get(0x0002)?.value);
  const lon = gpsCoordinate(ifd.get(0x0004)?.value);
  const latRef = stringValue(ifd, 0x0001) || 'N';
  const lonRef = stringValue(ifd, 0x0003) || 'E';
  if (lat === null || lon === null) return null;
  const latitude = latRef.toUpperCase() === 'S' ? -lat : lat;
  const longitude = lonRef.toUpperCase() === 'W' ? -lon : lon;

  const altitude = rationalValue(ifd.get(0x0006)?.value);
  const altitudeRef = numberValue(ifd.get(0x0005)?.value);
  const altitudeValue = altitude === null ? null : altitudeRef === 1 ? -altitude : altitude;
  const direction = rationalValue(ifd.get(0x0011)?.value);
  const hp = rationalValue(ifd.get(0x001f)?.value);
  const dateStamp = stringValue(ifd, 0x001d);
  const timeStamp = gpsTime(ifd.get(0x0007)?.value);
  const timestamp = dateStamp
    ? `${dateStamp.replaceAll(':', '-')}${timeStamp ? ` ${timeStamp}` : ''} UTC`
    : '';

  addField(
    record,
    'location',
    'GPS 坐标',
    `${Math.abs(latitude).toFixed(6)}° ${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(6)}° ${longitude >= 0 ? 'E' : 'W'}`,
  );
  addField(record, 'location', '纬度', `${latitude.toFixed(6)}`);
  addField(record, 'location', '经度', `${longitude.toFixed(6)}`);
  if (altitudeValue !== null) addField(record, 'location', '海拔', `${round(altitudeValue, 1)} m`);
  if (direction !== null) addField(record, 'location', '拍摄方向', `${round(direction, 0)}°`);
  if (hp !== null) addField(record, 'location', '水平定位精度', `±${round(hp, 0)} m`);
  if (timestamp) addField(record, 'location', '定位时间', timestamp);

  return { latitude, longitude, altitude: altitudeValue, timestamp };
}

/* -------------------------------------------------------------------------- */
/* XMP                                                                         */
/* -------------------------------------------------------------------------- */

function parseXmp(xml, record) {
  if (!xml || !/<[a-zA-Z]/.test(xml)) return;
  record.hasXmp = true;
  const attributes = new Map();
  for (const match of xml.matchAll(/([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) {
    attributes.set(match[1], decodeXmlEntities(match[2]));
  }
  const textOf = (name) => {
    const direct = attributes.get(name);
    if (direct) return direct;
    const element = elementText(xml, name);
    return element ? decodeXmlEntities(element) : '';
  };

  record.xmpPropertyCount = Math.max(record.xmpPropertyCount, attributes.size);

  const creator = textOf('dc:creator');
  if (creator) addField(record, 'rights', '作者（XMP）', truncate(creator, 180));
  const rights = textOf('dc:rights');
  if (rights) addField(record, 'rights', '版权（XMP）', truncate(rights, 180));
  const title = textOf('dc:title');
  if (title) addField(record, 'descriptions', '标题（XMP）', truncate(title, 180));
  const description = textOf('dc:description');
  if (description) addField(record, 'descriptions', '说明（XMP）', truncate(description, 260));
  const subjects = textOf('dc:subject');
  if (subjects) addField(record, 'descriptions', '关键词（XMP）', truncate(subjects, 220));

  const creatorTool = textOf('xmp:CreatorTool');
  if (creatorTool) addField(record, 'software', '创作工具', creatorTool);
  const createDate = textOf('xmp:CreateDate');
  if (createDate) addField(record, 'dates', 'XMP 创建时间', formatDate(createDate));
  const modifyDate = textOf('xmp:ModifyDate');
  if (modifyDate) addField(record, 'dates', 'XMP 修改时间', formatDate(modifyDate));

  const city = textOf('photoshop:City') || textOf('Iptc4xmpCore:Location');
  const state = textOf('photoshop:State');
  const country = textOf('photoshop:Country') || textOf('Iptc4xmpCore:CountryCode');
  if (city) addField(record, 'location', '城市（XMP）', city);
  if (state) addField(record, 'location', '省 / 州（XMP）', state);
  if (country) addField(record, 'location', '国家 / 地区（XMP）', country);

  const xmpLat = parseXmpCoordinate(textOf('exif:GPSLatitude'), textOf('exif:GPSLatitudeRef'));
  const xmpLon = parseXmpCoordinate(textOf('exif:GPSLongitude'), textOf('exif:GPSLongitudeRef'));
  if (xmpLat !== null && xmpLon !== null) {
    record.xmpGps = { latitude: xmpLat, longitude: xmpLon };
  }

  const serial =
    textOf('aux:SerialNumber') ||
    textOf('aux:LensSerialNumber') ||
    textOf('exif:BodySerialNumber') ||
    textOf('exif:LensSerialNumber');
  if (serial) {
    addField(record, 'camera', '序列号（XMP）', serial);
    record.raw.xmpSerial = serial;
  }

  if (record.xmpPropertyCount) {
    addField(record, 'xmp', '属性数量', `${record.xmpPropertyCount} 项`);
    const highlight = [
      ['dc:format', '格式'],
      ['xmp:Rating', '评分'],
      ['xmp:Label', '标签'],
      ['photoshop:Headline', '标题'],
      ['Iptc4xmpCore:CreatorContactInfo', '联系方式'],
    ];
    for (const [key, label] of highlight) {
      const value = textOf(key);
      if (value) addField(record, 'xmp', label, truncate(decodeXmlEntities(value), 160));
    }
  }
}

function parseXmpCoordinate(value, ref = '') {
  if (!value) return null;
  const text = String(value).trim();
  const hemisphere = (text.match(/[NSEW]/i) || [ref])[0]?.toUpperCase();
  const numbers = text
    .replace(/[NSEW]/gi, '')
    .split(/[,;\s]+/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
  if (!numbers.length) return null;
  let degrees = numbers[0] || 0;
  if (numbers.length > 1) degrees += numbers[1] / 60;
  if (numbers.length > 2) degrees += numbers[2] / 3600;
  if (hemisphere === 'S' || hemisphere === 'W') degrees *= -1;
  return degrees;
}

/* -------------------------------------------------------------------------- */
/* IPTC                                                                        */
/* -------------------------------------------------------------------------- */

function parsePhotoshopIptc(payload, record) {
  if (!startsWithAscii(payload, 'Photoshop 3.0\0')) return;
  let offset = 14;
  while (offset + 12 <= payload.length) {
    if (ascii(payload, offset, 4) !== '8BIM') break;
    const resourceId = (payload[offset + 4] << 8) | payload[offset + 5];
    offset += 6;
    const nameLength = payload[offset];
    offset += 1 + nameLength;
    if ((1 + nameLength) % 2) offset += 1;
    if (offset + 4 > payload.length) break;
    const size =
      (payload[offset] << 24) |
      (payload[offset + 1] << 16) |
      (payload[offset + 2] << 8) |
      payload[offset + 3];
    offset += 4;
    if (size < 0 || offset + size > payload.length) break;
    if (resourceId === 0x0404) parseIptcDatasets(payload.subarray(offset, offset + size), record);
    offset += size + (size % 2);
  }
}

function parseIptcDatasets(data, record) {
  record.hasIptc = true;
  let offset = 0;
  while (offset + 5 <= data.length) {
    if (data[offset] !== 0x1c) {
      offset += 1;
      continue;
    }
    const recordNumber = data[offset + 1];
    const dataset = data[offset + 2];
    let size = (data[offset + 3] << 8) | data[offset + 4];
    offset += 5;
    if (size & 0x8000) {
      const lengthBytes = size & 0x7fff;
      size = 0;
      for (let index = 0; index < lengthBytes; index += 1) size = size * 256 + data[offset + index];
      offset += lengthBytes;
    }
    if (size < 0 || offset + size > data.length) break;
    const value = decodeText(data.subarray(offset, offset + size));
    offset += size;
    const mapping = IPTC_LABELS[`${recordNumber}:${dataset}`];
    if (mapping && value.trim()) {
      const clean = cleanText(value);
      addField(record, mapping[0], mapping[1], truncate(clean, 300));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function finalizeRecord(record) {
  if (!record.hasGps && record.xmpGps) {
    record.gps = {
      latitude: record.xmpGps.latitude,
      longitude: record.xmpGps.longitude,
      altitude: null,
      timestamp: '',
    };
    record.hasGps = true;
    addField(
      record,
      'location',
      'GPS 坐标（XMP）',
      `${Math.abs(record.gps.latitude).toFixed(6)}° ${record.gps.latitude >= 0 ? 'N' : 'S'}, ${Math.abs(record.gps.longitude).toFixed(6)}° ${record.gps.longitude >= 0 ? 'E' : 'W'}`,
    );
    addField(record, 'location', '纬度（XMP）', record.gps.latitude.toFixed(6));
    addField(record, 'location', '经度（XMP）', record.gps.longitude.toFixed(6));
  }

  if (record.hasGps && record.gps) {
    const lat = `${Math.abs(record.gps.latitude).toFixed(4)}${record.gps.latitude >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(record.gps.longitude).toFixed(4)}${record.gps.longitude >= 0 ? 'E' : 'W'}`;
    record.risks.push({
      id: 'gps',
      severity: 'high',
      label: '精确位置',
      detail: `${lat}, ${lon}`,
    });
  }
  if (record.raw.bodySerial) {
    record.risks.push({
      id: 'serial',
      severity: 'high',
      label: '机身序列号',
      detail: '可用于关联同一台相机',
    });
  }
  if (record.raw.lensSerial) {
    record.risks.push({ id: 'lens-serial', severity: 'high', label: '镜头序列号', detail: '唯一设备标识' });
  }
  if (record.raw.xmpSerial && record.raw.xmpSerial !== record.raw.bodySerial && record.raw.xmpSerial !== record.raw.lensSerial) {
    record.risks.push({ id: 'xmp-serial', severity: 'high', label: '设备序列号', detail: 'XMP 中写入' });
  }

  const rights = record.groups.get('rights') || [];
  if (rights.some((row) => /作者|所有者|版权/.test(row.label))) {
    record.risks.push({
      id: 'identity',
      severity: 'medium',
      label: '作者 / 版权',
      detail: '可能包含真实姓名',
    });
  }

  const dates = record.groups.get('dates') || [];
  if (dates.some((row) => /拍摄时间|原始时间|创建时间/.test(row.label))) {
    record.risks.push({
      id: 'timestamp',
      severity: 'medium',
      label: '拍摄时间',
      detail: dates.find((row) => /拍摄时间|原始时间|创建时间/.test(row.label))?.value || '',
    });
  }

  const descriptions = record.groups.get('descriptions') || [];
  if (descriptions.some((row) => /关键词|说明|注释/.test(row.label)) && record.hasIptc) {
    record.risks.push({ id: 'iptc', severity: 'low', label: '描述与关键词', detail: 'IPTC / XMP 文稿字段' });
  }

  if (!record.hasGps && !record.risks.length) {
    const camera = record.groups.get('camera') || [];
    if (camera.length) {
      record.risks.push({
        id: 'device',
        severity: 'low',
        label: '相机型号',
        detail: '不含位置，但可识别设备',
      });
    }
  }

  record.risks.sort((a, b) => riskWeight(a.severity) - riskWeight(b.severity));

  addField(record, 'file', '文件名', record.fileName, { always: true });
  addField(record, 'file', '格式', record.format === 'jpeg' ? 'JPEG' : record.format.toUpperCase(), {
    always: true,
  });
  addField(
    record,
    'file',
    '尺寸',
    record.width && record.height ? `${record.width} × ${record.height} px` : '未知',
    { always: true },
  );
  addField(record, 'file', '文件大小', formatBytes(record.byteSize), { always: true });
  addField(record, 'file', '色彩空间', record.colorSpace, { always: true });
  addField(record, 'file', '隐藏信息占用', formatBytes(record.metadataBytes), {
    always: true,
    note: record.metadataBytes ? '清除后可减少文件体积' : '未发现常见隐私元数据',
  });

  if (record.groups.get('xmp')) {
    addField(record, 'xmp', '说明', 'XMP 可包含多个命名空间的隐藏字段');
  }

  record.summary = summaryOf(record);
  record.groups = new Map(
    GROUP_ORDER.map((id) => [
      id,
      (record.groups.get(id) || []).filter((row, index, list) => {
        return list.findIndex((other) => other.label === row.label && other.value === row.value) === index;
      }),
    ]).filter(([, rows]) => rows.length > 0),
  );
  record.groupList = groupList(record);
}

function addField(record, group, label, value, options = {}) {
  if (value === null || value === undefined) return;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text && !options.always) return;
  if (!record.groups.has(group)) record.groups.set(group, []);
  const rows = record.groups.get(group);
  const existing = rows.find((row) => row.label === label);
  if (existing) {
    if (existing.value !== text && !existing.value.includes(text)) existing.value += ` / ${text}`;
    return;
  }
  rows.push({
    label,
    value: text || '—',
    note: options.note || '',
    mono: Boolean(options.mono),
  });
}

function riskWeight(severity) {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

function parseIccHeader(data, record) {
  if (data.length < 20) return;
  const color = decodeText(data.subarray(16, 20)).trim();
  const sizes = { RGB: 'RGB', GRAY: '灰度', CMYK: 'CMYK', LAB: 'Lab' };
  if (sizes[color]) record.colorSpace = `ICC ${sizes[color]}`;
}

function pngColorSpace(colorType) {
  const names = { 0: '灰度', 2: 'RGB', 3: '索引色', 4: '灰度 + Alpha', 6: 'RGBA' };
  return names[colorType] || `PNG 色彩类型 ${colorType}`;
}

function gpsCoordinate(value) {
  if (!Array.isArray(value)) return null;
  const numbers = value.map(rationalValue);
  if (numbers.some((number) => number === null)) return null;
  if (numbers.length < 2) return numbers[0] ?? null;
  return numbers[0] + numbers[1] / 60 + (numbers[2] || 0) / 3600;
}

function gpsTime(value) {
  if (!Array.isArray(value)) return '';
  const parts = value.map(rationalValue);
  if (parts.some((part) => part === null)) return '';
  return parts.map((part) => pad2(Math.round(part))).join(':');
}

function rationalValue(value) {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
    return value[1] === 0 ? null : value[0] / value[1];
  }
  if (typeof value === 'number') return value;
  if (value instanceof Uint8Array && value.length) return value[0];
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  return null;
}

function numberValue(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Uint8Array && value.length) return value[0];
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  return null;
}

function stringValue(ifd, tag) {
  const value = ifd.get(tag)?.value;
  if (typeof value === 'string') return cleanText(value);
  if (value instanceof Uint8Array) return cleanText(decodeText(value));
  return '';
}

function bytesValue(ifd, tag) {
  const value = ifd.get(tag)?.value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === 'string') return value;
  return null;
}

function unicodeValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value);
  try {
    return cleanText(new TextDecoder('utf-16le').decode(value));
  } catch {
    return '';
  }
}

function decodeUserComment(value) {
  if (!(value instanceof Uint8Array) || value.length < 8) return '';
  const prefix = ascii(value, 0, 8);
  const body = value.subarray(8);
  if (prefix.startsWith('ASCII')) return cleanText(decodeText(body));
  if (prefix.startsWith('UNICODE')) {
    try {
      return cleanText(new TextDecoder('utf-16le').decode(body));
    } catch {
      return '';
    }
  }
  return cleanText(decodeText(body));
}

function elementText(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  return match[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function reencodeImage(blob, mime = 'image/jpeg', quality = 0.95) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('当前环境无法重新编码图片');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { alpha: mime !== 'image/jpeg' });
  if (!context) throw new Error('无法创建画布');
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const output = await canvasToBlob(canvas, mime, quality);
  return { blob: output, width: canvas.width, height: canvas.height };
}

export function canvasToBlob(canvas, mime = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('浏览器未能编码这张图片'));
      },
      mime,
      quality,
    );
  });
}

function read24LE(data, offset) {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

function readUint32LE(data, offset) {
  return (
    (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>>
    0
  );
}

function ascii(bytes, offset, length) {
  let result = '';
  const end = Math.min(bytes.length, offset + length);
  for (let index = offset; index < end; index += 1) result += String.fromCharCode(bytes[index]);
  return result;
}

function startsWithAscii(bytes, text) {
  if (!bytes || bytes.length < text.length) return false;
  return ascii(bytes, 0, text.length) === text;
}

function decodeText(bytes) {
  if (!bytes || !bytes.length) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function cleanText(text) {
  return String(text || '')
    .replaceAll('\u0000', '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, length) {
  if (!text) return '';
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function pad2(number) {
  return String(number).padStart(2, '0');
}

function round(number, decimals = 0) {
  if (!Number.isFinite(number)) return '—';
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

function formatExposureTime(seconds) {
  if (!seconds) return '';
  if (seconds >= 1) return `${round(seconds, 1)} 秒`;
  const denominator = Math.round(1 / seconds);
  return `1/${denominator} 秒`;
}
