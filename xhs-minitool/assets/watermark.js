/**
 * CleanFrame XHS - watermark templates.
 *
 * Ported from project/js/watermark.js, trimmed to what the mini-tool needs:
 * text layers only, no logo upload, no layer manager. Sizes are percentages of
 * the canvas short side, so the 540x720 preview and the 1080x1440 export stay
 * visually identical.
 *
 * Added on top of the web version: automatic contrast. A white mark vanishes on
 * a bright sky, so each layer samples the pixels underneath and picks white or
 * near-black ink. Falls back to white if the canvas is not readable (file://
 * previews can be treated as tainted).
 *
 * Classic script. Chrome 61 / ES2017 baseline.
 */
(function (global) {
  'use strict';

  var FONT_SANS =
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", Arial, sans-serif';
  var FONT_MONO = '"SFMono-Regular", "Cascadia Code", Consolas, monospace';

  var CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

  var LIGHT_INK = '#ffffff';
  var DARK_INK = '#16171a';

  /**
   * Each template declares slots: `primary` follows the user's corner choice,
   * `secondary` keeps its own corner so a date stays out of the way.
   */
  var TEMPLATES = [
    {
      id: 'none',
      name: '不加水印',
      hint: '只清理隐私',
      fields: [],
      layers: [],
    },
    {
      id: 'handle',
      name: '小红书号',
      hint: '右下角账号',
      fields: ['primary'],
      defaults: { primary: '@你的小红书号' },
      layers: [
        { slot: 'primary', font: 'sans', weight: 700, size: 4.4, opacity: 0.9, position: 'bottom-right', margin: 4.2 },
      ],
    },
    {
      id: 'minimal',
      name: '极简署名',
      hint: '小字不抢镜',
      fields: ['primary'],
      defaults: { primary: '© @你的名字' },
      layers: [
        { slot: 'primary', font: 'sans', weight: 500, size: 2.8, opacity: 0.72, position: 'bottom-right', margin: 4 },
      ],
    },
    {
      id: 'travel',
      name: '旅行记录',
      hint: '地点 + 日期',
      fields: ['primary', 'secondary'],
      defaults: { primary: '上海 · 外滩', secondary: '2026.11.27' },
      layers: [
        { slot: 'primary', font: 'sans', weight: 700, size: 3.6, opacity: 0.88, position: 'bottom-left', margin: 4.4 },
        { slot: 'secondary', font: 'mono', weight: 400, size: 2.1, opacity: 0.66, position: 'bottom-right', margin: 4.6 },
      ],
    },
    {
      id: 'shop',
      name: '探店',
      hint: '店名 + 账号',
      fields: ['primary', 'secondary'],
      defaults: { primary: '店名 / 品牌', secondary: '@你的小红书号' },
      layers: [
        { slot: 'primary', font: 'sans', weight: 800, size: 5.2, opacity: 0.92, position: 'bottom-left', margin: 4.4 },
        { slot: 'secondary', font: 'mono', weight: 500, size: 2, opacity: 0.6, position: 'top-right', margin: 4.6 },
      ],
    },
  ];

  function findTemplate(id) {
    for (var i = 0; i < TEMPLATES.length; i += 1) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return TEMPLATES[0];
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Normalise raw UI state into a safe drawable config. */
  function normalize(raw) {
    var input = raw || {};
    var template = findTemplate(input.template);
    var position = CORNERS.indexOf(input.position) === -1 ? 'bottom-right' : input.position;
    var color = input.color === 'light' || input.color === 'dark' ? input.color : 'auto';
    return {
      template: template.id,
      primary: String(input.primary == null ? '' : input.primary).slice(0, 28),
      secondary: String(input.secondary == null ? '' : input.secondary).slice(0, 28),
      position: position,
      color: color,
      enabled: template.id !== 'none',
    };
  }

  function defaultState(templateId) {
    var template = findTemplate(templateId || 'handle');
    var defaults = template.defaults || {};
    return normalize({
      template: template.id,
      primary: defaults.primary || '',
      secondary: defaults.secondary || '',
      position: (template.layers[0] && template.layers[0].position) || 'bottom-right',
      color: 'auto',
    });
  }

  function buildLayers(config) {
    var template = findTemplate(config.template);
    if (!config.enabled) return [];
    var layers = [];
    for (var i = 0; i < template.layers.length; i += 1) {
      var layer = template.layers[i];
      var text = layer.slot === 'secondary' ? config.secondary : config.primary;
      text = String(text || '')
        .replace(/\s+/g, ' ')
        .replace(/^ | $/g, '');
      if (!text) continue;
      layers.push({
        text: text,
        font: layer.font === 'mono' ? FONT_MONO : FONT_SANS,
        weight: layer.weight,
        size: layer.size,
        opacity: layer.opacity,
        margin: layer.margin,
        position: layer.slot === 'primary' ? config.position : layer.position,
        color: config.color,
      });
    }
    return layers;
  }

  function anchorPosition(position, width, height, itemWidth, itemHeight, margin) {
    var parts = position.split('-');
    var vertical = parts[0];
    var horizontal = parts[1];
    var centerX =
      horizontal === 'left'
        ? margin + itemWidth / 2
        : horizontal === 'right'
          ? width - margin - itemWidth / 2
          : width / 2;
    var centerY =
      vertical === 'top'
        ? margin + itemHeight / 2
        : vertical === 'bottom'
          ? height - margin - itemHeight / 2
          : height / 2;
    return { x: centerX, y: centerY };
  }

  /** Mean relative luminance of the pixels under a rect; null when unreadable. */
  function luminanceUnder(context, rect, canvasWidth, canvasHeight) {
    if (!context.getImageData) return null;
    var x = Math.max(0, Math.floor(rect.x));
    var y = Math.max(0, Math.floor(rect.y));
    var w = Math.min(canvasWidth - x, Math.ceil(rect.width));
    var h = Math.min(canvasHeight - y, Math.ceil(rect.height));
    if (w <= 0 || h <= 0) return null;
    try {
      var data = context.getImageData(x, y, w, h).data;
      var total = 0;
      var count = 0;
      // Sample on a coarse grid; a watermark rect is small but this keeps it cheap.
      var step = Math.max(4, Math.floor(data.length / 4 / 600)) * 4;
      for (var i = 0; i < data.length; i += step) {
        total += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        count += 1;
      }
      if (!count) return null;
      return total / count;
    } catch (error) {
      return null;
    }
  }

  function drawLayer(context, width, height, layer) {
    var minSide = Math.min(width, height);
    var fontSize = clamp(minSide * (layer.size / 100), 10, minSide * 0.3);
    var margin = minSide * (layer.margin / 100);
    var lines = layer.text.split('\n').slice(0, 2);

    context.font = layer.weight + ' ' + fontSize + 'px ' + layer.font;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    if (typeof context.letterSpacing === 'string') {
      context.letterSpacing = Math.round(fontSize * 0.03) + 'px';
    }

    var lineHeight = fontSize * 1.18;
    var widest = 1;
    for (var i = 0; i < lines.length; i += 1) {
      widest = Math.max(widest, context.measureText(lines[i]).width);
    }
    var textHeight = Math.max(lineHeight * lines.length, fontSize);
    var center = anchorPosition(layer.position, width, height, widest, textHeight, margin);

    var ink = LIGHT_INK;
    var shadow = 'rgba(0, 0, 0, 0.42)';
    if (layer.color === 'dark') {
      ink = DARK_INK;
      shadow = 'rgba(255, 255, 255, 0.5)';
    } else if (layer.color === 'light') {
      ink = LIGHT_INK;
    } else {
      var luminance = luminanceUnder(
        context,
        { x: center.x - widest / 2, y: center.y - textHeight / 2, width: widest, height: textHeight },
        width,
        height
      );
      if (luminance !== null && luminance > 0.62) {
        ink = DARK_INK;
        shadow = 'rgba(255, 255, 255, 0.5)';
      }
    }

    context.save();
    context.globalAlpha = layer.opacity;
    context.fillStyle = ink;
    context.shadowColor = shadow;
    context.shadowBlur = Math.max(2, fontSize * 0.18);
    context.shadowOffsetX = 0;
    context.shadowOffsetY = Math.max(1, fontSize * 0.05);
    for (var index = 0; index < lines.length; index += 1) {
      var y = center.y + (index - (lines.length - 1) / 2) * lineHeight;
      context.fillText(lines[index], center.x, y);
    }
    context.restore();
  }

  /**
   * Draw the whole watermark set. Call after the photo is on the canvas.
   * @returns {number} how many layers were painted
   */
  function draw(context, width, height, rawConfig) {
    var config = normalize(rawConfig);
    var layers = buildLayers(config);
    for (var i = 0; i < layers.length; i += 1) {
      drawLayer(context, width, height, layers[i]);
    }
    return layers.length;
  }

  global.CleanFrameWatermark = {
    TEMPLATES: TEMPLATES,
    CORNERS: CORNERS,
    normalize: normalize,
    defaultState: defaultState,
    buildLayers: buildLayers,
    draw: draw,
    findTemplate: findTemplate,
  };
})(typeof window !== 'undefined' ? window : this);
