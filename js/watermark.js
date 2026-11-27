/**
 * Canvas watermark renderer used by both the live preview and the
 * full-resolution export. Keeping one drawing routine guarantees that what
 * the user positions in the preview is what lands in the exported file.
 */

import { canvasToBlob } from './metadata.js';

export const DEFAULT_WATERMARK = {
  type: 'text',
  text: '© 2026 净帧',
  font: 'sans',
  weight: 600,
  color: '#ffffff',
  opacity: 0.78,
  size: 4.4,
  position: 'bottom-right',
  margin: 3.2,
  rotation: 0,
  shadow: true,
  tile: false,
  tileGap: 140,
  logoScale: 14,
};

export const FONT_STACKS = {
  sans: '"Helvetica Neue", "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif',
  serif: '"Iowan Old Style", "Songti SC", "SimSun", "Times New Roman", serif',
  mono: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
};

export const POSITION_OPTIONS = [
  { value: 'top-left', label: '左上' },
  { value: 'top-center', label: '上中' },
  { value: 'top-right', label: '右上' },
  { value: 'middle-left', label: '左中' },
  { value: 'middle-center', label: '居中' },
  { value: 'middle-right', label: '右中' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-center', label: '下中' },
  { value: 'bottom-right', label: '右下' },
];

export function normalizeWatermark(input = {}) {
  const config = { ...DEFAULT_WATERMARK, ...(input || {}) };
  return {
    ...config,
    type: config.type === 'logo' ? 'logo' : 'text',
    text: String(config.text ?? '').slice(0, 120),
    opacity: clamp(Number(config.opacity) || 0, 0.05, 1),
    size: clamp(Number(config.size) || DEFAULT_WATERMARK.size, 1.5, 18),
    margin: clamp(Number(config.margin) || 0, 0, 20),
    rotation: clamp(Number(config.rotation) || 0, -90, 90),
    logoScale: clamp(Number(config.logoScale) || DEFAULT_WATERMARK.logoScale, 3, 45),
    tileGap: clamp(Number(config.tileGap) || DEFAULT_WATERMARK.tileGap, 110, 320),
    weight: [300, 400, 500, 600, 700, 800].includes(Number(config.weight))
      ? Number(config.weight)
      : 600,
    color: /^#[0-9a-f]{6}$/i.test(config.color || '') ? config.color : '#ffffff',
    position: POSITION_OPTIONS.some((option) => option.value === config.position)
      ? config.position
      : 'bottom-right',
    font: FONT_STACKS[config.font] ? config.font : 'sans',
    shadow: Boolean(config.shadow),
    tile: Boolean(config.tile),
  };
}

export function normalizeLayer(raw = {}, index = 0) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const config = normalizeWatermark(raw);
  const fallbackName =
    config.type === 'logo'
      ? `图片标识 ${index + 1}`
      : String(config.text || '').split('\n')[0].trim().slice(0, 18) || `文字图层 ${index + 1}`;
  return {
    ...config,
    id: String(raw.id || `watermark-${index + 1}`),
    name: String(raw.name || fallbackName).slice(0, 40),
    enabled: raw.enabled !== false,
    logoDataUrl: typeof raw.logoDataUrl === 'string' ? raw.logoDataUrl : '',
  };
}

export function normalizeLayers(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  return list.map((layer, index) => normalizeLayer(layer, index));
}

function layerCanDraw(layer, logo) {
  if (layer.enabled === false) return false;
  return layer.type === 'logo' ? Boolean(logo) : Boolean(layer.text.trim());
}

export function hasVisibleWatermark(rawLayers, logos = {}) {
  return normalizeLayers(rawLayers).some((layer) => layerCanDraw(layer, logos[layer.id]));
}

export function outputMimeFor(inputMime, format = 'auto') {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  if (inputMime === 'image/png') return 'image/png';
  if (inputMime === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Render a watermark onto a full resolution image.
 * Metadata is inherently removed because the result is newly encoded.
 */
export async function renderWatermarked(blob, rawLayers, options = {}) {
  const layers = normalizeLayers(rawLayers);
  const logos = options.logos || {};
  if (!layers.some((layer) => layerCanDraw(layer, logos[layer.id]))) {
    throw new Error('没有可用的水印图层');
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }

  const width = bitmap.width;
  const height = bitmap.height;
  if (!width || !height) throw new Error('图片尺寸无效');
  if (width * height > 120_000_000) {
    throw new Error('图片超过 1.2 亿像素，浏览器无法安全处理');
  }

  const mime = options.mime || outputMimeFor(blob.type, options.format);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: mime !== 'image/jpeg' });
  if (!context) throw new Error('无法创建画布');

  if (mime === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  drawWatermarks(context, width, height, layers, logos);

  const output = await canvasToBlob(canvas, mime, options.quality ?? 0.92);
  return {
    blob: output,
    width,
    height,
    mime,
    layers,
    method: 'watermarked',
  };
}

/**
 * Draw every enabled layer. The first array item is the visual top layer,
 * so painting happens from back to front.
 */
export function drawWatermarks(context, width, height, rawLayers, logos = {}) {
  const layers = normalizeLayers(rawLayers);
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (!layerCanDraw(layer, logos[layer.id])) continue;
    drawWatermark(context, width, height, layer, { logo: logos[layer.id] });
  }
}

/**
 * Draw a watermark in any 2D context. Dimensions are CSS pixels.
 * `assets.logo` may be an HTMLImageElement, ImageBitmap or canvas.
 */
