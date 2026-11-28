/**
 * CleanFrame XHS - canvas framing / export pipeline.
 *
 * Output contract: every export is a freshly drawn 3:4 JPEG. A canvas re-encode
 * keeps no EXIF/XMP/IPTC at all, which is exactly why the mini-tool does not
 * need byte-level metadata stripping.
 *
 * Orientation note: the app feeds this module a JPEG whose EXIF Orientation tag
 * was already forced to 1 (see CleanFrameExif.neutralizeOrientation), so the
 * decoded pixels are always raw/sensor order. That makes the matrices below the
 * single source of truth on both Chrome 61 (ignores EXIF orientation) and
 * Chrome 81+ (honours it).
 *
 * Classic script. Chrome 61 / ES2017 baseline.
 */
(function (global) {
  'use strict';

  var FRAME_W = 1080;
  var FRAME_H = 1440;
  var QUALITY = 0.86;
  var BACKGROUND = '#ffffff';

  /**
   * Map un-oriented source pixels into oriented (display) space.
   * Each matrix is expressed in the oriented bounding box.
   */
  function applyOrientation(ctx, orientation, srcW, srcH) {
    switch (orientation) {
      case 2:
        ctx.transform(-1, 0, 0, 1, srcW, 0);
        break;
      case 3:
        ctx.transform(-1, 0, 0, -1, srcW, srcH);
        break;
      case 4:
        ctx.transform(1, 0, 0, -1, 0, srcH);
        break;
      case 5:
        ctx.transform(0, 1, 1, 0, 0, 0);
        break;
      case 6:
        ctx.transform(0, 1, -1, 0, srcH, 0);
        break;
      case 7:
        ctx.transform(0, -1, -1, 0, srcH, srcW);
        break;
      case 8:
        ctx.transform(0, -1, 1, 0, 0, srcW);
        break;
      default:
        break;
    }
  }

  function orientedSize(width, height, orientation) {
    var rotated = orientation >= 5 && orientation <= 8;
    return { width: rotated ? height : width, height: rotated ? width : height };
  }

  /**
   * Pure geometry for a "cover" 3:4 frame. Separated out so the crop math can be
   * verified without a canvas.
   */
  function framePlan(srcW, srcH, orientation, dstW, dstH) {
    var oriented = orientedSize(srcW, srcH, orientation);
    var scale = Math.max(dstW / oriented.width, dstH / oriented.height);
    var drawnWidth = oriented.width * scale;
    var drawnHeight = oriented.height * scale;
    return {
      orientedWidth: oriented.width,
      orientedHeight: oriented.height,
      scale: scale,
      drawnWidth: drawnWidth,
      drawnHeight: drawnHeight,
      offsetX: (dstW - drawnWidth) / 2,
      offsetY: (dstH - drawnHeight) / 2,
    };
  }

  /**
   * Draw `img` into a dstW x dstH area, cropped to cover (center), applying the
   * EXIF orientation ourselves.
   */
  function drawFramed(ctx, img, orientation, dstW, dstH) {
    var srcW = img.naturalWidth || img.width;
    var srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) throw new Error('图片尺寸读不出来');

    var plan = framePlan(srcW, srcH, orientation, dstW, dstH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, dstW, dstH);
    ctx.clip();
    ctx.translate(plan.offsetX, plan.offsetY);
    ctx.scale(plan.scale, plan.scale);
    applyOrientation(ctx, orientation, srcW, srcH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  function createCanvas(width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * Render one image into a fresh 3:4 canvas.
   * @param {HTMLImageElement} img
   * @param {number} orientation 1-8, as read from the *original* file
   * @param {{width?:number,height?:number}} [size]
   * @param {object} [watermark] CleanFrameWatermark config
   * @returns {HTMLCanvasElement}
   */
  function renderFrame(img, orientation, size, watermark) {
    var width = (size && size.width) || FRAME_W;
    var height = (size && size.height) || FRAME_H;
    var canvas = createCanvas(width, height);
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持 Canvas 2D');
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    drawFramed(ctx, img, orientation, width, height);
    paintWatermark(ctx, width, height, watermark);
    return canvas;
  }

  function paintWatermark(ctx, width, height, watermark) {
    if (!watermark) return 0;
    var engine = global.CleanFrameWatermark;
    if (!engine) return 0;
    return engine.draw(ctx, width, height, watermark);
  }

  function loadImage(url, onDone, onError) {
    var image = new Image();
    image.onload = function () {
      onDone(image);
    };
    image.onerror = function () {
      onError(new Error('图片解码失败，可能是格式不受支持或文件已损坏'));
    };
    image.src = url;
    return image;
  }

  function objectUrlFromBytes(bytes, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  }

  function revoke(url) {
    if (url && url.indexOf('blob:') === 0) URL.revokeObjectURL(url);
  }

  /** PNG canvas -> JPEG data URI. Quality 0.86 is the brief's publish range. */
  function toDataUri(canvas, quality) {
    return canvas.toDataURL('image/jpeg', typeof quality === 'number' ? quality : QUALITY);
  }

  /** Approximate decoded byte size of a base64 data URI. */
  function dataUriBytes(dataUri) {
    var comma = dataUri.indexOf(',');
    if (comma === -1) return 0;
    var payload = dataUri.length - comma - 1;
    var padding = 0;
    if (dataUri.charAt(dataUri.length - 1) === '=') padding += 1;
    if (dataUri.charAt(dataUri.length - 2) === '=') padding += 1;
    return Math.floor((payload * 3) / 4) - padding;
  }

  function formatBytes(size) {
    if (!size) return '0 B';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(0) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** Free canvas backing store; mobile WebViews keep this memory otherwise. */
  function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 1;
    canvas.height = 1;
  }

  /** Draw an already-rendered data URI into a canvas for on-screen preview. */
  function paintCanvasFromImage(canvas, image, dstW, dstH) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var scale = Math.min(canvas.width / dstW, canvas.height / dstH);
    var w = dstW * scale;
    var h = dstH * scale;
    ctx.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }

  /** Draw an original image into a preview canvas using the same cover framing. */
  function paintFrame(canvas, image, orientation, watermark) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawFramed(ctx, image, orientation, canvas.width, canvas.height);
    paintWatermark(ctx, canvas.width, canvas.height, watermark);
  }

  global.CleanFrameRender = {
    FRAME_W: FRAME_W,
    FRAME_H: FRAME_H,
    QUALITY: QUALITY,
    drawFramed: drawFramed,
    framePlan: framePlan,
    applyOrientation: applyOrientation,
    createCanvas: createCanvas,
    renderFrame: renderFrame,
    loadImage: loadImage,
    objectUrlFromBytes: objectUrlFromBytes,
    revoke: revoke,
    toDataUri: toDataUri,
    dataUriBytes: dataUriBytes,
    formatBytes: formatBytes,
    releaseCanvas: releaseCanvas,
    paintCanvasFromImage: paintCanvasFromImage,
    paintFrame: paintFrame,
  };
})(typeof window !== 'undefined' ? window : this);
