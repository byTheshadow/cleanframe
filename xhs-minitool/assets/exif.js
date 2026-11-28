/**
 * CleanFrame XHS - EXIF / metadata *reader*.
 *
 * Scope note: the mini-tool never performs byte-level metadata surgery on the
 * original file. Every export path goes through a canvas re-encode, so the
 * output carries no APP segments at all. This module therefore only READS
 * metadata, to show the user what is about to be thrown away.
 *
 * Classic script. No modules, no network, Chrome 61 / ES2017 baseline.
 */
(function (global) {
  'use strict';

  var ORIENTATION_LABEL = {
    1: '正常',
    2: '水平翻转',
    3: '旋转 180°',
    4: '垂直翻转',
    5: '转置',
    6: '旋转 90°',
    7: '反转置',
    8: '旋转 270°',
  };

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  var GPS_IFD = 0x8825;
  var EXIF_IFD = 0x8769;
  var TAG_ORIENTATION = 0x0112;

  // ---------------------------------------------------------------- helpers

  function u16(dv, off, le) {
    return le ? dv.getUint16(off, true) : dv.getUint16(off, false);
  }

  function u32(dv, off, le) {
    return le ? dv.getUint32(off, true) : dv.getUint32(off, false);
  }

  function decodeText(bytes, start, length) {
    var end = Math.min(bytes.length, start + length);
    var slice = bytes.subarray(start, end);
    var cut = slice.length;
    for (var i = 0; i < slice.length; i += 1) {
      if (slice[i] === 0) {
        cut = i;
        break;
      }
    }
    slice = slice.subarray(0, cut);
    if (!slice.length) return '';
    if (typeof TextDecoder === 'function') {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(slice);
      } catch (err) {
        /* not valid utf-8, fall through to latin1 */
      }
    }
    var out = '';
    for (var j = 0; j < slice.length; j += 1) {
      out += String.fromCharCode(slice[j]);
    }
    return out;
  }

  function trim(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^ | $/g, '');
  }

  function pad2(number) {
    return number < 10 ? '0' + number : String(number);
  }

  function formatExifDate(raw) {
    var text = trim(raw);
    var match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
    if (!match) {
      // GPSDateStamp has no time part: "2026:10:18".
      var dateOnly = /^(\d{4}):(\d{2}):(\d{2})$/.exec(text);
      if (dateOnly) return dateOnly[1] + '-' + dateOnly[2] + '-' + dateOnly[3];
      return text;
    }
    var out = match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4] + ':' + match[5];
    if (match[6] && match[6] !== '00') out += ':' + match[6];
    return out;
  }

  function startsWith(bytes, offset, text) {
    if (offset + text.length > bytes.length) return false;
    for (var i = 0; i < text.length; i += 1) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  function ascii(bytes, offset, length) {
    var out = '';
    for (var i = 0; i < length && offset + i < bytes.length; i += 1) {
      out += String.fromCharCode(bytes[offset + i]);
    }
    return out;
  }

  /** Decode a byte range as UTF-8 (XMP / IPTC payloads are UTF-8 by spec). */
  function utf8(bytes, offset, length) {
    var end = Math.min(bytes.length, offset + length);
    if (end <= offset) return '';
    var slice = bytes.subarray(offset, end);
    if (typeof TextDecoder === 'function') {
      try {
        return new TextDecoder('utf-8').decode(slice);
      } catch (err) {
        /* fall through */
      }
    }
    return ascii(bytes, offset, length);
  }

  function formatBytes(size) {
    if (!size) return '0 B';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function detectFormat(bytes) {
    if (bytes.length < 12) return 'unknown';
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
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
    return 'unknown';
  }

  function mimeForFormat(format) {
    if (format === 'jpeg') return 'image/jpeg';
    if (format === 'png') return 'image/png';
    if (format === 'webp') return 'image/webp';
    return 'application/octet-stream';
  }

  // ------------------------------------------------------------- TIFF / EXIF

  function readIfd(dv, bytes, tiffStart, le, ifdOffset) {
    var absolute = tiffStart + ifdOffset;
    if (absolute + 2 > bytes.length) return null;
    var count = u16(dv, absolute, le);
    var entries = [];
    for (var i = 0; i < count; i += 1) {
      var entry = absolute + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      var type = u16(dv, entry + 2, le);
      var unit = TYPE_SIZE[type] || 1;
      var tagCount = u32(dv, entry + 4, le);
      var byteLength = unit * tagCount;
      var valueStart = byteLength > 4 ? tiffStart + u32(dv, entry + 8, le) : entry + 8;
      entries.push({
        tag: u16(dv, entry, le),
        type: type,
        count: tagCount,
        byteLength: byteLength,
        valueField: entry + 8,
        valueStart: valueStart,
      });
    }
    var next = 0;
    var nextPos = absolute + 2 + count * 12;
    if (nextPos + 4 <= bytes.length) next = u32(dv, nextPos, le);
    return { entries: entries, next: next };
  }

  function findEntry(ifd, tag) {
    if (!ifd) return null;
    for (var i = 0; i < ifd.entries.length; i += 1) {
      if (ifd.entries[i].tag === tag) return ifd.entries[i];
    }
    return null;
  }

  function readAsciiValue(bytes, entry) {
    if (!entry) return '';
    return trim(decodeText(bytes, entry.valueStart, entry.byteLength));
  }

  function readShortValue(dv, bytes, le, entry) {
    if (!entry || entry.byteLength < 2) return null;
    return u16(dv, entry.valueStart, le);
  }

  function readRationals(dv, bytes, le, entry) {
    if (!entry || entry.type !== 5) return [];
    var out = [];
    var count = Math.min(entry.count, 4);
    for (var i = 0; i < count; i += 1) {
      var pos = entry.valueStart + i * 8;
      if (pos + 8 > bytes.length) break;
      var num = u32(dv, pos, le);
      var den = u32(dv, pos + 4, le);
      out.push(den ? num / den : 0);
    }
    return out;
  }

  function degrees(rationals) {
    if (!rationals.length) return null;
    var deg = rationals[0] || 0;
    var min = rationals[1] || 0;
    var sec = rationals[2] || 0;
    return deg + min / 60 + sec / 3600;
  }

  function parseTiff(dv, bytes, tiffStart, record) {
    if (tiffStart + 8 > bytes.length) return;
    var b0 = bytes[tiffStart];
    var b1 = bytes[tiffStart + 1];
    var le;
    if (b0 === 0x49 && b1 === 0x49) le = true;
    else if (b0 === 0x4d && b1 === 0x4d) le = false;
    else return;
    if (u16(dv, tiffStart + 2, le) !== 0x2a) return;

    record.hasExif = true;
    record.byteOrder = le ? 'II' : 'MM';

    var ifd0 = readIfd(dv, bytes, tiffStart, le, u32(dv, tiffStart + 4, le));
    if (!ifd0) return;

    var orientation = readShortValue(dv, bytes, le, findEntry(ifd0, TAG_ORIENTATION));
    if (orientation >= 1 && orientation <= 8) record.orientation = orientation;

    var make = readAsciiValue(bytes, findEntry(ifd0, 0x010f));
    var model = readAsciiValue(bytes, findEntry(ifd0, 0x0110));
    var software = readAsciiValue(bytes, findEntry(ifd0, 0x0131));
    var modified = readAsciiValue(bytes, findEntry(ifd0, 0x0132));
    var artist = readAsciiValue(bytes, findEntry(ifd0, 0x013b));
    var copyright = readAsciiValue(bytes, findEntry(ifd0, 0x8298));
    var description = readAsciiValue(bytes, findEntry(ifd0, 0x010e));

    if (make) record.fields.push({ group: 'device', label: '相机品牌', value: make });
    if (model) record.fields.push({ group: 'device', label: '相机型号', value: model });
    if (description) record.fields.push({ group: 'other', label: '图像描述', value: description });
    if (artist) record.fields.push({ group: 'author', label: '作者', value: artist });
    if (copyright) record.fields.push({ group: 'author', label: '版权', value: copyright });
    if (modified) record.fields.push({ group: 'time', label: '修改时间', value: formatExifDate(modified) });
    if (software) record.fields.push({ group: 'software', label: '软件', value: software });

    // EXIF sub-IFD
    var exifEntry = findEntry(ifd0, EXIF_IFD);
    if (exifEntry && exifEntry.type === 4) {
      var exifIfd = readIfd(dv, bytes, tiffStart, le, u32(dv, exifEntry.valueStart, le));
      if (exifIfd) {
        var original = readAsciiValue(bytes, findEntry(exifIfd, 0x9003));
        var digitized = readAsciiValue(bytes, findEntry(exifIfd, 0x9004));
        var lens = readAsciiValue(bytes, findEntry(exifIfd, 0xa434));
        var bodySerial = readAsciiValue(bytes, findEntry(exifIfd, 0xa431));
        var lensSerial = readAsciiValue(bytes, findEntry(exifIfd, 0xa435));
        var comment = readAsciiValue(bytes, findEntry(exifIfd, 0x9286));
        var cameraSerial = readAsciiValue(bytes, findEntry(exifIfd, 0xc62f));
        if (original) {
          record.dateOriginal = formatExifDate(original);
          record.fields.push({ group: 'time', label: '拍摄时间', value: record.dateOriginal });
        }
        if (digitized) record.fields.push({ group: 'time', label: '数字化时间', value: formatExifDate(digitized) });
        if (lens) record.fields.push({ group: 'device', label: '镜头', value: lens });
        if (bodySerial) record.fields.push({ group: 'device', label: '机身序列号', value: bodySerial, risk: 'serial' });
        if (lensSerial) record.fields.push({ group: 'device', label: '镜头序列号', value: lensSerial, risk: 'serial' });
        if (cameraSerial) record.fields.push({ group: 'device', label: '相机序列号', value: cameraSerial, risk: 'serial' });
        if (comment) record.fields.push({ group: 'other', label: '用户注释', value: comment.slice(0, 80) });
      }
    }

    // GPS sub-IFD
    var gpsEntry = findEntry(ifd0, GPS_IFD);
    if (gpsEntry && gpsEntry.type === 4) {
      var gpsIfd = readIfd(dv, bytes, tiffStart, le, u32(dv, gpsEntry.valueStart, le));
      if (gpsIfd) {
        var latRef = readAsciiValue(bytes, findEntry(gpsIfd, 0x0001));
        var lat = degrees(readRationals(dv, bytes, le, findEntry(gpsIfd, 0x0002)));
        var lonRef = readAsciiValue(bytes, findEntry(gpsIfd, 0x0003));
        var lon = degrees(readRationals(dv, bytes, le, findEntry(gpsIfd, 0x0004)));
        if (lat !== null && lon !== null && (lat !== 0 || lon !== 0)) {
          if (latRef === 'S') lat = -lat;
          if (lonRef === 'W') lon = -lon;
          record.gps = { latitude: lat, longitude: lon };
          record.fields.push({
            group: 'location',
            label: 'GPS 坐标',
            value: lat.toFixed(5) + ', ' + lon.toFixed(5),
            risk: 'gps',
          });
          var altitude = readRationals(dv, bytes, le, findEntry(gpsIfd, 0x0006));
          if (altitude.length) {
            var alt = altitude[0];
            var ref = readShortValue(dv, bytes, le, findEntry(gpsIfd, 0x0005));
            if (ref === 1) alt = -alt;
            record.fields.push({ group: 'location', label: '海拔', value: alt.toFixed(1) + ' m', risk: 'gps' });
          }
          var stamp = readAsciiValue(bytes, findEntry(gpsIfd, 0x001d));
          if (stamp) {
            record.fields.push({ group: 'location', label: 'GPS 日期', value: formatExifDate(stamp), risk: 'gps' });
          }
        }
      }
    }

    // IFD1 = embedded thumbnail
    if (ifd0.next) {
      var ifd1 = readIfd(dv, bytes, tiffStart, le, ifd0.next);
      if (ifd1 && findEntry(ifd1, 0x0201) && findEntry(ifd1, 0x0202)) {
        record.hasThumbnail = true;
        record.fields.push({
          group: 'thumbnail',
          label: '内嵌缩略图',
          value: 'EXIF 缩略图（可能含未裁切的原始画面）',
          risk: 'thumbnail',
        });
      }
    }
  }

  // ------------------------------------------------------------------- JPEG

  var SOF_MARKERS = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];

  function isSof(marker) {
    for (var i = 0; i < SOF_MARKERS.length; i += 1) {
      if (SOF_MARKERS[i] === marker) return true;
    }
    return false;
  }

  function parseXmp(xml, record) {
    var creator = /<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xml);
    if (creator) {
      var name = trim(creator[1].replace(/<[^>]+>/g, ''));
      if (name) record.fields.push({ group: 'author', label: '作者（XMP）', value: name });
    }
    var title = /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xml);
    if (title) {
      var text = trim(title[1].replace(/<[^>]+>/g, ''));
      if (text) record.fields.push({ group: 'other', label: '标题（XMP）', value: text });
    }
    var city = /photoshop:City>([\s\S]*?)</.exec(xml);
    if (city) {
      record.fields.push({ group: 'location', label: '城市（XMP）', value: trim(city[1]), risk: 'gps' });
    }
  }

  var IPTC_LABELS = {
    5: { group: 'other', label: '对象名称' },
    25: { group: 'other', label: '关键词' },
    80: { group: 'author', label: '作者（IPTC）', risk: 'author' },
    85: { group: 'author', label: '作者职位' },
    90: { group: 'location', label: '城市（IPTC）', risk: 'gps' },
    101: { group: 'location', label: '国家（IPTC）', risk: 'gps' },
    110: { group: 'author', label: '版权声明（IPTC）', risk: 'author' },
    120: { group: 'other', label: '说明（IPTC）' },
  };

  function parseIptc(bytes, start, end, record) {
    var pos = start;
    while (pos + 12 < end) {
      if (!startsWith(bytes, pos, '8BIM')) {
        pos += 1;
        continue;
      }
      var id = (bytes[pos + 4] << 8) | bytes[pos + 5];
      var nameLength = bytes[pos + 6];
      // Pascal string = 1 length byte + name, padded to an even total length.
      var nameField = 1 + nameLength;
      if (nameField % 2 !== 0) nameField += 1;
      var sizePos = pos + 6 + nameField;
      if (sizePos + 4 > end) break;
      var size =
        ((bytes[sizePos] << 24) | (bytes[sizePos + 1] << 16) | (bytes[sizePos + 2] << 8) | bytes[sizePos + 3]) >>> 0;
      var dataStart = sizePos + 4;
      if (id === 0x0404) {
        parseIptcDatasets(bytes, dataStart, Math.min(dataStart + size, end), record);
        return true;
      }
      pos = dataStart + size + (size % 2);
    }
    return false;
  }

  function parseIptcDatasets(bytes, start, end, record) {
    var pos = start;
    while (pos + 5 <= end && bytes[pos] === 0x1c) {
      var recordNumber = bytes[pos + 1];
      var dataset = bytes[pos + 2];
      var length = (bytes[pos + 3] << 8) | bytes[pos + 4];
      var dataStart = pos + 5;
      if (dataStart + length > end) break;
      if (recordNumber === 2) {
        var meta = IPTC_LABELS[dataset];
        var text = trim(decodeText(bytes, dataStart, length));
        if (meta && text) {
          record.fields.push({ group: meta.group, label: meta.label, value: text, risk: meta.risk });
        }
      }
      pos = dataStart + length;
    }
  }

  function parseJpeg(dv, bytes, record) {
    var pos = 2;
    var guard = 0;
    while (pos + 3 < bytes.length && guard < 512) {
      guard += 1;
      if (bytes[pos] !== 0xff) {
        pos += 1;
        continue;
      }
      var marker = bytes[pos + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      if (marker === 0xd9) break;
      if (pos + 4 > bytes.length) break;
      var length = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (length < 2) break;
      var segStart = pos + 4;
      var segEnd = Math.min(pos + 2 + length, bytes.length);

      if (isSof(marker) && segEnd > segStart + 5) {
        record.height = (bytes[segStart + 1] << 8) | bytes[segStart + 2];
        record.width = (bytes[segStart + 3] << 8) | bytes[segStart + 4];
      } else if (marker === 0xe1 && startsWith(bytes, segStart, 'Exif')) {
        parseTiff(dv, bytes, segStart + 6, record);
      } else if (marker === 0xe1 && startsWith(bytes, segStart, 'http://ns.adobe.com/xap/1.0/')) {
        record.hasXmp = true;
        parseXmp(utf8(bytes, segStart, segEnd - segStart), record);
      } else if (marker === 0xe2 && startsWith(bytes, segStart, 'ICC_PROFILE')) {
        record.hasIcc = true;
      } else if (marker === 0xed && startsWith(bytes, segStart, 'Photoshop 3.0')) {
        record.hasIptc = true;
        parseIptc(bytes, segStart + 14, segEnd, record);
      }
      pos = segEnd;
    }
  }

  // -------------------------------------------------------------------- PNG

  var PNG_TEXT_LABELS = {
    Title: '标题',
    Author: '作者',
    Description: '描述',
    Comment: '注释',
    Software: '软件',
    Copyright: '版权',
    Creation: '创建时间',
  };

  var PNG_TEXT_GROUP = {
    Title: 'other',
    Author: 'author',
    Description: 'other',
    Comment: 'other',
    Software: 'software',
    Copyright: 'author',
    Creation: 'time',
  };

  function parsePng(dv, bytes, record) {
    var pos = 8;
    var guard = 0;
    while (pos + 8 <= bytes.length && guard < 4096) {
      guard += 1;
      var length = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
      var type = ascii(bytes, pos + 4, 4);
      var dataStart = pos + 8;
      var dataEnd = Math.min(dataStart + length, bytes.length);
      if (type === 'IHDR') {
        record.width =
          ((bytes[dataStart] << 24) |
            (bytes[dataStart + 1] << 16) |
            (bytes[dataStart + 2] << 8) |
            bytes[dataStart + 3]) >>>
          0;
        record.height =
          ((bytes[dataStart + 4] << 24) |
            (bytes[dataStart + 5] << 16) |
            (bytes[dataStart + 6] << 8) |
            bytes[dataStart + 7]) >>>
          0;
      } else if (type === 'eXIf') {
        parseTiff(dv, bytes, dataStart, record);
      } else if (type === 'tEXt') {
        var zero = dataStart;
        while (zero < dataEnd && bytes[zero] !== 0) zero += 1;
        var keyword = ascii(bytes, dataStart, zero - dataStart);
        var value = trim(decodeText(bytes, zero + 1, dataEnd - zero - 1));
        if (value) {
          record.fields.push({
            group: PNG_TEXT_GROUP[keyword] || 'other',
            label: PNG_TEXT_LABELS[keyword] || keyword,
            value: value,
          });
        }
      } else if (type === 'iTXt') {
        var p = dataStart;
        while (p < dataEnd && bytes[p] !== 0) p += 1;
        var iKeyword = ascii(bytes, dataStart, p - dataStart);
        var compressed = bytes[p + 1] === 1;
        p += 3;
        while (p < dataEnd && bytes[p] !== 0) p += 1;
        p += 1;
        while (p < dataEnd && bytes[p] !== 0) p += 1;
        p += 1;
        var iValue = compressed ? '' : trim(decodeText(bytes, p, dataEnd - p));
        if (iValue) {
          record.fields.push({
            group: PNG_TEXT_GROUP[iKeyword] || 'other',
            label: PNG_TEXT_LABELS[iKeyword] || iKeyword,
            value: iValue,
          });
        } else if (compressed) {
          record.fields.push({ group: 'other', label: iKeyword || 'iTXt', value: '压缩文本（未解析）' });
        }
      } else if (type === 'zTXt') {
        record.fields.push({ group: 'other', label: '压缩文本', value: 'zTXt 压缩文本（未解析）' });
      } else if (type === 'tIME') {
        var year = (bytes[dataStart] << 8) | bytes[dataStart + 1];
        record.fields.push({
          group: 'time',
          label: '修改时间',
          value: year + '-' + pad2(bytes[dataStart + 2]) + '-' + pad2(bytes[dataStart + 3]),
        });
      } else if (type === 'iCCP') {
        record.hasIcc = true;
      } else if (type === 'IDAT') {
        break;
      }
      if (type === 'IEND') break;
      pos = dataEnd + 4;
    }
  }

  // ------------------------------------------------------------------- WebP

  function parseWebp(dv, bytes, record) {
    var pos = 12;
    var guard = 0;
    while (pos + 8 <= bytes.length && guard < 64) {
      guard += 1;
      var fourcc = ascii(bytes, pos, 4);
      var length = bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24);
      var dataStart = pos + 8;
      if (length < 0) length = 0;
      var dataEnd = Math.min(dataStart + length, bytes.length);
      if (fourcc === 'VP8X' && dataEnd > dataStart + 9) {
        record.width = 1 + (bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16));
        record.height = 1 + (bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16));
      } else if (fourcc === 'VP8 ' && dataEnd > dataStart + 9) {
        record.width = (bytes[dataStart + 6] | (bytes[dataStart + 7] << 8)) & 0x3fff;
        record.height = (bytes[dataStart + 8] | (bytes[dataStart + 9] << 8)) & 0x3fff;
      } else if (fourcc === 'VP8L' && dataEnd > dataStart + 4) {
        var b1 = bytes[dataStart + 1];
        var b2 = bytes[dataStart + 2];
        var b3 = bytes[dataStart + 3];
        var b4 = bytes[dataStart + 4];
        record.width = 1 + (((b2 & 0x3f) << 8) | b1);
        record.height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      } else if (fourcc === 'EXIF') {
        parseTiff(dv, bytes, dataStart, record);
      } else if (fourcc === 'XMP ') {
        record.hasXmp = true;
        parseXmp(utf8(bytes, dataStart, dataEnd - dataStart), record);
      }
      pos = dataEnd + (length % 2);
    }
  }

  // -------------------------------------------------------------------- risk

  function someField(record, predicate) {
    for (var i = 0; i < record.fields.length; i += 1) {
      if (predicate(record.fields[i])) return true;
    }
    return false;
  }

  function buildRisks(record) {
    var risks = [];
    var seen = {};
    function push(id, level, label, detail) {
      if (seen[id]) return;
      seen[id] = true;
      risks.push({ id: id, level: level, label: label, detail: detail });
    }
    if (record.gps) {
      push('gps', 'high', '位置信息', '照片里带着拍摄地经纬度，能定位到街区级别。');
    }
    if (someField(record, function (f) { return f.risk === 'serial'; })) {
      push('serial', 'high', '设备序列号', '机身或镜头序列号能追踪同一台设备拍过的所有照片。');
    }
    if (someField(record, function (f) { return f.group === 'author'; })) {
      push('author', 'high', '作者信息', '署名或版权字段会暴露拍摄者身份。');
    }
    if (
      someField(record, function (f) {
        return f.label === '相机型号' || f.label === '相机品牌' || f.label === '镜头';
      })
    ) {
      push('device', 'medium', '设备信息', '品牌、型号和镜头可以指纹化你的设备。');
    }
    if (someField(record, function (f) { return f.group === 'time'; })) {
      push('time', 'medium', '时间信息', '拍摄和修改时间能拼出你的活动规律。');
    }
    if (someField(record, function (f) { return f.group === 'software'; })) {
      push('software', 'low', '软件信息', '暴露编辑软件和版本。');
    }
    if (record.hasXmp) push('xmp', 'low', 'XMP 段', '可读的 XML 描述，常带编辑链路和署名。');
    if (record.hasIptc) push('iptc', 'low', 'IPTC 段', '图库和新闻用的描述性元数据。');
    if (record.hasThumbnail) push('thumbnail', 'low', '内嵌缩略图', 'EXIF 缩略图可能保留未裁切的原始画面。');
    return risks;
  }

  var GROUP_ORDER = [
    { id: 'location', title: '位置' },
    { id: 'device', title: '设备' },
    { id: 'time', title: '时间' },
    { id: 'author', title: '作者' },
    { id: 'software', title: '软件' },
    { id: 'thumbnail', title: '缩略图' },
    { id: 'other', title: '其他' },
  ];

  function groupFields(fields) {
    var groups = [];
    for (var g = 0; g < GROUP_ORDER.length; g += 1) {
      var meta = GROUP_ORDER[g];
      var rows = [];
      for (var i = 0; i < fields.length; i += 1) {
        if (fields[i].group === meta.id) rows.push(fields[i]);
      }
      if (rows.length) groups.push({ id: meta.id, title: meta.title, rows: rows });
    }
    return groups;
  }

  // -------------------------------------------------------------------- API

  var SEGMENT_NOTES = [
    ['hasExif', 'EXIF'],
    ['hasXmp', 'XMP'],
    ['hasIptc', 'IPTC'],
    ['hasIcc', 'ICC 色彩配置'],
  ];

  function emptyRecord() {
    return {
      format: 'unknown',
      mime: 'application/octet-stream',
      width: 0,
      height: 0,
      orientation: 1,
      hasExif: false,
      hasXmp: false,
      hasIptc: false,
      hasIcc: false,
      hasThumbnail: false,
      gps: null,
      dateOriginal: '',
      fields: [],
      risks: [],
      groups: [],
      segments: [],
      byteSize: 0,
      byteOrder: '',
    };
  }

  /**
   * Parse metadata out of an ArrayBuffer. Pure function, no DOM.
   * @param {ArrayBuffer|Uint8Array} input
   * @param {number} [byteSize] original file size, for display
   */
  function parse(input, byteSize) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var record = emptyRecord();
    record.byteSize = typeof byteSize === 'number' ? byteSize : bytes.byteLength;
    record.format = detectFormat(bytes);
    record.mime = mimeForFormat(record.format);
    if (record.format === 'unknown') return record;

    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (record.format === 'jpeg') parseJpeg(dv, bytes, record);
    else if (record.format === 'png') parsePng(dv, bytes, record);
    else if (record.format === 'webp') parseWebp(dv, bytes, record);

    record.risks = buildRisks(record);
    record.groups = groupFields(record.fields);
    for (var i = 0; i < SEGMENT_NOTES.length; i += 1) {
      if (record[SEGMENT_NOTES[i][0]]) record.segments.push(SEGMENT_NOTES[i][1]);
    }
    record.orientationLabel = ORIENTATION_LABEL[record.orientation] || '未知';
    // Rotated orientations (5-8) swap displayed width and height.
    var swapped = record.orientation >= 5 && record.orientation <= 8;
    record.displayWidth = swapped ? record.height : record.width;
    record.displayHeight = swapped ? record.width : record.height;
    return record;
  }

  /**
   * Return a copy of a JPEG with the EXIF Orientation tag forced to 1.
   *
   * Why: Chrome 61 ignores EXIF orientation when drawing to canvas, while
   * Chrome 81+ applies it. Forcing the tag to 1 makes both read the same raw
   * pixels, so our own rotation matrix is the single source of truth.
   *
   * Length-preserving in-place tag write; no segment rebuild, no re-encode.
   */
  function neutralizeOrientation(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (detectFormat(bytes) !== 'jpeg') return { bytes: bytes, patched: false, reason: 'not-jpeg' };
    var copy = new Uint8Array(bytes);
    var dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    var pos = 2;
    var guard = 0;
    while (pos + 3 < copy.length && guard < 512) {
      guard += 1;
      if (copy[pos] !== 0xff) {
        pos += 1;
        continue;
      }
      var marker = copy[pos + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      if (marker === 0xd9) break;
      var length = (copy[pos + 2] << 8) | copy[pos + 3];
      if (length < 2) break;
      var segStart = pos + 4;
      if (marker === 0xe1 && startsWith(copy, segStart, 'Exif')) {
        var tiffStart = segStart + 6;
        var b0 = copy[tiffStart];
        var b1 = copy[tiffStart + 1];
        var le;
        if (b0 === 0x49 && b1 === 0x49) le = true;
        else if (b0 === 0x4d && b1 === 0x4d) le = false;
        else break;
        var ifd0 = readIfd(dv, copy, tiffStart, le, u32(dv, tiffStart + 4, le));
        if (!ifd0) break;
        var entry = findEntry(ifd0, TAG_ORIENTATION);
        if (!entry) return { bytes: copy, patched: false, reason: 'no-orientation-tag' };
        if (entry.type !== 3 || entry.count < 1) return { bytes: copy, patched: false, reason: 'unexpected-type' };
        if (le) dv.setUint16(entry.valueField, 1, true);
        else dv.setUint16(entry.valueField, 1, false);
        return { bytes: copy, patched: true, reason: 'ok' };
      }
      pos = Math.min(pos + 2 + length, copy.length);
    }
    return { bytes: copy, patched: false, reason: 'no-exif-segment' };
  }

  /** Read a File/Blob into an ArrayBuffer via FileReader (Chrome 61 safe). */
  function readArrayBuffer(blob, onDone, onError) {
    var reader = new FileReader();
    reader.onload = function () {
      onDone(reader.result);
    };
    reader.onerror = function () {
      onError(reader.error || new Error('FileReader 读取失败'));
    };
    reader.readAsArrayBuffer(blob);
  }

  global.CleanFrameExif = {
    parse: parse,
    readArrayBuffer: readArrayBuffer,
    detectFormat: detectFormat,
    mimeForFormat: mimeForFormat,
    neutralizeOrientation: neutralizeOrientation,
    formatBytes: formatBytes,
    orientationLabel: function (value) {
      return ORIENTATION_LABEL[value] || '未知';
    },
  };
})(typeof window !== 'undefined' ? window : this);