export function drawWatermark(context, width, height, rawConfig, assets = {}) {
  const config = normalizeWatermark(rawConfig);
  if (config.enabled === false) return;
  if (config.type === 'text' && !config.text.trim()) return;
  if (config.type === 'logo' && !assets.logo) return;

  const minSide = Math.min(width, height);
  if (!minSide) return;
  const fontSize = clamp(minSide * (config.size / 100), 10, minSide * 0.3);
  const margin = minSide * (config.margin / 100);

  context.save();
  context.globalAlpha = config.opacity;

  if (config.type === 'text') {
    drawTextWatermark(context, width, height, config, { fontSize, margin, minSide });
  } else {
    drawLogoWatermark(context, width, height, config, { margin, minSide, logo: assets.logo });
  }

  context.restore();
}

function drawTextWatermark(context, width, height, config, { fontSize, margin, minSide }) {
  const lines = config.text.split('\n').slice(0, 4);
  const family = FONT_STACKS[config.font];
  const font = `${config.weight} ${fontSize}px ${family}`;
  context.font = font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  if (typeof context.letterSpacing === 'string') {
    context.letterSpacing = `${Math.round(fontSize * 0.035)}px`;
  }

  const lineHeight = fontSize * 1.18;
  const widths = lines.map((line) => context.measureText(line).width);
  const textWidth = Math.max(...widths, 1);
  const textHeight = Math.max(lineHeight * lines.length, fontSize);

  if (config.shadow) {
    context.shadowColor = 'rgba(0, 0, 0, 0.38)';
    context.shadowBlur = Math.max(2, fontSize * 0.16);
    context.shadowOffsetX = 0;
    context.shadowOffsetY = Math.max(1, fontSize * 0.045);
  } else {
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
  }

  context.fillStyle = config.color;
  context.strokeStyle = config.color;
  context.lineWidth = Math.max(1, fontSize * 0.03);
  context.lineJoin = 'round';

  if (config.tile) {
    drawTiled(context, width, height, config, font, fontSize, minSide, (centerX, centerY) => {
      for (let index = 0; index < lines.length; index += 1) {
        context.fillText(lines[index], centerX, centerY + (index - (lines.length - 1) / 2) * lineHeight);
      }
    });
    return;
  }

  const center = anchorPosition(config.position, width, height, textWidth, textHeight, margin);
  context.save();
  context.translate(center.x, center.y);
  if (config.rotation) context.rotate((config.rotation * Math.PI) / 180);
  for (let index = 0; index < lines.length; index += 1) {
    const y = (index - (lines.length - 1) / 2) * lineHeight;
    context.fillText(lines[index], 0, y);
  }
  context.restore();
}

function drawLogoWatermark(context, width, height, config, { margin, minSide, logo }) {
  const naturalWidth = logo.naturalWidth || logo.width || 1;
  const naturalHeight = logo.naturalHeight || logo.height || 1;
  if (!naturalWidth || !naturalHeight) return;
  const logoWidth = minSide * (config.logoScale / 100);
  const logoHeight = (naturalHeight / naturalWidth) * logoWidth;

  if (config.shadow) {
    context.shadowColor = 'rgba(0, 0, 0, 0.4)';
    context.shadowBlur = Math.max(2, logoWidth * 0.08);
    context.shadowOffsetY = Math.max(1, logoWidth * 0.025);
  }

  if (config.tile) {
    drawTiled(context, width, height, config, '', 0, minSide, (centerX, centerY) => {
      context.drawImage(logo, centerX - logoWidth / 2, centerY - logoHeight / 2, logoWidth, logoHeight);
    });
    return;
  }

  const center = anchorPosition(config.position, width, height, logoWidth, logoHeight, margin);
  context.save();
  context.translate(center.x, center.y);
  if (config.rotation) context.rotate((config.rotation * Math.PI) / 180);
  context.drawImage(logo, -logoWidth / 2, -logoHeight / 2, logoWidth, logoHeight);
  context.restore();
}

function drawTiled(context, width, height, config, font, fontSize, minSide, drawAt) {
  context.save();
  context.translate(width / 2, height / 2);
  if (config.rotation) context.rotate((config.rotation * Math.PI) / 180);
  context.translate(-width / 2, -height / 2);
  if (font) context.font = font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const gap = minSide * (config.tileGap / 1000);
  const stepX = Math.max(fontSize * 5.5, minSide * 0.22) + gap;
  const stepY = Math.max(fontSize * 3.2, minSide * 0.12) + gap * 0.6;
  const diagonal = Math.hypot(width, height);
  const startX = -diagonal;
  const startY = -diagonal;
  const endX = width + diagonal;
  const endY = height + diagonal;
  let row = 0;
  for (let y = startY; y < endY; y += stepY) {
    const offsetX = row % 2 ? stepX / 2 : 0;
    for (let x = startX + offsetX; x < endX; x += stepX) {
      drawAt(x, y);
    }
    row += 1;
  }
  context.restore();
}

function anchorPosition(position, width, height, itemWidth, itemHeight, margin) {
  const [vertical, horizontal] = position.split('-');
  const centerX =
    horizontal === 'left'
      ? margin + itemWidth / 2
      : horizontal === 'right'
        ? width - margin - itemWidth / 2
        : width / 2;
  const centerY =
    vertical === 'top'
      ? margin + itemHeight / 2
      : vertical === 'bottom'
        ? height - margin - itemHeight / 2
        : height / 2;
  return { x: centerX, y: centerY };
}


function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
