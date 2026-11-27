import { DEFAULT_WATERMARK } from './watermark.js';

const BASE = { ...DEFAULT_WATERMARK };

/**
 * Each preset returns editable layers, not an opaque watermark image.
 * Layers are stored top-first to match the layer manager.
 */
export const WATERMARK_PRESETS = [
  {
    id: 'signature',
    name: '低调署名',
    hint: '右下角小字',
    tone: 'warm',
    marks: [{ text: '© 2026 你的名字', position: 'br', strong: true }],
    layers: [
      {
        name: '署名',
        text: '© 2026 你的名字',
        size: 3.4,
        opacity: 0.72,
        position: 'bottom-right',
        margin: 3.6,
      },
    ],
  },
  {
    id: 'studio',
    name: '工作室',
    hint: '主名称 + 网址',
    tone: 'night',
    marks: [
      { text: 'WWW.YOURSTUDIO.COM', position: 'tr', small: true },
      { text: 'YOUR STUDIO', position: 'bl', strong: true },
    ],
    layers: [
      {
        name: '网址',
        text: 'WWW.YOURSTUDIO.COM',
        font: 'mono',
        weight: 400,
        size: 1.35,
        opacity: 0.55,
        position: 'top-right',
        margin: 3.4,
        shadow: false,
      },
      {
        name: '工作室名',
        text: 'YOUR STUDIO',
        weight: 700,
        size: 5.8,
        opacity: 0.92,
        position: 'bottom-left',
        margin: 4.2,
      },
    ],
  },
  {
    id: 'social',
    name: '社媒账号',
    hint: '账号 + 设备标签',
    tone: 'forest',
    marks: [
      { text: 'SHOT ON CLEANFRAME', position: 'tl', small: true },
      { text: '@your_handle', position: 'br', strong: true },
    ],
    layers: [
      {
        name: '设备标签',
        text: 'SHOT ON CLEANFRAME',
        font: 'mono',
        weight: 400,
        size: 1.35,
        opacity: 0.42,
        position: 'top-left',
        margin: 3.6,
        shadow: false,
      },
      {
        name: '账号',
        text: '@your_handle',
        weight: 600,
        size: 3.2,
        opacity: 0.8,
        position: 'bottom-right',
        margin: 3.8,
      },
    ],
  },
  {
    id: 'film',
    name: '胶片边注',
    hint: '片名 + 日期',
    tone: 'mono',
    marks: [
      { text: 'KODAK 400', position: 'bl', strong: true },
      { text: '2026 · SHANGHAI', position: 'br', small: true },
    ],
    layers: [
      {
        name: '片名',
        text: 'KODAK 400',
        font: 'mono',
        weight: 500,
        size: 2.5,
        color: '#f4e6c6',
        opacity: 0.85,
        position: 'bottom-left',
        margin: 4.4,
      },
      {
        name: '片号与日期',
        text: '2026 · SHANGHAI',
        font: 'mono',
        weight: 400,
        size: 1.6,
        color: '#f4e6c6',
        opacity: 0.62,
        position: 'bottom-right',
        margin: 4.4,
        shadow: false,
      },
    ],
  },
  {
    id: 'guard',
    name: '防盗图',
    hint: '整图平铺，适合样片',
    tone: 'cool',
    marks: [{ text: 'PREVIEW · DO NOT COPY', position: 'center', tile: true }],
    layers: [
      {
        name: '防盗图平铺',
        text: 'PREVIEW · DO NOT COPY',
        font: 'mono',
        weight: 500,
        size: 2.3,
        opacity: 0.3,
        position: 'middle-center',
        margin: 0,
        rotation: -18,
        tile: true,
        shadow: false,
      },
    ],
  },
  {
    id: 'date',
    name: '日期地点',
    hint: '时间 + 地点',
    tone: 'warm',
    marks: [
      { text: '2026.11.27', position: 'br', strong: true },
      { text: 'SHANGHAI · CN', position: 'bl', small: true },
    ],
    layers: [
      {
        name: '日期',
        text: '2026.11.27',
        font: 'mono',
        weight: 500,
        size: 3.6,
        opacity: 0.8,
        position: 'bottom-right',
        margin: 4.2,
      },
      {
        name: '地点',
        text: 'SHANGHAI · CN',
        font: 'mono',
        weight: 400,
        size: 1.5,
        opacity: 0.55,
        position: 'bottom-left',
        margin: 4.2,
        shadow: false,
      },
    ],
  },
  {
    id: 'brand',
    name: '品牌角标',
    hint: '醒目品牌名',
    tone: 'lime',
    marks: [{ text: '净帧 CLEANFRAME', position: 'br', accent: true, strong: true }],
    layers: [
      {
        name: '品牌角标',
        text: '净帧 CLEANFRAME',
        weight: 700,
        size: 3.2,
        color: '#d8ff3e',
        opacity: 0.9,
        position: 'bottom-right',
        margin: 4,
      },
    ],
  },
];

export function findPreset(presetId) {
  return WATERMARK_PRESETS.find((preset) => preset.id === presetId) || WATERMARK_PRESETS[0];
}

export function presetLayers(presetId, makeId = (() => {
  let count = 0;
  return () => `watermark-${Date.now().toString(36)}-${++count}`;
})()) {
  const preset = findPreset(presetId);
  return preset.layers.map((layer, index) => ({
    ...BASE,
    ...layer,
    id: makeId(),
    name: layer.name || `水印 ${index + 1}`,
    enabled: true,
    logoDataUrl: '',
  }));
}

export function defaultLayer(makeId) {
  return {
    ...BASE,
    id: makeId(),
    name: '文字图层',
    enabled: true,
    logoDataUrl: '',
  };
}
