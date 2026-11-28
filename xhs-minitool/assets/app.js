/**
 * CleanFrame XHS - mini-tool controller.
 *
 * Flow: pick -> read privacy tags -> 3:4 preview -> clean (canvas re-encode)
 *       -> save to album / go publish.
 *
 * Classic script. No modules, no network, no clipboard, no browser download,
 * no native dialog element. Chrome 61 / ES2017 baseline (async/await is ES2017).
 */
(function (global) {
  'use strict';

  var MAX_PHOTOS = 18;
  var Exif = global.CleanFrameExif;
  var Render = global.CleanFrameRender;
  var Watermark = global.CleanFrameWatermark;

  var PREVIEW_W = 540;
  var PREVIEW_H = 720;

  var state = {
    items: [],
    current: 0,
    busy: false,
    stageTab: 'original',
    cancelRequested: false,
    drawToken: 0,
    expanded: false,
    seq: 0,
    // Watermark starts on the most likely template but with empty text, so a
    // first-time user never publishes a mark they did not type themselves.
    watermark: Watermark
      ? Watermark.normalize({ template: 'handle', primary: '', secondary: '2026.11.27' })
      : null,
    watermarkVersion: 0,
    refreshTimer: null,
  };

  var els = {};
  var IDS = [
    'bridgePill',
    'compatList',
    'fileInput',
    'previewGrid',
    'emptyHint',
    'selectionCount',
    'privacyCard',
    'privacyBadge',
    'privacySummary',
    'privacyList',
    'privacyToggle',
    'stageCard',
    'previewCanvas',
    'stageBadge',
    'stageCaption',
    'prevButton',
    'nextButton',
    'tabOriginal',
    'tabClean',
    'watermarkCard',
    'watermarkBadge',
    'templateChips',
    'primaryField',
    'primaryInput',
    'secondaryField',
    'secondaryInput',
    'positionField',
    'positionChips',
    'colorField',
    'colorChips',
    'cleanButton',
    'progressWrap',
    'progressFill',
    'progressText',
    'cancelButton',
    'actionNote',
    'saveButton',
    'publishButton',
    'toast',
  ];

  // ------------------------------------------------------------------ utils

  function $(id) {
    return document.getElementById(id);
  }

  function showToast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () {
      els.toast.hidden = true;
    }, 3600);
  }

  function readBuffer(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(reader.error || new Error('读取文件失败'));
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  function decodeImage(url) {
    return new Promise(function (resolve, reject) {
      Render.loadImage(url, resolve, reject);
    });
  }

  function nextTick() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function getBridge() {
    if (!global.xhs || !global.xhs.miniTool) return null;
    return global.xhs.miniTool;
  }

  function currentItem() {
    return state.items[state.current] || null;
  }

  function itemsWithOutput() {
    return state.items.filter(function (item) {
      return !!item.output && item.outputVersion === state.watermarkVersion;
    });
  }

  function plural(count, unit) {
    return count + ' ' + unit;
  }

  // -------------------------------------------------------------- progress

  function showProgress(label, done, total) {
    if (!els.progressWrap) return;
    els.progressWrap.hidden = false;
    var pct = total ? Math.round((done / total) * 100) : 0;
    els.progressFill.style.width = pct + '%';
    els.progressText.textContent = label ? label + ' ' + done + ' / ' + total : done + ' / ' + total;
    els.cancelButton.hidden = false;
  }

  function hideProgress() {
    if (!els.progressWrap) return;
    els.progressWrap.hidden = true;
    els.progressFill.style.width = '0%';
    els.progressText.textContent = '';
    els.cancelButton.hidden = true;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.fileInput.disabled = busy;
    els.prevButton.disabled = busy;
    els.nextButton.disabled = busy;
    els.tabOriginal.disabled = busy;
    els.tabClean.disabled = busy;
    setWatermarkControlsDisabled(busy);
    updateActionButtons();
  }

  /**
   * Watermark editing is not queued while busy: a deferred edit would silently
   * diverge from the rendered output. Disable the controls instead so the user
   * cannot type into a field that would be dropped.
   */
  function setWatermarkControlsDisabled(disabled) {
    if (!els.primaryInput) return;
    els.primaryInput.disabled = disabled;
    els.secondaryInput.disabled = disabled;
    var rows = [els.templateChips, els.positionChips, els.colorChips];
    for (var i = 0; i < rows.length; i += 1) {
      if (!rows[i]) continue;
      var buttons = rows[i].getElementsByTagName('button');
      for (var j = 0; j < buttons.length; j += 1) buttons[j].disabled = disabled;
    }
  }

  // ------------------------------------------------------------------ files

  function addFiles(fileList) {
    var added = 0;
    var skipped = 0;
    for (var i = 0; i < fileList.length; i += 1) {
      var file = fileList[i];
      if (!file) continue;
      var looksImage = file.type.indexOf('image/') === 0 || /\.(jpe?g|png|webp)$/i.test(file.name || '');
      if (!looksImage) {
        skipped += 1;
        continue;
      }
      if (state.items.length >= MAX_PHOTOS) {
        skipped += 1;
        continue;
      }
      state.seq += 1;
      state.items.push({
        id: 'p' + state.seq,
        file: file,
        name: file.name || '未命名图片',
        thumbUrl: URL.createObjectURL(file),
        record: null,
        status: 'pending',
        error: '',
        output: null,
      });
      added += 1;
    }

    renderAll();
    if (skipped > 0) {
      showToast(
        state.items.length >= MAX_PHOTOS
          ? '一次最多处理 ' + MAX_PHOTOS + ' 张，多余的已跳过。'
          : '有 ' + skipped + ' 个文件不是 JPG / PNG / WebP，已跳过。'
      );
    }
    if (added > 0) parsePending();
  }

  function removeItem(id) {
    if (state.busy) {
      showToast('处理中不能删除，先取消或等它完成。');
      return;
    }
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].id !== id) continue;
      Render.revoke(state.items[i].thumbUrl);
      state.items.splice(i, 1);
      break;
    }
    if (state.current >= state.items.length) {
      state.current = Math.max(0, state.items.length - 1);
    }
    renderAll();
  }

  async function parsePending() {
    if (parsePending.running) return;
    var pending = state.items.filter(function (item) {
      return item.status === 'pending';
    });
    if (!pending.length) return;

    parsePending.running = true;
    var wasBusy = state.busy;
    setBusy(true);
    state.cancelRequested = false;
    var done = 0;
    showProgress('读取信息', 0, pending.length);

    try {
      for (var i = 0; i < pending.length; i += 1) {
        if (state.cancelRequested) break;
        var item = pending[i];
        try {
          var buffer = await readBuffer(item.file);
          item.record = Exif.parse(buffer, item.file.size);
          item.status = 'parsed';
          if (!item.record.width || !item.record.height) {
            item.status = 'failed';
            item.error = '读不出图片尺寸，可能不是有效的图片文件';
          }
        } catch (error) {
          item.status = 'failed';
          item.error = error && error.message ? error.message : '读取失败';
        }
        done += 1;
        showProgress('读取信息', done, pending.length);
        renderGrid();
        await nextTick();
      }
    } finally {
      hideProgress();
      setBusy(wasBusy);
      parsePending.running = false;
    }

    renderAll();
    if (state.cancelRequested) {
      state.cancelRequested = false;
      showToast('已取消读取。');
    } else {
      // Generate the first 3:4 preview right away so the watermark is visible
      // without an extra tap.
      ensurePreview(currentItem());
    }
  }

  // -------------------------------------------------------------- processing

  async function processOne(item) {
    var buffer = await readBuffer(item.file);
    var neutral = Exif.neutralizeOrientation(buffer);
    var mime = item.record && item.record.format === 'png' ? 'image/png' : 'image/jpeg';
    var url = Render.objectUrlFromBytes(neutral.bytes, mime);
    var image;
    try {
      image = await decodeImage(url);
    } finally {
      Render.revoke(url);
    }
    var orientation = (item.record && item.record.orientation) || 1;
    var canvas = Render.renderFrame(image, orientation, { width: Render.FRAME_W, height: Render.FRAME_H }, state.watermark);
    var dataUri = Render.toDataUri(canvas, Render.QUALITY);
    var bytes = Render.dataUriBytes(dataUri);
    Render.releaseCanvas(canvas);
    return { dataUri: dataUri, bytes: bytes, width: Render.FRAME_W, height: Render.FRAME_H };
  }

  /** True when an item has no image for the current watermark settings. */
  function needsOutput(item) {
    if (!item) return false;
    if (item.status !== 'parsed' && item.status !== 'done' && item.status !== 'failed') return false;
    return !item.output || item.outputVersion !== state.watermarkVersion;
  }

  /**
   * Re-render one item so the preview reflects the current watermark.
   * Deliberately not a global busy operation: it can run while the user types.
   *
   * Two race conditions are handled here:
   *   - the version is captured BEFORE rendering, so an edit that lands while
   *     the canvas work is in flight leaves the item correctly marked stale;
   *   - a second request while one is running is queued, not dropped, so the
   *     output can never get stuck on an old watermark.
   */
  async function refreshItem(item) {
    if (!item || state.busy) return;
    if (item.refreshing) {
      item.refreshQueued = true;
      return;
    }
    item.refreshing = true;
    try {
      var version = state.watermarkVersion;
      item.output = await processOne(item);
      item.outputVersion = version;
      item.status = 'done';
      item.error = '';
      if (currentItem() === item) {
        if (state.stageTab === 'clean') drawStage();
        renderStageMeta();
      }
      renderGrid();
      renderActions();
      updateActionButtons();
    } catch (error) {
      item.error = error && error.message ? error.message : '处理失败';
      item.status = 'failed';
    } finally {
      item.refreshing = false;
      if (item.refreshQueued) {
        item.refreshQueued = false;
        if (needsOutput(item)) refreshItem(item);
      }
    }
  }

  async function processAll() {
    var targets = state.items.filter(needsOutput);
    if (!targets.length) return 0;

    if (processAll.running) return 0;
    processAll.running = true;
    var wasBusy = state.busy;
    setBusy(true);
    state.cancelRequested = false;
    var version = state.watermarkVersion;
    var ok = 0;
    var failed = 0;
    var cancelled = false;
    showProgress('清理中', 0, targets.length);

    try {
      for (var i = 0; i < targets.length; i += 1) {
        if (state.cancelRequested) {
          cancelled = true;
          break;
        }
        var item = targets[i];
        try {
          item.output = await processOne(item);
          item.outputVersion = version;
          item.status = 'done';
          item.error = '';
          ok += 1;
        } catch (error) {
          item.status = 'failed';
          item.error = error && error.message ? error.message : '处理失败';
          failed += 1;
        }
        showProgress('清理中', i + 1, targets.length);
        renderGrid();
        await nextTick();
      }
    } finally {
      hideProgress();
      // Restore, do not clear: processAll may be nested inside save/publish.
      setBusy(wasBusy);
      processAll.running = false;
      state.cancelRequested = false;
    }
    if (ok > 0) state.stageTab = 'clean';
    setStageTab(state.stageTab, true);
    renderAll();

    if (cancelled) {
      showToast(ok > 0 ? '处理已取消，完成 ' + ok + ' 张。' : '处理已取消，没有生成新图片。');
    } else if (failed > 0) {
      showToast(ok > 0 ? '完成 ' + ok + ' 张，' + failed + ' 张失败。' : '处理失败，可以重试。');
    } else {
      showToast('已生成 ' + ok + ' 张 3:4 图片，可以保存或发布。');
    }
    return ok;
  }

  async function ensureOutputs() {
    if (!state.items.length) return false;
    var stale = state.items.filter(needsOutput);
    if (!stale.length) return true;
    var produced = await processAll();
    return produced > 0;
  }

  // ------------------------------------------------------------------ bridge

  /**
   * Bridge contract, as far as it can be pinned down.
   *
   * The platform doc specifies parameters (filePath / data) and that
   * saveImageToPhotosAlbum must be triggered by a user gesture, but the return
   * convention is not fully documented across container versions. So this
   * caller accepts all of the shapes seen in the wild:
   *
   *   1. Promise            -> awaited
   *   2. callback  fn(p, cb) -> cb(result) or cb.success(result) / cb.fail(e)
   *   3. sync object        -> {filePath}, {code}, {errMsg}
   *   4. bare return        -> treated as success (native UI shows its own state)
   *
   * `needsResult` (writeTempFile) refuses to guess: if the call returns nothing
   * and no callback arrives, it fails loudly instead of handing an undefined
   * filePath to the album API.
   */
  var BRIDGE_RESULT_TIMEOUT = 10000;

  function bridgeError(error, name) {
    var text = String((error && (error.errMsg || error.message || error.msg)) || '').replace(/^[^:]*:\s*/, '');
    if (/auth|permission|denied|forbidden|权限|拒绝|无权限/i.test(text)) {
      return new Error('相册权限被拒绝，请在系统设置里允许小红书访问照片。' + (text ? '（' + text + '）' : ''));
    }
    if (error instanceof Error) return error;
    return new Error(text || name + ' 调用失败');
  }

  function invokeBridge(bridge, name, payload, options) {
    var needsResult = !!(options && options.needsResult);
    return new Promise(function (resolve, reject) {
      var fn = bridge[name];
      if (typeof fn !== 'function') {
        reject(new Error('容器缺少 ' + name));
        return;
      }
      var settled = false;
      var timer = null;

      function settle(action, value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        action(value);
      }

      function accepted(value) {
        if (value && typeof value === 'object' && (value.errCode || value.code === -1 || value.success === false)) {
          settle(reject, bridgeError(value, name));
          return;
        }
        settle(resolve, value);
      }

      function failed(error) {
        settle(reject, bridgeError(error, name));
      }

      // One callable that also answers to the {success, fail} convention.
      var callback = function (value) {
        accepted(value);
      };
      callback.success = callback;
      callback.complete = callback;
      callback.fail = failed;

      var result;
      try {
        result = fn(payload, callback);
      } catch (error) {
        failed(error);
        return;
      }

      if (result && typeof result.then === 'function') {
        result.then(accepted, failed);
        return;
      }
      if (result !== undefined && result !== null) {
        accepted(result);
        return;
      }
      if (needsResult) {
        timer = setTimeout(function () {
          failed(new Error(name + ' 没有返回结果，容器可能在用别的约定，需要真机确认'));
        }, BRIDGE_RESULT_TIMEOUT);
        return;
      }
      settle(resolve, undefined);
    });
  }

  async function withOutputs(actionLabel, run) {
    if (state.busy) return;
    var bridge = getBridge();
    if (!bridge) {
      showToast('要在小红书小工具里打开才能' + actionLabel + '。浏览器里只能预览。');
      return;
    }
    setBusy(true);
    try {
      var ok = await ensureOutputs();
      if (!ok) return;
      await run(bridge);
    } finally {
      setBusy(false);
      hideProgress();
    }
  }

  async function saveAll() {
    await withOutputs('保存到相册', async function (bridge) {
      var targets = itemsWithOutput();
      var ok = 0;
      var failed = 0;
      var failedMessage = '';
      showProgress('保存到相册', 0, targets.length);
      for (var i = 0; i < targets.length; i += 1) {
        if (state.cancelRequested) break;
        var item = targets[i];
        try {
          var file = await invokeBridge(bridge, 'writeTempFile', { data: item.output.dataUri }, { needsResult: true });
          var path = file && (file.filePath || file.path || file.tempFilePath);
          if (!path) throw new Error('writeTempFile 没有返回 filePath');
          await invokeBridge(bridge, 'saveImageToPhotosAlbum', { filePath: path });
          ok += 1;
        } catch (error) {
          if (!failed) failedMessage = error.message || '保存失败';
          failed += 1;
        }
        showProgress('保存到相册', i + 1, targets.length);
        await nextTick();
      }
      state.cancelRequested = false;
      if (failed === 0) showToast('已保存 ' + ok + ' 张到相册。');
      else if (ok === 0) showToast('保存失败：' + failedMessage);
      else showToast('保存 ' + ok + ' 张，' + failed + ' 张失败：' + failedMessage);
    });
  }

  async function publishAll() {
    await withOutputs('带图去发布', async function (bridge) {
      var targets = itemsWithOutput();
      var resources = targets.map(function (item) {
        return { url: item.output.dataUri };
      });
      showProgress('准备发布', 0, 1);
      try {
        await invokeBridge(bridge, 'postNote', {
          mediaInfo: { image_resources: resources },
        });
        showProgress('准备发布', 1, 1);
        showToast('已进入小红书发布流程，标题和正文在那里填写。');
      } catch (error) {
        showToast('进入发布失败：' + (error.message || '可以重试。'));
      }
    });
  }

  // ----------------------------------------------------------------- render

  var POSITION_LABELS = {
    'top-left': '左上',
    'top-right': '右上',
    'bottom-left': '左下',
    'bottom-right': '右下',
  };

  var COLOR_OPTIONS = [
    { value: 'auto', label: '自动' },
    { value: 'light', label: '白色' },
    { value: 'dark', label: '深色' },
  ];

  function buildChips(container, options, activeValue, onPick) {
    if (!container) return;
    container.innerHTML = '';
    for (var i = 0; i < options.length; i += 1) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (options[i].value === activeValue ? ' is-active' : '');
      chip.textContent = options[i].label;
      chip.setAttribute('data-value', options[i].value);
      chip.setAttribute('aria-pressed', options[i].value === activeValue ? 'true' : 'false');
      chip.addEventListener(
        'click',
        (function (value) {
          return function () {
            onPick(value);
          };
        })(options[i].value)
      );
      container.appendChild(chip);
    }
  }

  function isPlaceholderText(config) {
    var template = Watermark.findTemplate(config.template);
    var defaults = template.defaults || {};
    if (!config.primary) return false;
    if (config.primary === defaults.primary) return true;
    return config.secondary === defaults.secondary && config.primary === defaults.primary;
  }

  function updateWatermarkBadge() {
    if (!els.watermarkBadge || !Watermark) return;
    var config = state.watermark;
    var text = '不加水印';
    var tone = 'muted';
    if (config.template !== 'none') {
      if (!config.primary) {
        text = '未填写';
      } else if (isPlaceholderText(config)) {
        text = '示例文字';
        tone = 'warn';
      } else {
        text = '已应用';
        tone = 'on';
      }
    }
    els.watermarkBadge.textContent = text;
    els.watermarkBadge.className = 'watermark-badge is-' + tone;
  }

  function renderWatermarkPanel() {
    if (!els.watermarkCard || !Watermark) return;
    els.watermarkCard.hidden = state.items.length === 0;
    var config = state.watermark;
    var template = Watermark.findTemplate(config.template);

    buildChips(
      els.templateChips,
      Watermark.TEMPLATES.map(function (item) {
        return { value: item.id, label: item.name };
      }),
      config.template,
      chooseTemplate
    );

    var hasPrimary = template.fields.indexOf('primary') !== -1;
    var hasSecondary = template.fields.indexOf('secondary') !== -1;
    els.primaryField.hidden = !hasPrimary;
    els.secondaryField.hidden = !hasSecondary;
    els.positionField.hidden = !hasPrimary;
    els.colorField.hidden = !hasPrimary;

    if (document.activeElement !== els.primaryInput) els.primaryInput.value = config.primary;
    if (document.activeElement !== els.secondaryInput) els.secondaryInput.value = config.secondary;

    buildChips(
      els.positionChips,
      Watermark.CORNERS.map(function (corner) {
        return { value: corner, label: POSITION_LABELS[corner] };
      }),
      config.position,
      function (value) {
        if (state.busy) return;
        state.watermark = Watermark.normalize({
          template: state.watermark.template,
          primary: state.watermark.primary,
          secondary: state.watermark.secondary,
          position: value,
          color: state.watermark.color,
        });
        renderWatermarkPanel();
        scheduleWatermarkUpdate();
      }
    );

    buildChips(els.colorChips, COLOR_OPTIONS, config.color, function (value) {
      if (state.busy) return;
      state.watermark = Watermark.normalize({
        template: state.watermark.template,
        primary: state.watermark.primary,
        secondary: state.watermark.secondary,
        position: state.watermark.position,
        color: value,
      });
      renderWatermarkPanel();
      scheduleWatermarkUpdate();
    });

    updateWatermarkBadge();
  }

  function chooseTemplate(id) {
    if (state.busy) return;
    var template = Watermark.findTemplate(id);
    var defaults = template.defaults || {};
    var current = state.watermark;
    var primary = current.primary;
    var secondary = current.secondary;
    // Seed placeholder text so a new template is visible immediately; the badge
    // and the input placeholder both call it out as example copy.
    if (template.fields.indexOf('primary') !== -1 && !primary && defaults.primary) primary = defaults.primary;
    if (template.fields.indexOf('secondary') !== -1 && !secondary && defaults.secondary) secondary = defaults.secondary;
    var position = (template.layers[0] && template.layers[0].position) || current.position;
    state.watermark = Watermark.normalize({
      template: id,
      primary: primary,
      secondary: secondary,
      position: position,
      color: current.color,
    });
    renderWatermarkPanel();
    scheduleWatermarkUpdate();
  }

  function scheduleWatermarkUpdate() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(applyWatermarkChange, 320);
  }

  function applyWatermarkChange() {
    var item = currentItem();
    state.watermarkVersion += 1;
    updateWatermarkBadge();
    updateActionButtons();
    renderActions();
    if (!item || state.busy) return;
    if (item.output) {
      // Live feedback beats "click clean again to see it".
      setStageTab('clean', true);
      refreshItem(item);
    } else if (item.status === 'parsed') {
      refreshItem(item).then(function () {
        if (currentItem() === item && item.output) setStageTab('clean', true);
      });
    }
  }

  function ensurePreview(item) {
    if (!item || state.busy) return;
    if (item.output && item.outputVersion === state.watermarkVersion) {
      if (state.stageTab !== 'clean') setStageTab('clean', true);
      return;
    }
    if (item.status !== 'parsed' && item.status !== 'done') return;
    refreshItem(item).then(function () {
      if (currentItem() === item && item.output) setStageTab('clean', true);
    });
  }

  function renderGrid() {
    els.selectionCount.textContent = state.items.length + ' / ' + MAX_PHOTOS;
    els.emptyHint.hidden = state.items.length > 0;
    if (!els.previewGrid) return;

    // Rebuild only when the item set changed; otherwise update in place.
    var existing = els.previewGrid.children;
    if (existing.length !== state.items.length) {
      els.previewGrid.innerHTML = '';
      for (var i = 0; i < state.items.length; i += 1) {
        els.previewGrid.appendChild(buildCard(state.items[i], i));
      }
      return;
    }
    for (var j = 0; j < state.items.length; j += 1) {
      updateCard(existing[j], state.items[j], j);
    }
  }

  function buildCard(item, index) {
    var figure = document.createElement('figure');
    figure.className = 'preview-card';
    figure.setAttribute('data-id', item.id);

    var image = document.createElement('img');
    image.src = item.thumbUrl;
    image.alt = item.name;
    figure.appendChild(image);

    var badge = document.createElement('span');
    badge.className = 'card-badge';
    figure.appendChild(badge);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preview-remove';
    remove.setAttribute('aria-label', '移除 ' + item.name);
    remove.textContent = '×';
    remove.addEventListener('click', function () {
      removeItem(item.id);
    });
    figure.appendChild(remove);

    var name = document.createElement('figcaption');
    name.className = 'preview-name';
    name.textContent = item.name;
    figure.appendChild(name);

    var pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'preview-pick';
    pick.setAttribute('aria-label', '预览 ' + item.name);
    pick.addEventListener('click', function () {
      setCurrent(index);
    });
    figure.appendChild(pick);

    updateCard(figure, item, index);
    return figure;
  }

  function updateCard(figure, item, index) {
    if (figure.getAttribute('data-id') !== item.id) {
      var fresh = buildCard(item, index);
      figure.parentNode.replaceChild(fresh, figure);
      return;
    }
    figure.className = 'preview-card' + (index === state.current ? ' is-current' : '');
    var badge = figure.querySelector('.card-badge');
    if (!badge) return;
    var risks = item.record ? item.record.risks.length : 0;
    var text = '…';
    var level = 'pending';
    if (item.status === 'failed') {
      text = '!';
      level = 'high';
    } else if (item.output) {
      text = '已清理';
      level = 'clean';
    } else if (item.record) {
      if (risks === 0) {
        text = '干净';
        level = 'clean';
      } else {
        text = risks + ' 项';
        level = worstLevel(item.record.risks);
      }
    }
    badge.textContent = text;
    badge.className = 'card-badge is-' + level;
  }

  function worstLevel(risks) {
    var rank = { high: 0, medium: 1, low: 2 };
    var worst = 'low';
    for (var i = 0; i < risks.length; i += 1) {
      if (rank[risks[i].level] < rank[worst]) worst = risks[i].level;
    }
    return worst;
  }

  function renderPrivacy() {
    var item = currentItem();
    if (!item || !item.record) {
      els.privacyCard.hidden = true;
      return;
    }
    els.privacyCard.hidden = false;
    var record = item.record;
    var risks = record.risks;

    var badgeText;
    if (item.output) {
      badgeText = '已清理';
    } else if (!risks.length) {
      badgeText = '无隐私项';
    } else {
      badgeText = risks.length + ' 项';
    }
    els.privacyBadge.textContent = badgeText;
    els.privacyBadge.className = 'privacy-badge is-' + (item.output ? 'clean' : risks.length ? worstLevel(risks) : 'clean');

    var head = '第 ' + (state.current + 1) + ' 张 · ' + record.width + ' × ' + record.height;
    if (record.orientation !== 1) head += ' · 需旋转（' + record.orientationLabel + '）';
    var total = state.items.length;
    var located = state.items.filter(function (it) {
      return it.record && it.record.gps;
    }).length;
    var parts = [head];
    if (total > 1) parts.push('共 ' + total + ' 张，' + located + ' 张带位置信息');
    els.privacySummary.textContent = parts.join('｜');

    els.privacyList.innerHTML = '';
    if (!record.groups.length) {
      var empty = document.createElement('li');
      empty.className = 'privacy-row';
      empty.textContent = '没有读到可显示的元数据字段。';
      els.privacyList.appendChild(empty);
    }
    for (var g = 0; g < record.groups.length; g += 1) {
      var group = record.groups[g];
      var title = document.createElement('li');
      title.className = 'privacy-row is-group';
      title.textContent = group.title;
      els.privacyList.appendChild(title);
      for (var r = 0; r < group.rows.length; r += 1) {
        var row = document.createElement('li');
        row.className = 'privacy-row';
        var label = document.createElement('span');
        label.className = 'privacy-label';
        label.textContent = group.rows[r].label;
        var value = document.createElement('span');
        value.className = 'privacy-value';
        value.textContent = group.rows[r].value;
        if (group.rows[r].risk) value.className += ' is-risky';
        row.appendChild(label);
        row.appendChild(value);
        els.privacyList.appendChild(row);
      }
    }

    els.privacyList.className = 'privacy-list' + (state.expanded ? '' : ' is-clamped');
    els.privacyToggle.textContent = state.expanded ? '收起字段' : '展开全部字段';
    els.privacyToggle.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
  }

  function setStageTab(tab, force) {
    if (!force && state.busy) return;
    state.stageTab = tab;
    els.tabOriginal.className = 'tab-button' + (tab === 'original' ? ' is-active' : '');
    els.tabClean.className = 'tab-button' + (tab === 'clean' ? ' is-active' : '');
    var item = currentItem();
    var hasOutput = !!(item && item.output);
    els.tabClean.disabled = !hasOutput || state.busy;
    drawStage();
    renderStageMeta();
  }

  function renderStageMeta() {
    var item = currentItem();
    if (!item) {
      els.stageCard.hidden = true;
      els.stageBadge.textContent = '等待选择';
      els.stageCaption.textContent = '--';
      return;
    }
    els.stageCard.hidden = false;
    var total = state.items.length;
    var pos = state.current + 1;
    var width = Render.FRAME_W;
    var height = Render.FRAME_H;
    if (state.stageTab === 'clean' && item.output) {
      els.stageBadge.textContent = '已清理';
      els.stageBadge.className = 'stage-badge is-clean';
      els.stageCaption.textContent =
        '第 ' + pos + ' / ' + total + ' 张 · ' + width + ' × ' + height + ' · 约 ' + Render.formatBytes(item.output.bytes);
    } else {
      els.stageBadge.textContent = '原图';
      els.stageBadge.className = 'stage-badge';
      var meta = item.record ? item.record.width + ' × ' + item.record.height : '--';
      els.stageCaption.textContent = '第 ' + pos + ' / ' + total + ' 张 · 原始 ' + meta + ' · 3:4 居中裁切预览';
    }
    els.prevButton.disabled = state.busy || state.current <= 0;
    els.nextButton.disabled = state.busy || state.current >= total - 1;
  }

  async function drawStage() {
    if (!els.previewCanvas) return;
    var canvas = els.previewCanvas;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var token = ++state.drawToken;
    var item = currentItem();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!item) return;

    try {
      if (state.stageTab === 'clean' && item.output) {
        var image = await decodeImage(item.output.dataUri);
        if (token !== state.drawToken) return;
        Render.paintCanvasFromImage(canvas, image, item.output.width, item.output.height);
        return;
      }
      if (item.status !== 'parsed' && item.status !== 'done') return;
      var buffer = await readBuffer(item.file);
      var neutral = Exif.neutralizeOrientation(buffer);
      var mime = item.record.format === 'png' ? 'image/png' : 'image/jpeg';
      var url = Render.objectUrlFromBytes(neutral.bytes, mime);
      var original;
      try {
        original = await decodeImage(url);
      } finally {
        Render.revoke(url);
      }
      if (token !== state.drawToken) return;
      Render.paintFrame(canvas, original, item.record.orientation);
    } catch (error) {
      if (token !== state.drawToken) return;
      els.stageCaption.textContent = '预览失败：' + (error && error.message ? error.message : '未知错误');
    }
  }

  function setCurrent(index) {
    if (state.busy) return;
    if (index < 0 || index >= state.items.length) return;
    state.current = index;
    renderGrid();
    renderPrivacy();
    var item = currentItem();
    if (state.stageTab === 'clean' && item && !item.output) state.stageTab = 'original';
    setStageTab(state.stageTab, true);
    ensurePreview(item);
  }

  function renderActions() {
    var item = currentItem();
    var outputs = itemsWithOutput().length;
    var note = '';
    if (!state.items.length) {
      note = '选 1–18 张照片，先看它带走了什么。';
    } else if (outputs === 0) {
      note = '点「一键清理」生成 3:4 图片；保存和发布会自动先清理。';
    } else if (outputs < state.items.length) {
      note = '已生成 ' + outputs + ' / ' + state.items.length + ' 张，保存时会自动补齐。';
    } else {
      var totalBytes = 0;
      for (var i = 0; i < state.items.length; i += 1) {
        if (state.items[i].output) totalBytes += state.items[i].output.bytes;
      }
      note = outputs + ' 张 · 共约 ' + Render.formatBytes(totalBytes) + '，' + Render.FRAME_W + '×' + Render.FRAME_H + ' JPEG';
      if (outputs > 9) note += '；张数较多，建议分两次发。';
      if (item && item.output) note += '';
    }
    els.actionNote.textContent = note;
  }

  function updateActionButtons() {
    // Enabled by "there are photos", not by "outputs are ready": save and publish
    // run ensureOutputs first, so a disabled button would dead-end the user
    // right after they change the watermark.
    var hasItems = state.items.length > 0;
    els.saveButton.disabled = state.busy || !hasItems;
    els.publishButton.disabled = state.busy || !hasItems;
    if (els.cleanButton) {
      var fresh = itemsWithOutput().length;
      var everRendered = false;
      for (var i = 0; i < state.items.length; i += 1) {
        if (state.items[i].output) everRendered = true;
      }
      els.cleanButton.disabled = state.busy || !hasItems;
      els.cleanButton.textContent = everRendered && !fresh ? '按新水印重新清理' : fresh ? '重新清理' : '一键清理并生成 3:4 图';
    }
  }

  function renderAll() {
    renderGrid();
    renderPrivacy();
    renderWatermarkPanel();
    renderStageMeta();
    renderActions();
    updateActionButtons();
    if (!currentItem()) {
      var ctx = els.previewCanvas && els.previewCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
      }
    }
  }

  // ------------------------------------------------------------------ setup

  function updateCompat() {
    var bridge = getBridge();
    var required = ['postNote', 'saveImageToPhotosAlbum', 'writeTempFile'];
    els.bridgePill.textContent = bridge ? '小工具容器' : '浏览器预览';
    els.bridgePill.className = bridge ? 'bridge-pill is-bridge' : 'bridge-pill';
    if (!els.compatList) return;
    els.compatList.innerHTML = '';
    var rows = [['window.xhs.miniTool', !!bridge]];
    for (var i = 0; i < required.length; i += 1) {
      rows.push([required[i], !!(bridge && typeof bridge[required[i]] === 'function')]);
    }
    for (var j = 0; j < rows.length; j += 1) {
      var li = document.createElement('li');
      li.textContent = rows[j][0] + (rows[j][1] ? ' 可用' : ' 未注入');
      if (!rows[j][1]) li.className = 'is-missing';
      els.compatList.appendChild(li);
    }
  }

  function guard(fn) {
    return function () {
      fn().catch(function (error) {
        hideProgress();
        setBusy(false);
        showToast((error && error.message) || '操作失败，可以重试。');
        if (global.console) global.console.error(error);
      });
    };
  }

  function bind() {
    els.fileInput.addEventListener('change', function (event) {
      addFiles(event.target.files || []);
      els.fileInput.value = '';
    });
    els.cleanButton.addEventListener('click', guard(processAll));
    els.saveButton.addEventListener('click', guard(saveAll));
    els.publishButton.addEventListener('click', guard(publishAll));
    els.cancelButton.addEventListener('click', function () {
      state.cancelRequested = true;
      els.progressText.textContent = '正在取消…';
      els.cancelButton.hidden = true;
    });
    els.prevButton.addEventListener('click', function () {
      setCurrent(state.current - 1);
    });
    els.nextButton.addEventListener('click', function () {
      setCurrent(state.current + 1);
    });
    els.tabOriginal.addEventListener('click', function () {
      setStageTab('original');
    });
    els.tabClean.addEventListener('click', function () {
      setStageTab('clean');
    });
    els.privacyToggle.addEventListener('click', function () {
      state.expanded = !state.expanded;
      renderPrivacy();
    });
    els.primaryInput.addEventListener('input', onWatermarkText);
    els.secondaryInput.addEventListener('input', onWatermarkText);
  }

  function onWatermarkText() {
    if (state.busy) return;
    state.watermark = Watermark.normalize({
      template: state.watermark.template,
      primary: els.primaryInput.value,
      secondary: els.secondaryInput.value,
      position: state.watermark.position,
      color: state.watermark.color,
    });
    updateWatermarkBadge();
    scheduleWatermarkUpdate();
  }

  function init() {
    for (var i = 0; i < IDS.length; i += 1) {
      els[IDS[i]] = $(IDS[i]);
    }
    if (!Exif || !Render || !Watermark) {
      showToast('引擎脚本没有加载，请检查 assets 目录。');
      return;
    }
    if (els.previewCanvas) {
      els.previewCanvas.width = PREVIEW_W;
      els.previewCanvas.height = PREVIEW_H;
    }
    bind();
    updateCompat();
    setStageTab('original', true);
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Small debug handle for the next implementation session.
  global.CleanFrameXhs = {
    get state() {
      return {
        items: state.items.map(function (item) {
          return {
            id: item.id,
            name: item.name,
            status: item.status,
            error: item.error,
            risks: item.record ? item.record.risks.map(function (risk) {
              return risk.id;
            }) : [],
            orientation: item.record ? item.record.orientation : null,
            output: item.output
              ? {
                  width: item.output.width,
                  height: item.output.height,
                  bytes: item.output.bytes,
                  version: item.outputVersion,
                }
              : null,
          };
        }),
        current: state.current,
        busy: state.busy,
        watermark: state.watermark,
        watermarkVersion: state.watermarkVersion,
      };
    },
    hasBridge: function () {
      return !!getBridge();
    },
    clear: function () {
      for (var i = 0; i < state.items.length; i += 1) Render.revoke(state.items[i].thumbUrl);
      state.items = [];
      state.current = 0;
      renderAll();
    },
  };
})(typeof window !== 'undefined' ? window : this);
