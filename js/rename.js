import { sanitizeFileName } from './zip.js';

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i;

/**
 * Split a file name into base and extension without losing unusual names.
 * The extension is kept exactly as the user uploaded it.
 */
export function splitFileName(name) {
  const value = String(name || '').trim();
  const lastDot = value.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === value.length - 1) {
    return { base: value || '照片', extension: '' };
  }
  return {
    base: value.slice(0, lastDot),
    extension: value.slice(lastDot),
  };
}

function cleanPart(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function cleanSeparator(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4);
}

/**
 * Build a safe, sequential rename plan.
 *
 * @param {{name: string, extension?: string}[]} items
 * @param {{base?: string, prefix?: string, suffix?: string, numbering?: boolean, start?: number, digits?: number, separator?: string}} options
 */
export function buildRenamePlan(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return { plans: [], error: '先选择要改名的照片。', changed: false };
  }

  let base = String(options.base || '').trim();
  base = base.replace(IMAGE_EXTENSION, '').trim();
  const hasBaseInput = Boolean(base);
  const basePart = sanitizeFileName(base, '');
  const prefix = cleanPart(options.prefix);
  const suffix = cleanPart(options.suffix);
  const separator = cleanSeparator(options.separator ?? '-');
  const numbering = options.numbering !== false;
  const start = Math.max(0, Math.trunc(Number(options.start) || 1));
  const digits = Math.min(6, Math.max(1, Math.trunc(Number(options.digits) || 2)));

  const plans = [];
  let emptyName = false;
  if (hasBaseInput && !basePart) {
    return { plans: [], error: '新名称不能只包含不能使用的字符。', changed: false };
  }

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const split = splitFileName(item.name);
    const extension = split.extension || item.extension || '.jpg';
    const chosenBase = hasBaseInput ? basePart : split.base || '照片';
    const number = numbering ? String(start + index).padStart(digits, '0') : '';
    const core = `${prefix}${chosenBase}${suffix}${numbering ? `${separator}${number}` : ''}`;
    let cleanCore = sanitizeFileName(core, '');
    if (RESERVED_NAMES.test(cleanCore)) cleanCore = `_${cleanCore}`;
    if (!cleanCore) {
      emptyName = true;
      continue;
    }
    plans.push({
      oldName: String(item.name || ''),
      newName: `${cleanCore}${extension}`,
      extension,
    });
  }

  if (emptyName || plans.length !== list.length) {
    return { plans: [], error: '有些照片会得到空名称，请换一个名称。', changed: false };
  }

  const seen = new Map();
  for (const plan of plans) {
    const key = plan.newName.toLowerCase();
    if (seen.has(key)) {
      return {
        plans,
        error: `有重名：${seen.get(key)} 和 ${plan.newName}。请开启自动编号，或调整名称。`,
        changed: true,
      };
    }
    seen.set(key, plan.newName);
  }

  const changed = plans.some((plan) => plan.oldName !== plan.newName);
  return { plans, error: '', changed };
}

export function dateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
