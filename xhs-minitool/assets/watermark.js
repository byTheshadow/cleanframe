/**
 * CleanFrame XHS - watermark engine.
 *
 * Model: a watermark is a list of up to three text layers. Each layer owns its
 * text, size step, corner (or tiled mode) and opacity; the template buttons are
 * presets that replace the whole list.
 *
 * Ported from project/js/watermark.js (anchorPosition / drawTiled), trimmed to
 * text only: no logo upload, no layer reordering. Sizes are percentages of the
 * canvas short side, so the 540x720 preview and the 1080x1440 export match.
 *
 * Added on top: automatic contrast. Ink is chosen from the pixels underneath,
 * because a white mark disappears against a bright sky. Tiled layers sample a
 * coarse grid across the whole frame instead of one rect.
 *
 * Classic script. Chrome 61 / ES2017 baseline.
 */
(function (global) {
  'use strict';

  var FONT_SANS =
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", Arial, sans-serif';
  var FONT_MONO = '"SFMono-Regular", "Cascadia Code", Consolas, monospace';

  var MAX_LAYERS = 3;
  var CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

  // Discrete steps so the UI stays three buttons per layer.
  var SIZE_STEPS = [
    { id: 'small', value: 2.2, label: '小' },
    { id: 'medium', value: 3.2, label: '中' },
    { id: 'large', value: 4.6, label: '大' },
  ];

  var TILE_ROTATION = -18;
  var TILE_OPACITY = 0.26;

  var LIGHT_INK = '#ffffff';
  var DARK_INK = '#16171a';

  var layerSeq = 0;

  function newLayerId() {
    layerSeq += 1;
    return 'layer-' + Date.now().toString(36) + '-' + layerSeq;
  }

  function isStep(value) {
    for (var i = 0; i < SIZE_STEPS.length; i += 1) {
      if (SIZE_STEPS[i].value === value) return true;
    }
    return false;
  }

  function nearestStep(value) {
    var found = SIZE_STEPS[1];
    var best = Infinity;
    for (var i = 0; i < SIZE_STEPS.length; i += 1) {
      var delta = Math.abs(SIZE_STEPS[i].value - value);
      if (delta < best) {
        best = delta;
        found = SIZE_STEPS[i];
      }
    }
    return found.value;
  }

  function makeLayer(raw) {
    var input = raw || {};
    var size = Number(input.size);
    return {
      id: typeof input.id === 'string' && input.id ? input.id : newLayerId(),
      text: String(input.text == null ? '' : input.text)
        .replace(/\s+/g, ' ')
        .replace(/^ | $/g, '')
        .slice(0, 28),
      font: input.font === 'mono' ? 'mono' : 'sans',
      weight: [300, 400, 500, 600, 700, 800].indexOf(Number(input.weight)) === -1 ? 600 : Number(input.weight),
      size: isStep(size) ? size : nearestStep(size || SIZE_STEPS[1].value),
      opacity: Math.min(1, Math.max(0.1, Number(input.opacity) || 0.85)),
      position: CORNERS.indexOf(input.position) === -1 ? 'bottom-right' : input.position,
      tile: Boolean(input.tile),
    };
  }

  /**
   * Templates are presets: picking one replaces the layer list. `text` is the
   * example copy shown in the field; empty means "type your own".
   */
  var TEMPLATES = [
    { id: 'none', name: '不加水印', hint: '只清理隐私', layers: [] },
    {
      id: 'handle',
      name: '小红书号',
      hint: '右下角账号',
      layers: [{ text: '', font: 'sans', weight: 700, size: 4.6, opacity: 0.9, position: 'bottom-right' }],
    },
    {
      id: 'minimal',
      name: '极简署名',
      hint: '小字不抢镜',
      layers: [{ text: '© @你的名字', font: 'sans', weight: 500, size: 2.2, opacity: 0.72, position: 'bottom-right' }],
    },
    {
      id: 'travel',
      name: '旅行记录',
      hint: '地点 + 日期',
      layers: [
        { text: '上海 · 外滩', font: 'sans', weight: 700, size: 3.2, opacity: 0.88, position: 'bottom-left' },
        { text: '2026.11.27', font: 'mono', weight: 400, size: 2.2, opacity: 0.66, position: 'bottom-right' },
      ],
    },
    {
      id: 'shop',
      name: '探店',
      hint: '店名 + 账号',
      layers: [
        { text: '店名 / 品牌', font: 'sans', weight: 800, size: 4.6, opacity: 0.92, position: 'bottom-left' },
        { text: '@你的小红书号', font: 'mono', weight: 500, size: 2.2, opacity: 0.6, position: 'top-right' },
      ],
    },
    {
      id: 'guard',
      name: '防盗图',
      hint: '整图平铺',
      layers: [
        { text: 'PREVIEW · DO NOT COPY', font: 'mono', weight: 500, size: 3.2, opacity: 0.3, position: 'bottom-right', tile: true },
      ],
    },
  ];

  function findTemplate(id) {
    for (var i = 0; i < TEMPLATES.length; i += 1) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return TEMPLATES[0];
  }

  function normalize(raw) {
    var input = raw || {};
    var list = Object.prototype.toString.call(input.layers) === '[object Array]' ? input.layers : [];
    var layers = [];
    for (var i = 0; i < list.length && layers.length < MAX_LAYERS; i += 1) layers.push(makeLayer(list[i]));
    var template = typeof input.template === 'string' ? input.template : 'handle';
    var color = input.color === 'light' || input.color === 'dark' ? input.color : 'auto';
    return { template: template, color: color, layers: layers };
  }

  /** Build a state from a template id, with fresh layer ids. */
  function stateFromTemplate(templateId) {
    var template = findTemplate(templateId);
    var layers = [];
    for (var i = 0; i < template.layers.length; i += 1) layers.push(makeLayer(template.layers[i]));
    return { template: template.id, color: 'auto', layers: layers };
  }

  function defaultState() {
    return stateFromTemplate('handle');
  }

  function emptyLayer() {
    return makeLayer({ text: '', font: 'sans', weight: 600, size: 3.2, opacity: 0.85, position: 'bottom-right' });
  }

  /** True while every visible layer has no text (nothing will be drawn). */
  function isEmpty(config) {
    for (var i = 0; i < config.layers.length; i += 1) {
      if (config.layers[i].text) return false;
    }
    return true;
  }

  function isPlaceholder(config) {
    var template = findTemplate(config.template);
    if (!template.layers.length || config.layers.length !== template.layers.length) return false;
    for (var i = 0; i < config.layers.length; i += 1) {
      var expected = template.layers[i].text;
      if (!expected) return false;
      if (config.layers[i].text !== expected) return false;
    }
    return true;
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

  function meanLuminance(data) {
    var total = 0;
    var count = 0;
    for (var i = 0; i < data.length; i += 4) {
      total += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      count += 1;
    }
    return count ? total / count : null;
  }

  /** Luminance under a single rect; null when the canvas is not readable. */
  function luminanceUnder(context, rect, canvasWidth, canvasHeight) {
    if (!context.getImageData) return null;
    var x = Math.max(0, Math.floor(rect.x));
    var y = Math.max(0, Math.floor(rect.y));
    var w = Math.min(canvasWidth - x, Math.ceil(rect.width));
    var h = Math.min(canvasHeight - y, Math.ceil(rect.height));
    if (w <= 0 || h <= 0) return null;
    try {
      return meanLuminance(context.getImageData(x, y, w, h).data);
    } catch (error) {
      return null;
    }
  }

  /** Luminance across the whole frame, sampled from five small patches. */
  function luminanceAcross(context, canvasWidth, canvasHeight) {
    if (!context.getImageData) return null;
    var patch = Math.max(24, Math.round(Math.min(canvasWidth, canvasHeight) * 0.12));
    var xs = [0, canvasWidth - patch, Math.round((canvasWidth - patch) / 2)];
    var ys = [0, canvasHeight - patch, Math.round((canvasHeight - patch) / 2)];
    var total = 0;
    var count = 0;
    for (var i = 0; i < xs.length; i += 1) {
      for (var j = 0; j < ys.length; j += 1) {
        if (i === 2 && j === 2) continue;
        var value = luminanceUnder(context, { x: xs[i], y: ys[j], width: patch, height: patch }, canvasWidth, canvasHeight);
        if (value === null) return null;
        total += value;
        count += 1;
      }
    }
    return count ? total / count : null;
  }

  function pickInk(mode, luminance) {
    if (mode === 'dark') return { ink: DARK_INK, shadow: 'rgba(255, 255, 255, 0.5)' };
    if (mode === 'light' || luminance === null) return { ink: LIGHT_INK, shadow: 'rgba(0, 0, 0, 0.42)' };
    if (luminance > 0.62) return { ink: DARK_INK, shadow: 'rgba(255, 255, 255, 0.5)' };
    return { ink: LIGHT_INK, shadow: 'rgba(0, 0, 0, 0.42)' };
  }

  function drawTiled(context, width, height, layer, fontSize, textWidth) {
    var minSide = Math.min(width, height);
    var gap = minSide * 0.1;
    // Space the grid from the measured text, not from a font-size guess: long
    // strings used to collide when the step was smaller than the real width.
    var stepX = Math.max(textWidth + gap * 2, minSide * 0.2);
    var stepY = Math.max(fontSize * 3.4, minSide * 0.13);
    var diagonal = Math.sqrt(width * width + height * height);
    var startX = -diagonal;
    var startY = -diagonal;
    var endX = width + diagonal;
    var endY = height + diagonal;

    context.save();
    context.translate(width / 2, height / 2);
    context.rotate((TILE_ROTATION * Math.PI) / 180);
    context.translate(-width / 2, -height / 2);
    var row = 0;
    for (var y = startY; y < endY; y += stepY) {
      var offsetX = row % 2 ? stepX / 2 : 0;
      for (var x = startX + offsetX; x < endX; x += stepX) {
        context.fillText(layer.text, x, y);
      }
      row += 1;
    }
    context.restore();
  }

  function drawLayer(context, width, height, layer, colorMode) {
    var minSide = Math.min(width, height);
    var fontSize = Math.max(10, minSide * (layer.size / 100));
    var margin = minSide * (4 / 100);

    context.save();
    context.font = layer.weight + ' ' + fontSize + 'px ' + (layer.font === 'mono' ? FONT_MONO : FONT_SANS);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    if (typeof context.letterSpacing === 'string') {
      context.letterSpacing = Math.round(fontSize * 0.03) + 'px';
    }

    // Measure first (needs the font), sample the pixels underneath, then paint.
    var center = null;
    var textWidth = Math.max(1, context.measureText(layer.text).width);
    var luminance;
    if (layer.tile) {
      luminance = luminanceAcross(context, width, height);
    } else {
      center = anchorPosition(layer.position, width, height, textWidth, fontSize, margin);
      luminance = luminanceUnder(
        context,
        { x: center.x - textWidth / 2, y: center.y - fontSize, width: textWidth, height: fontSize * 2 },
        width,
        height
      );
    }

    var ink = pickInk(colorMode, luminance);
    context.globalAlpha = layer.tile ? TILE_OPACITY : layer.opacity;
    context.fillStyle = ink.ink;
    context.shadowColor = ink.shadow;
    context.shadowBlur = Math.max(2, fontSize * 0.18);
    context.shadowOffsetY = Math.max(1, fontSize * 0.05);

    if (layer.tile) {
      drawTiled(context, width, height, layer, fontSize, textWidth);
    } else {
      context.fillText(layer.text, center.x, center.y);
    }
    context.restore();
  }

  /**
   * Draw all layers. Call after the photo is on the canvas.
   * @returns {number} how many layers were painted
   */
  function draw(context, width, height, rawConfig) {
    var config = normalize(rawConfig);
    var painted = 0;
    for (var i = 0; i < config.layers.length; i += 1) {
      var layer = config.layers[i];
      if (!layer.text) continue;
      drawLayer(context, width, height, layer, config.color);
      painted += 1;
    }
    return painted;
  }

  global.CleanFrameWatermark = {
    TEMPLATES: TEMPLATES,
    CORNERS: CORNERS,
    SIZE_STEPS: SIZE_STEPS,
    MAX_LAYERS: MAX_LAYERS,
    normalize: normalize,
    defaultState: defaultState,
    stateFromTemplate: stateFromTemplate,
    emptyLayer: emptyLayer,
    isEmpty: isEmpty,
    isPlaceholder: isPlaceholder,
    findTemplate: findTemplate,
    draw: draw,
  };
})(typeof window !== 'undefined' ? window : this);
