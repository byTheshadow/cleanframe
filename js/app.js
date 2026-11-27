import {
  inspectImage,
  stripMetadata,
  formatBytes,
  extensionForMime,
} from './metadata.js';
import {
  renderWatermarked,
  normalizeLayer,
  drawWatermarks,
  hasVisibleWatermark,
  outputMimeFor,
} from './watermark.js';
import {
  WATERMARK_PRESETS,
  findPreset,
  presetLayers,
  defaultLayer,
} from './watermark-presets.js';
import { createZip, suggestedZipName, sanitizeFileName } from './zip.js';
import { buildRenamePlan, dateStamp } from './rename.js';

const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_BYTES = 450 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  items: [],
  currentId: null,
  activeTab: 'metadata',
  previewView: 'original',
  watermarkLayers: [],
  activeLayerId: null,
  logoImages: new Map(),
  outputFormat: 'auto',
  quality: 0.92,
  keepIcc: true,
  busy: false,
  job: null,
  clearArmed: false,
};

const els = {
  landingView: $('#landingView'),
  workspaceView: $('#workspaceView'),
  landingDrop: $('#landingDrop'),
  loadDemoButton: $('#loadDemoButton'),
  topAddButton: $('#topAddButton'),
  libraryAddButton: $('#libraryAddButton'),
  libraryDrop: $('#libraryDrop'),
  fileInput: $('#fileInput'),
  logoInput: $('#logoInput'),
  zipButton: $('#zipButton'),
  zipCount: $('#zipCount'),
  batchIndicator: $('#batchIndicator'),
  libraryCount: $('#libraryCount'),
  libraryTotalSize: $('#libraryTotalSize'),
  selectAllCheckbox: $('#selectAllCheckbox'),
  selectionCount: $('#selectionCount'),
  clearButton: $('#clearButton'),
  renameButton: $('#renameButton'),
  renameDialog: $('#renameDialog'),
  closeRenameButton: $('#closeRenameButton'),
  cancelRenameButton: $('#cancelRenameButton'),
  applyRenameButton: $('#applyRenameButton'),
  renameScope: $('#renameScope'),
  renameBase: $('#renameBase'),
  renameUseDateButton: $('#renameUseDateButton'),
  renamePrefix: $('#renamePrefix'),
  renameSuffix: $('#renameSuffix'),
  renameNumbering: $('#renameNumbering'),
  renameNumberOptions: $('#renameNumberOptions'),
  renameStart: $('#renameStart'),
  renameDigits: $('#renameDigits'),
  renameSeparator: $('#renameSeparator'),
  renamePreview: $('#renamePreview'),
  renamePreviewCount: $('#renamePreviewCount'),
  renameWarning: $('#renameWarning'),
  fileList: $('#fileList'),
  stageIndex: $('#stageIndex'),
  stageName: $('#stageName'),
  stageAnnouncer: $('#stageAnnouncer'),
  stageBadge: $('#stageBadge'),
  stageImage: $('#stageImage'),
  stageViewport: $('#stageViewport'),
  stageEmpty: $('#stageEmpty'),
  stagePrivacy: $('#stagePrivacy'),
  stagePrivacyText: $('#stagePrivacyText'),
  previewTag: $('#previewTag'),
  watermarkCanvas: $('#watermarkCanvas'),
  compareToggle: $('#compareToggle'),
  downloadCurrentButton: $('#downloadCurrentButton'),
  prevButton: $('#prevButton'),
  nextButton: $('#nextButton'),
  restoreButton: $('#restoreButton'),
  removeButton: $('#removeButton'),
  footDimensions: $('#footDimensions'),
  footMetaSize: $('#footMetaSize'),
  footMetaState: $('#footMetaState'),
  riskCard: $('#riskCard'),
  summaryDimensions: $('#summaryDimensions'),
  summarySize: $('#summarySize'),
  summaryMetadata: $('#summaryMetadata'),
  summaryColor: $('#summaryColor'),
  metadataGroups: $('#metadataGroups'),
  copyMetadataButton: $('#copyMetadataButton'),
  cleanHeadline: $('#cleanHeadline'),
  cleanSubline: $('#cleanSubline'),
  keepIccToggle: $('#keepIccToggle'),
  applyCleanButton: $('#applyCleanButton'),
  applyCleanLabel: $('#applyCleanLabel'),
  presetStrip: $('#presetStrip'),
  layerList: $('#layerList'),
  layerCount: $('#layerCount'),
  addLayerButton: $('#addLayerButton'),
  duplicateLayerButton: $('#duplicateLayerButton'),
  activeLayerName: $('#activeLayerName'),
  watermarkType: $('#watermarkType'),
  textWatermarkFields: $('#textWatermarkFields'),
  logoWatermarkFields: $('#logoWatermarkFields'),
  watermarkText: $('#watermarkText'),
  watermarkFont: $('#watermarkFont'),
  watermarkWeight: $('#watermarkWeight'),
  watermarkColor: $('#watermarkColor'),
  colorSwatches: $('#colorSwatches'),
  opacityRange: $('#opacityRange'),
  opacityOutput: $('#opacityOutput'),
  sizeRange: $('#sizeRange'),
  sizeOutput: $('#sizeOutput'),
  sizeRangeField: $('#sizeRangeField'),
  marginRange: $('#marginRange'),
  marginOutput: $('#marginOutput'),
  rotationRange: $('#rotationRange'),
  rotationOutput: $('#rotationOutput'),
  logoScaleRange: $('#logoScaleRange'),
  logoScaleOutput: $('#logoScaleOutput'),
  tileToggle: $('#tileToggle'),
  shadowToggle: $('#shadowToggle'),
  positionGrid: $('#positionGrid'),
  outputFormat: $('#outputFormat'),
  qualityRange: $('#qualityRange'),
  qualityOutput: $('#qualityOutput'),
  qualityField: $('#qualityField'),
  pickLogoButton: $('#pickLogoButton'),
  logoPreviewWrap: $('#logoPreviewWrap'),
  logoPreview: $('#logoPreview'),
  removeLogoButton: $('#removeLogoButton'),
  applyWatermarkButton: $('#applyWatermarkButton'),
  applyWatermarkLabel: $('#applyWatermarkLabel'),
  dropOverlay: $('#dropOverlay'),
  jobToast: $('#jobToast'),
  jobLabel: $('#jobLabel'),
  jobDetail: $('#jobDetail'),
  jobBar: $('#jobBar'),
  jobCancelButton: $('#jobCancelButton'),
  toastRegion: $('#toastRegion'),
  glossaryDialog: $('#glossaryDialog'),
  closeGlossaryButton: $('#closeGlossaryButton'),
  glossaryDoneButton: $('#glossaryDoneButton'),
  inspectorScroll: $('.inspector-scroll'),
  tabs: $$('.inspector-tabs [role="tab"]'),
  panels: $$('.tab-panel'),
};

let dragDepth = 0;
let previewFrame = 0;
let saveTimer = 0;
let clearTimer = 0;
let uidCounter = 0;
let layerCounter = 0;
let renameNumberingManual = false;

init();

function init() {
  loadSettings();
  ensureWatermarkLayers();
  renderPresetStrip();
  syncWatermarkControls();
  bindEvents();
  setupResizeObserver();
  renderSelectionState();
  if (!state.items.length) showLanding();
  restoreLayerLogos();
  document.documentElement.dataset.appReady = 'true';
}

/* -------------------------------------------------------------------------- */
/* Import                                                                      */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  for (const button of $$('[data-open-picker]')) {
    button.addEventListener('click', () => openFilePicker());
  }
  els.landingDrop.addEventListener('click', () => openFilePicker());
  els.landingDrop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFilePicker();
    }
  });
  els.topAddButton.addEventListener('click', () => openFilePicker());
  els.libraryAddButton.addEventListener('click', () => openFilePicker());
  els.libraryDrop.addEventListener('click', () => openFilePicker());
  els.fileInput.addEventListener('change', () => {
    handleFiles(els.fileInput.files, 'picker');
    els.fileInput.value = '';
  });

  els.loadDemoButton.addEventListener('click', loadDemoImages);

  els.zipButton.addEventListener('click', downloadZip);
  els.selectAllCheckbox.addEventListener('change', () => {
    const check = els.selectAllCheckbox.checked;
    for (const item of state.items) item.checked = check;
    renderLibrary();
    renderSelectionState();
  });
  els.clearButton.addEventListener('click', handleClearButton);
  els.renameButton.addEventListener('click', openRenameDialog);
  for (const input of [
    els.renamePrefix,
    els.renameSuffix,
    els.renameStart,
    els.renameSeparator,
  ]) {
    input.addEventListener('input', updateRenamePreview);
  }
  els.renameBase.addEventListener('input', () => {
    if (
      !renameNumberingManual &&
      els.renameBase.value.trim() &&
      selectedItems().length > 1
    ) {
      els.renameNumbering.checked = true;
    }
    updateRenamePreview();
  });
  els.renameNumbering.addEventListener('change', () => {
    renameNumberingManual = true;
    updateRenamePreview();
  });
  els.renameDigits.addEventListener('change', updateRenamePreview);
  els.renameUseDateButton.addEventListener('click', () => {
    els.renameBase.value = dateStamp();
    if (!renameNumberingManual && selectedItems().length > 1) {
      els.renameNumbering.checked = true;
    }
    updateRenamePreview();
    els.renameBase.focus();
  });
  els.closeRenameButton.addEventListener('click', closeRenameDialog);
  els.cancelRenameButton.addEventListener('click', closeRenameDialog);
  els.applyRenameButton.addEventListener('click', applyRename);
  els.renameDialog.addEventListener('click', (event) => {
    if (event.target === els.renameDialog) closeRenameDialog();
  });
  els.renameDialog.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      event.target instanceof HTMLInputElement &&
      !els.applyRenameButton.disabled
    ) {
      event.preventDefault();
      applyRename();
    }
  });

  els.fileList.addEventListener('click', (event) => {
    const card = event.target.closest('.file-card');
    if (!card) return;
    if (event.target.closest('.file-check')) {
      toggleChecked(card.dataset.id);
      return;
    }
    selectItem(card.dataset.id);
  });
  els.fileList.addEventListener('keydown', (event) => {
    const card = event.target.closest('.file-card');
    if (!card) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      selectItem(card.dataset.id);
    } else if (event.key === ' ') {
      event.preventDefault();
      toggleChecked(card.dataset.id);
    }
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => setActiveTab(tab.dataset.tab));
    tab.addEventListener('keydown', handleTabKeydown);
  });

  els.prevButton.addEventListener('click', () => stepCurrent(-1));
  els.nextButton.addEventListener('click', () => stepCurrent(1));
  els.downloadCurrentButton.addEventListener('click', downloadCurrent);
  els.restoreButton.addEventListener('click', restoreCurrent);
  els.removeButton.addEventListener('click', removeCurrent);
  els.compareToggle.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    setPreviewView(button.dataset.view);
  });
  els.copyMetadataButton.addEventListener('click', copyMetadata);
  els.keepIccToggle.addEventListener('change', () => {
    state.keepIcc = els.keepIccToggle.checked;
    persistSettings();
    updateCleanPanel();
  });
  els.applyCleanButton.addEventListener('click', applyClean);
  els.applyWatermarkButton.addEventListener('click', applyWatermark);

  els.presetStrip.addEventListener('click', (event) => {
    const button = event.target.closest('[data-preset]');
    if (button) applyWatermarkPreset(button.dataset.preset);
  });
  els.layerList.addEventListener('click', handleLayerListClick);
  els.addLayerButton.addEventListener('click', addWatermarkLayer);
  els.duplicateLayerButton.addEventListener('click', duplicateWatermarkLayer);

  els.watermarkType.addEventListener('click', (event) => {
    const button = event.target.closest('[data-type]');
    const layer = currentLayer();
    if (!button || !layer) return;
    layer.type = button.dataset.type === 'logo' ? 'logo' : 'text';
    syncWatermarkType();
    onWatermarkEdited();
  });
  els.watermarkText.addEventListener('input', () => {
    const layer = currentLayer();
    if (!layer) return;
    layer.text = els.watermarkText.value;
    onWatermarkEdited();
  });
  els.watermarkFont.addEventListener('change', () => {
    const layer = currentLayer();
    if (!layer) return;
    layer.font = els.watermarkFont.value;
    onWatermarkEdited();
  });
  els.watermarkWeight.addEventListener('change', () => {
    const layer = currentLayer();
    if (!layer) return;
    layer.weight = Number(els.watermarkWeight.value);
    onWatermarkEdited();
  });
  els.watermarkColor.addEventListener('input', () => {
    const layer = currentLayer();
    if (!layer) return;
    layer.color = els.watermarkColor.value;
    syncColorSelection(layer.color);
    onWatermarkEdited();
  });
  els.colorSwatches.addEventListener('click', (event) => {
    const button = event.target.closest('[data-color]');
    const layer = currentLayer();
    if (!button || !layer) return;
    layer.color = button.dataset.color;
    els.watermarkColor.value = button.dataset.color;
    syncColorSelection(button.dataset.color);
    onWatermarkEdited();
  });
  bindRange(els.opacityRange, els.opacityOutput, null, (value) => `${Math.round(value)}%`, 0, (value, layer) => {
    layer.opacity = value / 100;
  });
  bindRange(els.sizeRange, els.sizeOutput, 'size', (value) => `${value.toFixed(1)}%`, 1);
  bindRange(els.marginRange, els.marginOutput, 'margin', (value) => `${value.toFixed(1)}%`, 1);
  bindRange(els.rotationRange, els.rotationOutput, 'rotation', (value) => `${Math.round(value)}°`);
  bindRange(
    els.logoScaleRange,
    els.logoScaleOutput,
    'logoScale',
    (value) => `${Math.round(value)}%`,
  );
  els.tileToggle.addEventListener('change', () => {
    const layer = currentLayer();
    if (!layer) return;
    layer.tile = els.tileToggle.checked;
    onWatermarkEdited();
  });
  els.shadowToggle.addEventListener('change', () => {
    const layer = currentLayer();
    if (!layer) return;
    layer.shadow = els.shadowToggle.checked;
    onWatermarkEdited();
  });
  els.positionGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-position]');
    const layer = currentLayer();
    if (!button || !layer) return;
    layer.position = button.dataset.position;
    syncPositionSelection(button.dataset.position);
    onWatermarkEdited();
  });
  els.outputFormat.addEventListener('change', () => {
    state.outputFormat = els.outputFormat.value;
    persistSettings();
    updateQualityVisibility();
    updateWatermarkPanel();
  });
  bindRange(
    els.qualityRange,
    els.qualityOutput,
    null,
    (value) => `${Math.round(value * 100)}%`,
    0,
    (value) => {
      state.quality = value / 100;
    },
  );

  els.pickLogoButton.addEventListener('click', () => els.logoInput.click());
  els.logoInput.addEventListener('change', async () => {
    const file = els.logoInput.files?.[0];
    els.logoInput.value = '';
    if (file) await handleLogoFile(file);
  });
  els.removeLogoButton.addEventListener('click', removeLogo);

  for (const button of $$('[data-open-glossary]')) {
    button.addEventListener('click', openGlossary);
  }
  els.closeGlossaryButton.addEventListener('click', closeGlossary);
  els.glossaryDoneButton.addEventListener('click', closeGlossary);
  els.glossaryDialog.addEventListener('click', (event) => {
    if (event.target === els.glossaryDialog) closeGlossary();
  });
  els.jobCancelButton.addEventListener('click', cancelJob);

  els.stageImage.addEventListener('load', handleStageImageLoad);
  els.stageImage.addEventListener('error', handleStageImageError);

  document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => isImageFile(file));
    if (files.length) {
      event.preventDefault();
      handleFiles(files, 'paste');
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      openFilePicker();
    }
  });

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    showDropOverlay(true);
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    if (!dragDepth) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showDropOverlay(false);
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    showDropOverlay(false);
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) handleFiles(files, 'drop');
  });
  window.addEventListener('dragend', () => {
    dragDepth = 0;
    showDropOverlay(false);
  });
  window.addEventListener('blur', () => {
    dragDepth = 0;
    showDropOverlay(false);
  });

  window.addEventListener('resize', schedulePreview);
  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
  });
}

function openFilePicker() {
  if (state.busy) {
    showToast('正在处理图片，请稍候。', { type: 'error' });
    return;
  }
  els.fileInput.click();
}

async function handleFiles(fileList, source = 'picker') {
  if (state.busy) {
    showToast('正在处理图片，请稍候再添加。', { type: 'error' });
    return;
  }
  const files = [...(fileList || [])];
  if (!files.length) return;

  const accepted = [];
  let rejectedType = 0;
  let rejectedSize = 0;
  let overLimit = 0;
  let usedBytes = state.items.reduce((sum, item) => sum + item.file.size, 0);

  for (const file of files) {
    if (!file || !isImageFile(file)) {
      rejectedType += 1;
      continue;
    }
    if (state.items.length + accepted.length >= MAX_FILES) {
      overLimit += 1;
      continue;
    }
    if (usedBytes + file.size > MAX_TOTAL_BYTES) {
      rejectedSize += 1;
      continue;
    }
    accepted.push(file);
    usedBytes += file.size;
  }

  if (!accepted.length) {
    if (rejectedType) showToast('只支持 JPG、PNG 和 WebP 图片。', { type: 'error' });
    else if (overLimit) showToast(`一次最多处理 ${MAX_FILES} 张照片。`, { type: 'error' });
    else if (rejectedSize) showToast('本批次合计超过 200 MB，请分批导入。', { type: 'error' });
    return;
  }

  const newItems = accepted.map((file) => createItem(file));
  state.items.push(...newItems);
  state.items.forEach((item) => {
    if (newItems.includes(item)) item.checked = true;
  });

  if (!state.currentId || !state.items.some((item) => item.id === state.currentId)) {
    state.currentId = newItems[0].id;
  }
  if (state.activeTab === 'watermark') state.previewView = 'original';

  showWorkspace();
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (rejectedType) {
    showToast(`${rejectedType} 个文件格式不支持，已跳过。`, { type: 'error' });
  }
  if (overLimit) {
    showToast(`已达到 ${MAX_FILES} 张上限，${overLimit} 个文件未导入。`, { type: 'error' });
  }
  if (rejectedSize) {
    showToast(`超过 200 MB，${rejectedSize} 个文件未导入。`, { type: 'error' });
  }
  if (source === 'paste') {
    showToast(`已从剪贴板添加 ${newItems.length} 张照片。`);
  }

  await hydrateItems(newItems);
}

function createItem(file) {
  uidCounter += 1;
  const id = `img-${Date.now().toString(36)}-${uidCounter}`;
  return {
    id,
    file,
    name: file.name || `image-${uidCounter}.jpg`,
    objectUrl: URL.createObjectURL(file),
    analysis: null,
    analysisError: '',
    loadingAnalysis: true,
    width: 0,
    height: 0,
    checked: true,
    processing: false,
    processError: '',
    result: null,
    baseBlob: null,
    previewError: false,
  };
}

async function hydrateItems(items) {
  const queue = [...items];
  const failures = [];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!state.items.includes(item)) continue;
      try {
        const analysis = await inspectImage(item.file, item.name);
        item.analysis = analysis;
        item.width = analysis.width || item.width;
        item.height = analysis.height || item.height;
      } catch (error) {
        item.analysisError = error?.message || '无法读取照片信息';
        failures.push(item.name);
      } finally {
        item.loadingAnalysis = false;
      }
      if (state.currentId === item.id) {
        renderCurrent();
      }
    }
  };

  const workers = Array.from({ length: Math.min(3, items.length) }, () => worker());
  await Promise.all(workers);
  renderAll();
  if (failures.length) {
    showToast(`${failures.length} 张照片的隐藏信息无法完整读取，仍可尝试处理。`, {
      type: 'error',
      duration: 5200,
    });
  }
}

async function loadDemoImages() {
  if (state.busy) return;
  const button = els.loadDemoButton;
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = '正在载入示例…';
  try {
    const samples = [
      ['外滩暮色.jpg', 'assets/samples/sample-01.jpg'],
      ['山谷晨雾.jpg', 'assets/samples/sample-02.jpg'],
      ['夜航.jpg', 'assets/samples/sample-03.jpg'],
    ];
    const files = [];
    for (const [name, path] of samples) {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`示例图片加载失败（${response.status}）`);
      const blob = await response.blob();
      files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
    }
    await handleFiles(files, 'demo');
  } catch (error) {
    console.error(error);
    showToast('示例图片加载失败。请确认通过本地服务器打开网站。', {
      type: 'error',
      duration: 6000,
    });
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

function isImageFile(file) {
  const name = String(file?.name || '').toLowerCase();
  const extension = name.split('.').pop();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) return false;
  if (!file.type) return true;
  return file.type === 'image/jpeg' || file.type === 'image/jpg' || file.type === 'image/png' || file.type === 'image/webp';
}

function hasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

function showDropOverlay(show) {
  els.dropOverlay.hidden = !show;
  els.landingDrop.classList.toggle('is-dragover', show && !els.landingView.hidden);
}

/* -------------------------------------------------------------------------- */
/* Selection and view                                                          */
/* -------------------------------------------------------------------------- */

function currentItem() {
  return state.items.find((item) => item.id === state.currentId) || null;
}

function selectedItems() {
  return state.items.filter((item) => item.checked);
}

function selectItem(id) {
  if (!state.items.some((item) => item.id === id)) return;
  state.currentId = id;
  state.previewView =
    state.activeTab === 'watermark' ? 'original' : currentItem()?.result ? 'result' : 'original';
  renderLibrary();
  renderCurrent();
  scrollCurrentCard();
}

function toggleChecked(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item || state.busy) return;
  item.checked = !item.checked;
  const card = $(`.file-card[data-id="${id}"]`, els.fileList);
  if (card) {
    card.classList.toggle('is-checked', item.checked);
    card.setAttribute('aria-selected', String(item.checked));
  }
  renderSelectionState();
}

function stepCurrent(direction) {
  if (!state.items.length) return;
  const index = state.items.findIndex((item) => item.id === state.currentId);
  const next = (index + direction + state.items.length) % state.items.length;
  selectItem(state.items[next].id);
}

function scrollCurrentCard() {
  requestAnimationFrame(() => {
    const card = $(`.file-card[data-id="${state.currentId}"]`, els.fileList);
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function setPreviewView(view) {
  const item = currentItem();
  if (view === 'result' && !item?.result) return;
  state.previewView = view === 'result' ? 'result' : 'original';
  updateStageMedia();
  syncCompareToggle();
  if (item) {
    updateStageBadge(item);
    updateStageFoot(item, statusFor(item));
    updateStagePrivacy(item);
    if (els.stageAnnouncer) {
      els.stageAnnouncer.textContent = `${state.previewView === 'result' ? '正在查看处理结果' : '正在查看原图'}：${item.name}`;
    }
  }
  updateDownloadButton();
  schedulePreview();
}

function setActiveTab(tab) {
  if (!['metadata', 'clean', 'watermark'].includes(tab)) return;
  state.activeTab = tab;
  for (const button of els.tabs) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of els.panels) {
    panel.hidden = panel.id !== `panel-${tab}`;
  }
  const item = currentItem();
  state.previewView = tab === 'watermark' ? 'original' : item?.result ? 'result' : 'original';
  els.inspectorScroll.scrollTop = 0;
  updateStageMedia();
  syncCompareToggle();
  updateDownloadButton();
  if (item) {
    updateStageBadge(item);
    updateStageFoot(item, statusFor(item));
    updateStagePrivacy(item);
  }
  schedulePreview();
}

function handleTabKeydown(event) {
  const index = els.tabs.indexOf(event.currentTarget);
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % els.tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + els.tabs.length) % els.tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = els.tabs.length - 1;
  else return;
  event.preventDefault();
  els.tabs[next].focus();
  setActiveTab(els.tabs[next].dataset.tab);
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function renderAll() {
  if (!state.items.length) {
    renderSelectionState();
    showLanding();
    return;
  }
  if (els.workspaceView.hidden) showWorkspace();
  if (!state.items.some((item) => item.id === state.currentId)) {
    state.currentId = state.items[0].id;
  }
  renderLibrary();
  renderCurrent();
  renderSelectionState();
}

function showLanding() {
  els.landingView.hidden = false;
  els.workspaceView.hidden = true;
  document.body.classList.remove('is-workspace');
  els.batchIndicator.hidden = true;
}

function showWorkspace() {
  if (els.landingView.hidden) return;
  els.landingView.hidden = true;
  els.workspaceView.hidden = false;
  document.body.classList.add('is-workspace');
  els.batchIndicator.hidden = false;
  requestAnimationFrame(() => {
    els.stageViewport.scrollTop = 0;
  });
}

function renderLibrary() {
  const focusedId = document.activeElement?.closest?.('.file-card')?.dataset.id;
  const scrollTop = els.fileList.scrollTop;
  const scrollLeft = els.fileList.scrollLeft;
  els.fileList.setAttribute('role', 'listbox');
  els.fileList.setAttribute('aria-multiselectable', 'true');
  els.fileList.innerHTML = state.items.map(fileCardTemplate).join('');
  els.fileList.scrollTop = scrollTop;
  els.fileList.scrollLeft = scrollLeft;
  if (focusedId) {
    requestAnimationFrame(() => {
      const card = $(`.file-card[data-id="${focusedId}"]`, els.fileList);
      card?.focus({ preventScroll: true });
    });
  }
  els.libraryCount.textContent = String(state.items.length);
  els.libraryTotalSize.textContent = formatBytes(
    state.items.reduce((sum, item) => sum + item.file.size, 0),
  );
}

function fileCardTemplate(item) {
  const status = statusFor(item);
  const dimensions =
    item.width && item.height ? `${item.width} × ${item.height}` : item.loadingAnalysis ? '读取中' : '尺寸未知';
  const format = (item.analysis?.format || item.file.name.split('.').pop() || 'image').toUpperCase();
  const aria = [
    item.name,
    item.checked ? '已勾选' : '未勾选',
    status.short,
    item.result ? '包含处理结果' : '原图',
  ].join('，');
  return `
    <article
      class="file-card ${item.checked ? 'is-checked' : ''} ${item.id === state.currentId ? 'is-current' : ''}"
      data-id="${escapeHtml(item.id)}"
      tabindex="0"
      role="option"
      aria-selected="${item.checked}"
      aria-label="${escapeHtml(aria)}"
    >
      <div class="file-thumb-wrap">
        <img class="file-thumb" src="${escapeHtml(item.objectUrl)}" alt="" loading="lazy" draggable="false" />
        <span class="file-check" aria-hidden="true"><span class="check-box">${icon('check')}</span></span>
        ${item.processing ? `<span class="file-thumb-spinner">${icon('spinner')}</span>` : ''}
      </div>
      <div class="file-info">
        <div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="file-sub">
          <span>${escapeHtml(dimensions)}</span><span class="dot"></span>
          <span>${escapeHtml(format)}</span><span class="dot"></span>
          <span>${formatBytes(item.result ? item.result.blob.size : item.file.size)}</span>
        </div>
        <span class="file-state ${status.className}" title="${escapeHtml(status.title || status.label)}">${escapeHtml(item.processing ? '处理中…' : status.label)}</span>
      </div>
    </article>
  `;
}

function renderCurrent() {
  const item = currentItem();
  if (!item) return;
  const status = statusFor(item);
  const index = state.items.findIndex((entry) => entry.id === item.id);

  els.stageIndex.textContent = `${String(index + 1).padStart(2, '0')} / ${String(state.items.length).padStart(2, '0')}`;
  els.stageName.textContent = item.name;
  els.stageName.title = item.name;
  updateStageBadge(item);
  if (els.stageAnnouncer) {
    els.stageAnnouncer.textContent = `正在预览 ${item.name}，${els.stageBadge.textContent}`;
  }
  els.prevButton.disabled = state.items.length < 2 || state.busy;
  els.nextButton.disabled = state.items.length < 2 || state.busy;
  els.removeButton.disabled = state.busy;
  els.restoreButton.hidden = !item.result || state.busy;

  state.previewView = item.result ? state.previewView : 'original';
  updateStageMedia();
  syncCompareToggle();
  updateDownloadButton();
  updateStageFoot(item, status);
  updateStagePrivacy(item);
  updateStageEmpty(item);
  renderMetadataPanel();
  updateCleanPanel();
  updateWatermarkPanel();
}

function updateStageMedia() {
  const item = currentItem();
  if (!item) return;
  const useResult = state.previewView === 'result' && item.result;
  const url = useResult ? item.result.url : item.objectUrl;
  if (els.stageImage.dataset.url !== url) {
    els.stageImage.dataset.url = url;
    els.stageImage.src = url;
    els.stageImage.alt = `${item.name}${useResult ? ' 的处理结果' : ''}`;
  } else if (els.stageImage.alt !== `${item.name}${useResult ? ' 的处理结果' : ''}`) {
    els.stageImage.alt = `${item.name}${useResult ? ' 的处理结果' : ''}`;
  }
  const showOverlay =
    state.activeTab === 'watermark' && state.previewView === 'original' && Boolean(item);
  if (!showOverlay) {
    els.watermarkCanvas.hidden = true;
    els.previewTag.hidden = true;
  }
  schedulePreview();
}

function updateStageBadge(item) {
  const status = statusFor(item);
  const viewingResult = state.previewView === 'result' && item.result;
  const badge =
    item.result && !viewingResult && !item.processing && !item.processError
      ? { short: '原图', badgeClass: '' }
      : status;
  els.stageBadge.textContent = badge.short;
  els.stageBadge.className = `status-badge ${badge.badgeClass || ''}`.trim();
}

function updateStageFoot(item, status) {
  const output = item.result;
  const viewingResult = output && state.previewView === 'result';
  const width = viewingResult ? output.width : item.width || item.analysis?.width || 0;
  const height = viewingResult ? output.height : item.height || item.analysis?.height || 0;
  els.footDimensions.textContent = width && height ? `${width} × ${height} px` : '读取尺寸中';
  els.footMetaSize.textContent = viewingResult
    ? `${formatBytes(output.blob.size)} 输出`
    : formatBytes(item.file.size);
  let stateText = viewingResult ? status.label : '原图';
  if (viewingResult && output.removedBytes > 0) stateText += ` · 减少 ${formatBytes(output.removedBytes)}`;
  els.footMetaState.textContent = stateText;
}

function updateStagePrivacy(item) {
  const use = els.stagePrivacy.querySelector('use');
  const viewingResult = state.previewView === 'result' && item.result;
  if (viewingResult?.cleaned) {
    els.stagePrivacy.hidden = false;
    els.stagePrivacy.classList.add('is-safe');
    use?.setAttribute('href', '#i-shield');
    els.stagePrivacyText.textContent = '隐藏信息已清理';
    return;
  }
  if (!item.analysis) {
    els.stagePrivacy.hidden = true;
    return;
  }
  const risks = item.analysis.risks.filter((risk) => risk.severity !== 'low');
  if (!risks.length) {
    els.stagePrivacy.hidden = true;
    return;
  }
  els.stagePrivacy.hidden = false;
  els.stagePrivacy.classList.remove('is-safe');
  use?.setAttribute('href', '#i-alert');
  const labels = risks.slice(0, 2).map((risk) => risk.label);
  const extra = risks.length > 2 ? ` +${risks.length - 2}` : '';
  els.stagePrivacyText.textContent = `${labels.join(' · ')}${extra}`;
}

function updateStageEmpty(item) {
  els.stageEmpty.hidden = Boolean(item);
}

function syncCompareToggle() {
  const item = currentItem();
  const show = Boolean(item?.result);
  els.compareToggle.hidden = !show;
  for (const button of $$('button', els.compareToggle)) {
    const active = button.dataset.view === state.previewView;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function updateDownloadButton() {
  const item = currentItem();
  const useResult = state.previewView === 'result' && item?.result;
  els.downloadCurrentButton.disabled = !item || state.busy;
  els.downloadCurrentButton.title = useResult ? '下载处理结果' : '下载当前原图';
  els.downloadCurrentButton.setAttribute(
    'aria-label',
    useResult ? '下载处理结果' : '下载当前原图',
  );
}

function handleStageImageLoad() {
  const item = currentItem();
  if (!item) return;
  if (!item.width && els.stageImage.naturalWidth) {
    item.width = els.stageImage.naturalWidth;
    item.height = els.stageImage.naturalHeight;
    updateStageFoot(item, statusFor(item));
  }
  schedulePreview();
}

function handleStageImageError() {
  const item = currentItem();
  if (!item || item.previewError) return;
  item.previewError = true;
  showToast(`无法预览 ${item.name}，文件可能已损坏。`, { type: 'error' });
}

function renderSelectionState() {
  const selected = selectedItems().length;
  const total = state.items.length;
  els.selectAllCheckbox.checked = selected > 0 && selected === total;
  els.selectAllCheckbox.indeterminate = selected > 0 && selected < total;
  els.selectAllCheckbox.disabled = state.busy || !total;
  els.selectionCount.textContent = `${selected} / ${total}`;
  els.zipCount.textContent = String(selected);
  els.zipCount.hidden = selected === 0;
  els.zipButton.disabled = state.busy || selected === 0;
  els.zipButton.setAttribute(
    'aria-label',
    selected ? `打包下载已选 ${selected} 张` : '打包下载已选图片',
  );
  els.zipButton.title = selected
    ? `打包下载已选 ${selected} 张（未处理的原图将原样导出）`
    : '请先勾选图片';
  els.batchIndicator.textContent = selected ? `${selected} 张已选` : `${total} 张图片`;
  els.batchIndicator.hidden = !total;
  els.clearButton.disabled = state.busy || !total;
  els.renameButton.disabled = state.busy || selected === 0;
  els.renameButton.title = selected
    ? `批量修改已选 ${selected} 张照片的文件名`
    : '先勾选要改名的照片';
  els.renameButton.setAttribute(
    'aria-label',
    selected ? `批量修改已选 ${selected} 张照片的文件名` : '批量修改文件名',
  );
  els.topAddButton.disabled = state.busy;
  els.libraryAddButton.disabled = state.busy;
  els.libraryDrop.disabled = state.busy;
  els.selectAllCheckbox.disabled = state.busy || !total;
  els.keepIccToggle.disabled = state.busy;
  updateCleanPanel();
  updateWatermarkPanel();
}

/* -------------------------------------------------------------------------- */
/* Metadata panel                                                              */
/* -------------------------------------------------------------------------- */

function renderMetadataPanel() {
  const item = currentItem();
  if (!item) return;
  const analysis = item.analysis;

  if (!analysis) {
    if (item.analysisError) {
      els.riskCard.className = 'risk-card has-risk';
      els.riskCard.innerHTML = `
        <div class="risk-card-top">
          <span class="risk-icon">${icon('alert')}</span>
          <div>
            <strong>照片信息读取失败</strong>
            <p>${escapeHtml(item.analysisError)}</p>
          </div>
        </div>
      `;
    } else {
      els.riskCard.className = 'risk-card';
      els.riskCard.innerHTML = `
        <div class="risk-card-top">
          <span class="risk-icon">${icon('spinner')}</span>
          <div>
            <strong>正在读取照片信息…</strong>
            <p>文件只在本地解析，通常只需要一瞬间。</p>
          </div>
        </div>
      `;
    }
    els.summaryDimensions.textContent = '—';
    els.summarySize.textContent = formatBytes(item.file.size);
    els.summaryMetadata.textContent = '—';
    els.summaryColor.textContent = '—';
    els.metadataGroups.innerHTML = '';
    els.copyMetadataButton.disabled = true;
    return;
  }

  const risks = analysis.risks || [];
  const gpsRisk = risks.find((risk) => risk.id === 'gps');
  const processedNote = item.result?.cleaned ? ' 当前展示的是原图信息；导出的结果已经清理。' : '';
  const riskTitle = risks.length
    ? gpsRisk
      ? '这张照片可能暴露你的位置'
      : `这张照片带着 ${risks.length} 条个人线索`
    : '这张照片看起来挺干净';
  const riskDescription = risks.length
    ? `这些内容会跟着文件一起发出去。清理后，它们会被删除。${processedNote}`
    : `没有发现明显的位置、设备或作者信息。你仍然可以清理一次，确保干净。${processedNote}`;
  els.riskCard.className = `risk-card ${risks.length ? 'has-risk' : 'is-safe'}`;
  els.riskCard.innerHTML = `
    <div class="risk-card-top">
      <span class="risk-icon">${icon(risks.length ? 'alert' : 'shield')}</span>
      <div>
        <strong>${escapeHtml(riskTitle)}</strong>
        <p>${escapeHtml(riskDescription)}</p>
      </div>
    </div>
    ${
      risks.length
        ? `<div class="risk-chips">${risks
            .slice(0, 5)
            .map(
              (risk) =>
                `<span class="risk-chip ${risk.severity === 'medium' ? 'is-medium' : risk.severity === 'low' ? 'is-low' : ''}" title="${escapeHtml(risk.detail || '')}"><span>${escapeHtml(risk.label)}</span></span>`,
            )
            .join('')}</div>`
        : ''
    }
  `;

  els.summaryDimensions.textContent = analysis.width ? `${analysis.width} × ${analysis.height}` : '—';
  els.summarySize.textContent = formatBytes(analysis.byteSize);
  els.summaryMetadata.textContent = formatBytes(analysis.metadataBytes);
  els.summaryColor.textContent = analysis.colorSpace || '未标注';
  els.copyMetadataButton.disabled = false;

  const groups = analysis.groupList || [];
  if (!groups.length) {
    els.metadataGroups.innerHTML = `<p class="panel-footnote">没有读到更多隐藏信息。</p>`;
    return;
  }

  els.metadataGroups.innerHTML = groups
    .map((group) => {
      const open =
        group.id === 'file' ||
        (group.id === 'location' && analysis.hasGps) ||
        (group.id === 'rights' && risks.some((risk) => risk.id === 'identity'));
      return `
        <details class="meta-group" ${open ? 'open' : ''}>
          <summary>
            <span class="meta-group-icon">${icon(group.icon || 'file')}</span>
            <span class="meta-group-title">
              <strong>${escapeHtml(group.label)}</strong>
              <small>${escapeHtml(group.description || '')}</small>
            </span>
            <span class="meta-group-count">${group.rows.length}</span>
            ${icon('chevron-down')}
          </summary>
          <div class="meta-rows">
            ${group.rows
              .map(
                (row) => `
                  <div class="meta-row">
                    <dt>${escapeHtml(row.label)}</dt>
                    <dd>${escapeHtml(row.value)}${row.note ? `<small>${escapeHtml(row.note)}</small>` : ''}</dd>
                  </div>
                `,
              )
              .join('')}
          </div>
        </details>
      `;
    })
    .join('');
}

async function copyMetadata() {
  const item = currentItem();
  if (!item?.analysis) return;
  const lines = [
    `净帧 CLEANFRAME · ${item.name}`,
    `格式：${item.analysis.summary.format}  |  尺寸：${item.analysis.summary.dimensions}  |  大小：${formatBytes(item.analysis.byteSize)}`,
    `隐藏信息占用：${formatBytes(item.analysis.metadataBytes)}`,
    '',
  ];
  for (const group of item.analysis.groupList) {
    lines.push(`【${group.label}】`);
    for (const row of group.rows) lines.push(`${row.label}：${row.value}`);
    lines.push('');
  }
  try {
    await copyText(lines.join('\n'));
    showToast('照片信息已复制到剪贴板。');
  } catch {
    showToast('复制失败，请检查浏览器权限。', { type: 'error' });
  }
}

/* -------------------------------------------------------------------------- */
/* Clean panel and processing                                                  */
/* -------------------------------------------------------------------------- */

function updateCleanPanel() {
  const targets = selectedItems();
  const count = targets.length;
  const loading = targets.some((item) => item.loadingAnalysis);
  const bytes = targets.reduce((sum, item) => sum + (item.analysis?.metadataBytes || 0), 0);
  const fields = targets.reduce((sum, item) => {
    const groups = item.analysis?.groupList || [];
    return sum + groups.filter((group) => group.id !== 'file').reduce((n, group) => n + group.rows.length, 0);
  }, 0);

  if (!count) {
    els.cleanHeadline.textContent = '还没有勾选照片';
    els.cleanSubline.textContent = '在左侧勾选要清理的照片。';
  } else if (loading) {
    els.cleanHeadline.textContent = '正在读取照片信息…';
    els.cleanSubline.textContent = '读完就可以一起清理。';
  } else {
    els.cleanHeadline.textContent = `${count} 张照片 · ${fields} 条隐藏信息`;
    els.cleanSubline.textContent = bytes
      ? `预计删除 ${formatBytes(bytes)} 的隐藏信息，画面不会变。`
      : '没有发现常见的位置或设备信息，仍可以安全清理一遍。';
  }

  const disabled = state.busy || !count || loading;
  els.applyCleanButton.disabled = disabled;
  els.applyCleanLabel.textContent = !count
    ? '选择图片后清理'
    : loading
      ? '正在读取照片信息…'
      : `清理 ${count} 张照片的隐藏信息`;
}

async function applyClean() {
  if (state.busy) return;
  const targets = selectedItems();
  if (!targets.length) {
    showToast('请先在左侧勾选图片。', { type: 'error' });
    return;
  }
  if (targets.some((item) => item.loadingAnalysis)) {
    showToast('照片信息还在读取中，请稍候。', { type: 'error' });
    return;
  }

  const snapshots = [];
  const successes = [];
  const failures = [];
  const keepColorProfile = state.keepIcc;
  const job = beginJob({
    label: '正在清理照片信息',
    detail: `0 / ${targets.length}`,
    cancellable: true,
  });

  try {
    for (let index = 0; index < targets.length; index += 1) {
      if (job.cancel) break;
      const item = targets[index];
      snapshots.push({ item, previous: item.result, baseBlob: item.baseBlob });
      item.processing = true;
      item.processError = '';
      renderLibrary();
      updateJob({
        label: '正在清理照片信息',
        detail: `${index + 1} / ${targets.length} · ${item.name}`,
        ratio: index / targets.length,
      });

      try {
        const base = item.result?.blob || item.file;
        const hasWatermark = Boolean(item.result?.hasWatermark);
        const analysis = base === item.file ? item.analysis : null;
        const output = await stripMetadata(base, analysis, {
          keepColorProfile,
          reencodeQuality: 0.95,
        });
        const result = makeResult(item, output, {
          hasWatermark,
          cleaned: true,
          suffix: hasWatermark ? '-watermark' : '-clean',
          removedBytes: output.removedBytes,
        });
        replaceResult(item, result);
        if (!hasWatermark) item.baseBlob = null;
        successes.push(item);
      } catch (error) {
        console.error(error);
        item.processError = error?.message || '处理失败';
        failures.push({ item, error });
      } finally {
        item.processing = false;
        renderLibrary();
      }

      updateJob({
        label: '正在清理照片信息',
        detail: `${index + 1} / ${targets.length}`,
        ratio: (index + 1) / targets.length,
      });
      await nextFrame();
    }
  } finally {
    endJob();
  }

  if (!successes.length && failures.length) {
    renderAll();
    showToast(`清理失败：${failures[0].error?.message || '未知错误'}`, {
      type: 'error',
      duration: 6500,
    });
    return;
  }

  if (successes.length) {
    state.previewView = 'result';
  }
  renderAll();
  const cancelled = Boolean(job.cancel && successes.length < targets.length);
  const message = buildResultMessage('已清理', successes.length, failures.length, cancelled);
  showToast(message, {
    type: failures.length ? 'error' : 'success',
    actionLabel: successes.length ? '撤销' : '',
    onAction: successes.length ? () => undoOperation(snapshots) : null,
    duration: 8000,
  });
}

async function applyWatermark() {
  if (state.busy) return;
  const targets = selectedItems();
  if (!targets.length) {
    showToast('请先在左侧勾选图片。', { type: 'error' });
    return;
  }
  if (
    state.watermarkLayers.some(
      (layer) => layer.enabled && layer.type === 'logo' && !state.logoImages.has(layer.id),
    )
  ) {
    showToast('有一个图片图层还没上传 Logo。', { type: 'error' });
    return;
  }
  if (!hasRenderableWatermark()) {
    showToast('先给至少一个图层填上文字或上传 Logo。', { type: 'error' });
    return;
  }

  const snapshots = [];
  const successes = [];
  const failures = [];
  const watermarkLayers = state.watermarkLayers.map((layer) => ({ ...layer }));
  const logos = logosObject();
  const outputFormat = state.outputFormat;
  const outputQuality = state.quality;
  const job = beginJob({
    label: '正在给照片加水印',
    detail: `0 / ${targets.length}`,
    cancellable: true,
  });

  try {
    for (let index = 0; index < targets.length; index += 1) {
      if (job.cancel) break;
      const item = targets[index];
      snapshots.push({
        item,
        previous: item.result,
        baseBlob: item.baseBlob,
      });
      item.processing = true;
      item.processError = '';
      renderLibrary();
      updateJob({
        label: '正在给照片加水印',
        detail: `${index + 1} / ${targets.length} · ${item.name}`,
        ratio: index / targets.length,
      });

      try {
        const base = item.result?.hasWatermark ? item.baseBlob || item.file : item.result?.blob || item.file;
        const baseMime = base.type || item.file.type || 'image/jpeg';
        const mime = outputMimeFor(baseMime, outputFormat);
        const output = await renderWatermarked(base, watermarkLayers, {
          mime,
          quality: outputQuality,
          logos,
        });
        if (!item.result?.hasWatermark) item.baseBlob = base;
        else if (!item.baseBlob) item.baseBlob = item.file;
        const result = makeResult(item, output, {
          hasWatermark: true,
          cleaned: true,
          suffix: '-watermark',
          removedBytes: 0,
        });
        replaceResult(item, result);
        successes.push(item);
      } catch (error) {
        console.error(error);
        item.processError = error?.message || '水印渲染失败';
        failures.push({ item, error });
      } finally {
        item.processing = false;
        renderLibrary();
      }

      updateJob({
        label: '正在给照片加水印',
        detail: `${index + 1} / ${targets.length}`,
        ratio: (index + 1) / targets.length,
      });
      await nextFrame();
    }
  } finally {
    endJob();
  }

  if (!successes.length && failures.length) {
    renderAll();
    showToast(`水印渲染失败：${failures[0].error?.message || '未知错误'}`, {
      type: 'error',
      duration: 6500,
    });
    return;
  }

  if (successes.length) state.previewView = 'result';
  renderAll();
  const cancelled = Boolean(job.cancel && successes.length < targets.length);
  const message = buildResultMessage('已加水印', successes.length, failures.length, cancelled);
  showToast(message, {
    type: failures.length ? 'error' : 'success',
    actionLabel: successes.length ? '撤销' : '',
    onAction: successes.length ? () => undoOperation(snapshots) : null,
    duration: 8000,
  });
}

function makeResult(item, output, options) {
  const mime = output.mime || output.blob.type || item.file.type || 'image/jpeg';
  const extension = extensionForMime(mime);
  const blob = output.blob;
  return {
    blob,
    url: URL.createObjectURL(blob),
    mime,
    width: output.width || item.width,
    height: output.height || item.height,
    hasWatermark: Boolean(options.hasWatermark),
    cleaned: Boolean(options.cleaned),
    suffix: options.suffix || '-clean',
    extension,
    removedBytes: Math.max(0, Number(options.removedBytes) || 0),
    createdAt: Date.now(),
  };
}

function replaceResult(item, result) {
  const previous = item.result;
  item.result = result;
  if (previous) retireResult(previous);
}

function retireResult(result, delay = 20000) {
  if (!result?.url) return;
  clearTimeout(result._retireTimer);
  result._retireTimer = setTimeout(() => {
    URL.revokeObjectURL(result.url);
    result._retired = true;
  }, delay);
}

function reviveResult(result) {
  if (!result) return;
  clearTimeout(result._retireTimer);
  result._retired = false;
}

function undoOperation(snapshots) {
  if (state.busy) return;
  let restored = 0;
  for (const snapshot of snapshots) {
    const { item, previous, baseBlob } = snapshot;
    if (!state.items.includes(item)) continue;
    if (item.result) retireResult(item.result, 1200);
    item.result = previous;
    item.baseBlob = baseBlob;
    item.processError = '';
    if (previous) reviveResult(previous);
    restored += 1;
  }
  state.previewView = currentItem()?.result ? 'result' : 'original';
  renderAll();
  if (restored) showToast(`已恢复到处理前的 ${restored} 张照片。`);
}

function buildResultMessage(prefix, successCount, failureCount, cancelled) {
  let message = `${prefix} ${successCount} 张`;
  if (failureCount) message += `，${failureCount} 张失败`;
  if (cancelled) message += '（已取消剩余任务）';
  return message;
}

function restoreCurrent() {
  const item = currentItem();
  if (!item || !item.result || state.busy) return;
  if (item.result) retireResult(item.result, 1200);
  item.result = null;
  item.baseBlob = null;
  item.processError = '';
  state.previewView = 'original';
  renderAll();
  showToast('已恢复为原始文件。');
}

function removeCurrent() {
  const item = currentItem();
  if (!item || state.busy) return;
  const index = state.items.findIndex((entry) => entry.id === item.id);
  state.items.splice(index, 1);
  disposeItemSoon(item);
  if (!state.items.length) {
    state.currentId = null;
    showLanding();
  } else {
    state.currentId = state.items[Math.min(index, state.items.length - 1)].id;
  }
  renderAll();
  showToast(`已移出列表：${item.name}`, {
    actionLabel: '撤销',
    onAction: () => {
      clearTimeout(item._disposeTimer);
      if (item.result) reviveResult(item.result);
      if (!state.items.some((entry) => entry.id === item.id)) {
        state.items.splice(Math.min(index, state.items.length), 0, item);
      }
      state.currentId = item.id;
      showWorkspace();
      renderAll();
      showToast('已放回列表。');
    },
    duration: 7000,
  });
}

function disposeItemSoon(item) {
  clearTimeout(item._disposeTimer);
  item._disposeTimer = setTimeout(() => {
    URL.revokeObjectURL(item.objectUrl);
    if (item.result?.url) URL.revokeObjectURL(item.result.url);
  }, 10000);
}

function handleClearButton() {
  if (state.busy || !state.items.length) return;
  if (!state.clearArmed) {
    state.clearArmed = true;
    els.clearButton.textContent = '再点一次';
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      state.clearArmed = false;
      els.clearButton.textContent = '清空';
    }, 3000);
    return;
  }
  clearTimeout(clearTimer);
  state.clearArmed = false;
  els.clearButton.textContent = '清空';
  clearAll();
}

function clearAll() {
  if (els.renameDialog.open) els.renameDialog.close();
  for (const item of state.items) {
    URL.revokeObjectURL(item.objectUrl);
    if (item.result?.url) URL.revokeObjectURL(item.result.url);
    clearTimeout(item._disposeTimer);
  }
  state.items = [];
  state.currentId = null;
  state.previewView = 'original';
  state.clearArmed = false;
  els.fileList.innerHTML = '';
  els.libraryCount.textContent = '0';
  els.libraryTotalSize.textContent = '0 B';
  els.stageImage.removeAttribute('src');
  els.stageImage.removeAttribute('data-url');
  els.watermarkCanvas.hidden = true;
  showLanding();
  renderSelectionState();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* -------------------------------------------------------------------------- */
/* Batch rename                                                               */
/* -------------------------------------------------------------------------- */

function computeRenamePlan() {
  const selected = selectedItems();
  const items = selected.map((item) => ({
    name: item.name,
    extension: `.${extensionForMime(item.file.type || 'image/jpeg')}`,
  }));
  return {
    selected,
    ...buildRenamePlan(items, {
      base: els.renameBase.value,
      prefix: els.renamePrefix.value,
      suffix: els.renameSuffix.value,
      numbering: els.renameNumbering.checked,
      start: els.renameStart.value,
      digits: els.renameDigits.value,
      separator: els.renameSeparator.value,
    }),
  };
}

function updateRenamePreview() {
  const count = selectedItems().length;
  els.renameNumberOptions.hidden = !els.renameNumbering.checked;
  els.renameScope.textContent = count
    ? `已选 ${count} 张照片 · 顺序与图片库一致`
    : '还没有选择照片';
  els.renamePreviewCount.textContent = count ? `${count} 张 · 扩展名自动保留` : '—';

  if (!count) {
    els.renamePreview.innerHTML = '<li class="more-names">在左侧勾选照片后，这里会显示名称预览。</li>';
    els.renameWarning.hidden = false;
    els.renameWarning.textContent = '先勾选要改名的照片。';
    els.applyRenameButton.disabled = true;
    return;
  }

  const result = computeRenamePlan();
  const visible = result.plans.slice(0, 6);
  els.renamePreview.innerHTML = visible.length
    ? visible
        .map(
          (plan) => `
            <li>
              <span class="old-name" title="${escapeHtml(plan.oldName)}">${escapeHtml(plan.oldName)}</span>
              <span class="arrow">→</span>
              <span class="new-name" title="${escapeHtml(plan.newName)}">${escapeHtml(plan.newName)}</span>
            </li>
          `,
        )
        .join('') +
      (result.plans.length > visible.length
        ? `<li class="more-names">还有 ${result.plans.length - visible.length} 张，应用后会按同样规则处理。</li>`
        : '')
    : '<li class="more-names">暂时无法生成名称，请检查上面的内容。</li>';

  let warning = '';
  if (result.error) warning = result.error;
  else if (!result.changed) warning = '名称还没有变化，先改一下上面的内容。';
  els.renameWarning.hidden = !warning;
  els.renameWarning.textContent = warning;
  els.applyRenameButton.disabled = state.busy || Boolean(result.error) || !result.changed;
}

function openRenameDialog() {
  if (state.busy) {
    showToast('正在处理照片，请稍候。', { type: 'error' });
    return;
  }
  if (!selectedItems().length) {
    showToast('先勾选要改名的照片。', { type: 'error' });
    return;
  }
  els.renameBase.value = '';
  els.renamePrefix.value = '';
  els.renameSuffix.value = '';
  els.renameNumbering.checked = false;
  renameNumberingManual = false;
  els.renameStart.value = '1';
  els.renameDigits.value = '2';
  els.renameSeparator.value = '-';
  updateRenamePreview();
  if (!els.renameDialog.open) els.renameDialog.showModal();
  requestAnimationFrame(() => els.renameBase.focus());
}

function closeRenameDialog() {
  if (els.renameDialog.open) els.renameDialog.close();
}

function updateAnalysisFileName(item, name) {
  if (!item.analysis) return;
  item.analysis.fileName = name;
  const row = item.analysis.groups?.get('file')?.find((entry) => entry.label === '文件名');
  if (row) row.value = name;
}

function applyRename() {
  if (state.busy) return;
  const result = computeRenamePlan();
  if (result.error || !result.changed) {
    updateRenamePreview();
    return;
  }

  const staged = [];
  try {
    for (let index = 0; index < result.selected.length; index += 1) {
      const item = result.selected[index];
      const plan = result.plans[index];
      const file = new File([item.file], plan.newName, {
        type: item.file.type || 'image/jpeg',
        lastModified: item.file.lastModified || Date.now(),
      });
      staged.push({ item, plan, file });
    }
  } catch (error) {
    console.error(error);
    showToast('无法生成新文件名，请换一个名称再试。', { type: 'error' });
    return;
  }

  const snapshot = result.selected.map((item) => ({
    item,
    file: item.file,
    name: item.name,
  }));

  for (const entry of staged) {
    entry.item.file = entry.file;
    entry.item.name = entry.plan.newName;
    updateAnalysisFileName(entry.item, entry.plan.newName);
  }

  closeRenameDialog();
  renderAll();
  showToast(`已修改 ${staged.length} 张照片的文件名。`, {
    actionLabel: '撤销',
    duration: 12000,
    onAction: () => {
      for (const entry of snapshot) {
        if (!state.items.includes(entry.item)) continue;
        entry.item.file = entry.file;
        entry.item.name = entry.name;
        updateAnalysisFileName(entry.item, entry.name);
      }
      renderAll();
      showToast('已恢复原来的文件名。');
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Watermark panel                                                             */
/* -------------------------------------------------------------------------- */

function makeLayerId() {
  layerCounter += 1;
  return `wm-${Date.now().toString(36)}-${layerCounter}`;
}

function ensureWatermarkLayers() {
  if (!Array.isArray(state.watermarkLayers) || !state.watermarkLayers.length) {
    state.watermarkLayers = [defaultLayer(makeLayerId)];
  }
  if (!state.watermarkLayers.some((layer) => layer.id === state.activeLayerId)) {
    state.activeLayerId = state.watermarkLayers[0].id;
  }
}

function currentLayer() {
  return (
    state.watermarkLayers.find((layer) => layer.id === state.activeLayerId) ||
    state.watermarkLayers[0] ||
    null
  );
}

function logosObject() {
  const logos = {};
  for (const [id, image] of state.logoImages) logos[id] = image;
  return logos;
}

function hasRenderableWatermark() {
  return hasVisibleWatermark(state.watermarkLayers, logosObject());
}

function renderPresetStrip() {
  els.presetStrip.innerHTML = WATERMARK_PRESETS.map((preset) => {
    const marks = preset.marks
      .map(
        (mark) =>
          `<span class="preset-mark pos-${mark.position} ${mark.strong ? 'is-strong' : ''} ${mark.small ? 'is-small' : ''} ${mark.accent ? 'is-accent' : ''} ${mark.tile ? 'is-tile' : ''}">${escapeHtml(mark.text)}</span>`,
      )
      .join('');
    return `
      <button class="preset-card" type="button" data-preset="${preset.id}" title="${escapeHtml(preset.hint)}">
        <span class="preset-thumb tone-${preset.tone}">
          ${marks}
          <span class="preset-layer-count">${preset.layers.length} 层</span>
        </span>
        <span class="preset-copy">
          <strong>${escapeHtml(preset.name)}</strong>
          <small>${escapeHtml(preset.hint)}</small>
        </span>
      </button>
    `;
  }).join('');
}

function layerSubtitle(layer) {
  if (layer.type === 'logo') {
    return state.logoImages.has(layer.id)
      ? '图片标识 · 已上传'
      : '图片标识 · 等待上传';
  }
  const text = String(layer.text || '').replace(/\s+/g, ' ').trim();
  return text ? `文字 · ${text}` : '文字 · 还没填写';
}

function renderLayerList() {
  const focusedAction = document.activeElement?.dataset?.layerAction;
  const focusedLayer = document.activeElement?.closest?.('.layer-row')?.dataset.layerId;
  const total = state.watermarkLayers.length;
  els.layerCount.textContent = String(total);
  els.layerList.innerHTML = state.watermarkLayers
    .map((layer, index) => {
      const active = layer.id === state.activeLayerId;
      const disabled = !layer.enabled;
      return `
        <div class="layer-row ${active ? 'is-active' : ''} ${disabled ? 'is-off' : ''}" data-layer-id="${escapeHtml(layer.id)}" role="listitem" aria-current="${active}">
          <button class="layer-main" type="button" data-layer-action="select" aria-label="编辑图层：${escapeHtml(layer.name)}">
            <span class="layer-kind">${icon(layer.type === 'logo' ? 'image' : 'text')}</span>
            <span class="layer-copy">
              <strong>${escapeHtml(layer.name)}</strong>
              <small>${escapeHtml(layerSubtitle(layer))}</small>
            </span>
          </button>
          <div class="layer-tools">
            <button class="layer-tool" type="button" data-layer-action="toggle" aria-pressed="${layer.enabled}" aria-label="${layer.enabled ? '隐藏' : '显示'}图层：${escapeHtml(layer.name)}" title="${layer.enabled ? '隐藏这个图层' : '显示这个图层'}">${icon(layer.enabled ? 'eye' : 'eye-off')}</button>
            <button class="layer-tool" type="button" data-layer-action="up" aria-label="上移图层：${escapeHtml(layer.name)}" title="向上移动" ${index === 0 ? 'disabled' : ''}>${icon('chevron-up')}</button>
            <button class="layer-tool" type="button" data-layer-action="down" aria-label="下移图层：${escapeHtml(layer.name)}" title="向下移动" ${index === total - 1 ? 'disabled' : ''}>${icon('chevron-down')}</button>
            <button class="layer-tool is-danger" type="button" data-layer-action="delete" aria-label="删除图层：${escapeHtml(layer.name)}" title="删除这个图层" ${total === 1 ? 'disabled' : ''}>${icon('trash')}</button>
          </div>
        </div>
      `;
    })
    .join('');
  if (focusedLayer && focusedAction) {
    requestAnimationFrame(() => {
      const row = $(`.layer-row[data-layer-id="${focusedLayer}"]`, els.layerList);
      row?.querySelector(`[data-layer-action="${focusedAction}"]`)?.focus({ preventScroll: true });
    });
  }
}

function selectWatermarkLayer(id) {
  if (!state.watermarkLayers.some((layer) => layer.id === id)) return;
  state.activeLayerId = id;
  syncWatermarkControls();
  schedulePreview();
  persistSettings();
}

function setLayerEnabled(id) {
  const layer = state.watermarkLayers.find((entry) => entry.id === id);
  if (!layer) return;
  layer.enabled = !layer.enabled;
  renderLayerList();
  onWatermarkEdited();
}

function moveWatermarkLayer(id, direction) {
  const index = state.watermarkLayers.findIndex((layer) => layer.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.watermarkLayers.length) return;
  const [layer] = state.watermarkLayers.splice(index, 1);
  state.watermarkLayers.splice(target, 0, layer);
  renderLayerList();
  onWatermarkEdited();
}

function handleLayerListClick(event) {
  const row = event.target.closest('.layer-row');
  if (!row) return;
  const id = row.dataset.layerId;
  const action = event.target.closest('[data-layer-action]')?.dataset.layerAction || 'select';
  if (action === 'select') selectWatermarkLayer(id);
  else if (action === 'toggle') setLayerEnabled(id);
  else if (action === 'up') moveWatermarkLayer(id, -1);
  else if (action === 'down') moveWatermarkLayer(id, 1);
  else if (action === 'delete') deleteWatermarkLayer(id);
}

function addWatermarkLayer() {
  const layer = defaultLayer(makeLayerId);
  layer.name = '新文字图层';
  layer.text = '你的水印';
  layer.margin = 4;
  state.watermarkLayers.unshift(layer);
  state.activeLayerId = layer.id;
  syncWatermarkControls();
  onWatermarkEdited();
}

function duplicateWatermarkLayer() {
  const active = currentLayer();
  if (!active) return;
  const copy = {
    ...active,
    id: makeLayerId(),
    name: `${active.name} 副本`.slice(0, 40),
    logoDataUrl: active.logoDataUrl,
  };
  if (state.logoImages.has(active.id)) {
    state.logoImages.set(copy.id, state.logoImages.get(active.id));
  }
  const activeIndex = state.watermarkLayers.findIndex((layer) => layer.id === active.id);
  state.watermarkLayers.splice(activeIndex + 1, 0, copy);
  state.activeLayerId = copy.id;
  syncWatermarkControls();
  onWatermarkEdited();
}

function deleteWatermarkLayer(id) {
  if (state.watermarkLayers.length <= 1) {
    showToast('至少保留一个图层；如果不想显示，可以直接隐藏它。');
    return;
  }
  const index = state.watermarkLayers.findIndex((layer) => layer.id === id);
  if (index < 0) return;
  const snapshot = snapshotWatermarkState();
  const [removed] = state.watermarkLayers.splice(index, 1);
  state.logoImages.delete(id);
  if (state.activeLayerId === id) {
    state.activeLayerId = state.watermarkLayers[Math.min(index, state.watermarkLayers.length - 1)].id;
  }
  syncWatermarkControls();
  onWatermarkEdited();
  showToast(`已删除图层「${removed.name}」`, {
    actionLabel: '撤销',
    onAction: () => restoreWatermarkState(snapshot),
  });
}

function snapshotWatermarkState() {
  return {
    layers: state.watermarkLayers.map((layer) => ({ ...layer })),
    logos: new Map(state.logoImages),
    activeLayerId: state.activeLayerId,
  };
}

function restoreWatermarkState(snapshot) {
  if (!snapshot) return;
  state.watermarkLayers = snapshot.layers.map((layer) => ({ ...layer }));
  state.logoImages = new Map(snapshot.logos);
  state.activeLayerId = state.watermarkLayers.some((layer) => layer.id === snapshot.activeLayerId)
    ? snapshot.activeLayerId
    : state.watermarkLayers[0]?.id || null;
  ensureWatermarkLayers();
  syncWatermarkControls();
  schedulePreview();
  persistSettings();
}

function applyWatermarkPreset(presetId) {
  const preset = findPreset(presetId);
  const snapshot = snapshotWatermarkState();
  state.watermarkLayers = presetLayers(presetId, makeLayerId);
  state.activeLayerId = state.watermarkLayers.reduce(
    (best, layer) => (layer.size > best.size ? layer : best),
    state.watermarkLayers[0],
  )?.id || null;
  state.logoImages = new Map();
  syncWatermarkControls();
  onWatermarkEdited();
  showToast(`已套用「${preset.name}」模板，可以继续改。`, {
    actionLabel: '撤销',
    onAction: () => restoreWatermarkState(snapshot),
    duration: 9000,
  });
}

function bindRange(input, output, property, format, decimals = 0, custom = null) {
  input.addEventListener('input', () => {
    const layer = currentLayer();
    if (!layer) return;
    const raw = Number(input.value);
    const value = Number.isInteger(decimals) && decimals === 0 && property ? Math.round(raw) : raw;
    if (property) layer[property] = value;
    if (custom) custom(raw, layer);
    output.textContent = format(raw);
    onWatermarkEdited();
  });
}

function syncWatermarkType() {
  const layer = currentLayer();
  const type = layer?.type || 'text';
  const isText = type === 'text';
  els.textWatermarkFields.hidden = !isText;
  els.logoWatermarkFields.hidden = isText;
  els.sizeRangeField.hidden = !isText;
  for (const button of $$('[data-type]', els.watermarkType)) {
    button.classList.toggle('is-active', button.dataset.type === type);
  }
  updateQualityVisibility();
}

function updateWatermarkPanel() {
  const targets = selectedItems();
  const count = targets.length;
  const layers = state.watermarkLayers;
  const enabled = layers.filter((layer) => layer.enabled);
  const hasContent = hasRenderableWatermark();
  const missingLogo = enabled.some(
    (layer) => layer.type === 'logo' && !state.logoImages.has(layer.id),
  );
  const disabled = state.busy || !count || !hasContent || missingLogo;
  let label = `为 ${count} 张照片加水印`;
  if (!count) label = '先勾选照片';
  else if (!layers.length) label = '先添加一个图层';
  else if (!enabled.length) label = '先打开一个图层';
  else if (missingLogo) label = '给图片图层上传 Logo';
  else if (!hasContent) label = '填写水印内容';
  els.applyWatermarkButton.disabled = disabled;
  els.applyWatermarkLabel.textContent = label;
  updateQualityVisibility();
  els.keepIccToggle.checked = state.keepIcc;
}

function updateQualityVisibility() {
  const targets = selectedItems();
  const allPng =
    targets.length > 0 &&
    targets.every((item) => (item.result?.blob || item.file).type === 'image/png');
  const pngOutput = state.outputFormat === 'png' || (state.outputFormat === 'auto' && allPng);
  els.qualityField.hidden = pngOutput;
  els.qualityRange.disabled = pngOutput;
}

function syncLogoUI(layer) {
  if (!layer) return;
  const hasLogo = Boolean(layer.logoDataUrl);
  els.logoPreviewWrap.hidden = !hasLogo;
  els.pickLogoButton.hidden = hasLogo;
  if (hasLogo) {
    if (els.logoPreview.getAttribute('src') !== layer.logoDataUrl) {
      els.logoPreview.src = layer.logoDataUrl;
    }
  } else {
    els.logoPreview.removeAttribute('src');
  }
}

function syncWatermarkControls() {
  ensureWatermarkLayers();
  const layer = currentLayer();
  if (!layer) return;
  els.activeLayerName.textContent = layer.name;
  els.watermarkText.value = layer.text;
  els.watermarkFont.value = layer.font;
  els.watermarkWeight.value = String(layer.weight);
  els.watermarkColor.value = layer.color;
  els.opacityRange.value = String(Math.round(layer.opacity * 100));
  els.opacityOutput.textContent = `${Math.round(layer.opacity * 100)}%`;
  els.sizeRange.value = String(layer.size);
  els.sizeOutput.textContent = `${layer.size.toFixed(1)}%`;
  els.marginRange.value = String(layer.margin);
  els.marginOutput.textContent = `${layer.margin.toFixed(1)}%`;
  els.rotationRange.value = String(layer.rotation);
  els.rotationOutput.textContent = `${Math.round(layer.rotation)}°`;
  els.logoScaleRange.value = String(layer.logoScale);
  els.logoScaleOutput.textContent = `${Math.round(layer.logoScale)}%`;
  els.tileToggle.checked = layer.tile;
  els.shadowToggle.checked = layer.shadow;
  els.keepIccToggle.checked = state.keepIcc;
  els.outputFormat.value = state.outputFormat;
  els.qualityRange.value = String(Math.round(state.quality * 100));
  els.qualityOutput.textContent = `${Math.round(state.quality * 100)}%`;
  syncColorSelection(layer.color);
  syncPositionSelection(layer.position);
  syncLogoUI(layer);
  syncWatermarkType();
  renderLayerList();
  updateWatermarkPanel();
}

function syncColorSelection(color) {
  for (const button of $$('[data-color]', els.colorSwatches)) {
    button.classList.toggle('is-active', button.dataset.color.toLowerCase() === color.toLowerCase());
  }
}

function syncPositionSelection(position) {
  for (const button of $$('[data-position]', els.positionGrid)) {
    const active = button.dataset.position === position;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function onWatermarkEdited() {
  const item = currentItem();
  if (state.activeTab === 'watermark' && state.previewView === 'result' && item) {
    state.previewView = 'original';
    updateStageMedia();
    syncCompareToggle();
    updateStageBadge(item);
    updateStageFoot(item, statusFor(item));
    updateStagePrivacy(item);
    updateDownloadButton();
  }
  const active = currentLayer();
  if (active) els.activeLayerName.textContent = active.name;
  renderLayerList();
  updateWatermarkPanel();
  schedulePreview();
  persistSettings();
}

async function handleLogoFile(file) {
  const layer = currentLayer();
  if (!layer) return;
  if (file.type && !file.type.startsWith('image/')) {
    showToast('请选择 PNG、WebP 或 SVG 图片。', { type: 'error' });
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('水印标识建议小于 5 MB。', { type: 'error' });
    return;
  }
  try {
    const dataUrl = await readFileAsDataURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.src = dataUrl;
    await image.decode();
    layer.type = 'logo';
    layer.logoDataUrl = dataUrl;
    if (layer.name === '文字图层' || layer.name === '新文字图层') layer.name = '图片标识';
    state.logoImages.set(layer.id, image);
    syncWatermarkType();
    syncLogoUI(layer);
    onWatermarkEdited();
  } catch (error) {
    console.error(error);
    showToast('无法读取这个标识文件。', { type: 'error' });
  }
}

function removeLogo() {
  const layer = currentLayer();
  if (!layer) return;
  layer.logoDataUrl = '';
  state.logoImages.delete(layer.id);
  syncLogoUI(layer);
  onWatermarkEdited();
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取已保存的标识'));
    image.src = dataUrl;
  });
}

async function restoreLayerLogos() {
  let changed = false;
  for (const layer of state.watermarkLayers) {
    if (layer.type !== 'logo' || !layer.logoDataUrl || state.logoImages.has(layer.id)) continue;
    try {
      const image = await loadImageFromDataUrl(layer.logoDataUrl);
      state.logoImages.set(layer.id, image);
      changed = true;
    } catch {
      layer.logoDataUrl = '';
      changed = true;
    }
  }
  if (!changed) return;
  renderLayerList();
  const active = currentLayer();
  if (active) syncLogoUI(active);
  updateWatermarkPanel();
  schedulePreview();
}

function schedulePreview() {
  if (previewFrame) cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0;
    drawWatermarkPreview();
  });
}

function drawWatermarkPreview() {
  const item = currentItem();
  const show =
    item &&
    state.activeTab === 'watermark' &&
    state.previewView !== 'result' &&
    !els.workspaceView.hidden;
  if (!show) {
    els.watermarkCanvas.hidden = true;
    els.previewTag.hidden = true;
    return;
  }
  const logos = logosObject();
  const hasContent = hasVisibleWatermark(state.watermarkLayers, logos);
  const rect = els.stageImage.getBoundingClientRect();
  if (!hasContent || !rect.width || !els.stageImage.naturalWidth) {
    els.watermarkCanvas.hidden = true;
    els.previewTag.hidden = true;
    return;
  }
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  els.watermarkCanvas.width = Math.max(1, Math.round(rect.width * ratio));
  els.watermarkCanvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = els.watermarkCanvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  drawWatermarks(context, rect.width, rect.height, state.watermarkLayers, logos);
  els.watermarkCanvas.hidden = false;
  els.previewTag.hidden = false;
}

function openGlossary() {
  if (!els.glossaryDialog.open) els.glossaryDialog.showModal();
}

function closeGlossary() {
  if (els.glossaryDialog.open) els.glossaryDialog.close();
}

function setupResizeObserver() {
  if (typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(() => {
    if (state.activeTab === 'watermark') schedulePreview();
  });
  observer.observe(els.stageImage);
  observer.observe(els.stageViewport);
}

/* -------------------------------------------------------------------------- */
/* Download                                                                    */
/* -------------------------------------------------------------------------- */

function downloadCurrent() {
  const item = currentItem();
  if (!item || state.busy) return;
  const useResult = state.previewView === 'result' && item.result;
  const blob = useResult ? item.result.blob : item.file;
  const name = useResult
    ? resultFileName(item, item.result)
    : sanitizeFileName(item.name, 'image.jpg');
  downloadBlob(blob, name);
  if (state.activeTab === 'watermark' && !useResult) {
    showToast('当前下载的是原图；应用水印后可下载效果图。');
  }
}

async function downloadZip() {
  if (state.busy) return;
  const targets = selectedItems();
  if (!targets.length) {
    showToast('请先勾选需要打包的图片。', { type: 'error' });
    return;
  }
  const entries = targets.map((item) => ({
    name: item.result ? resultFileName(item, item.result) : sanitizeFileName(item.name, 'image.jpg'),
    blob: item.result ? item.result.blob : item.file,
  }));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
  if (totalBytes > MAX_ZIP_BYTES) {
    showToast('待打包文件超过 450 MB，请减少勾选后分批下载。', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  beginJob({
    label: '正在打包 ZIP',
    detail: `0 / ${entries.length}`,
    cancellable: false,
  });
  try {
    const zip = await createZip(entries, {
      onProgress: (ratio, index, total) => {
        updateJob({
          label: '正在打包 ZIP',
          detail: `${index} / ${total} · ${formatBytes(totalBytes)}`,
          ratio,
        });
      },
    });
    updateJob({ label: '正在写入下载', detail: `${entries.length} 张照片`, ratio: 1 });
    downloadBlob(zip, suggestedZipName());
    const processed = targets.filter((item) => item.result).length;
    showToast(
      `已打包 ${entries.length} 张照片${processed ? `，其中 ${processed} 张为处理结果` : '（均为原图）'}。`,
    );
  } catch (error) {
    console.error(error);
    showToast(`打包失败：${error?.message || '未知错误'}`, { type: 'error', duration: 6000 });
  } finally {
    endJob();
  }
}

function resultFileName(item, result) {
  const base = item.name.replace(/\.[^.]+$/, '') || 'image';
  const suffix = result.hasWatermark ? '-watermark' : '-clean';
  return sanitizeFileName(`${base}${suffix}.${result.extension || extensionForMime(result.mime)}`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* -------------------------------------------------------------------------- */
/* Job and feedback                                                            */
/* -------------------------------------------------------------------------- */

function beginJob({ label, detail, cancellable }) {
  state.busy = true;
  state.job = { cancel: false, label };
  const job = state.job;
  els.jobToast.hidden = false;
  els.jobLabel.textContent = label;
  els.jobDetail.textContent = detail;
  els.jobBar.style.width = '0%';
  els.jobCancelButton.hidden = !cancellable;
  els.jobCancelButton.disabled = false;
  els.jobCancelButton.textContent = '取消';
  renderSelectionState();
  updateDownloadButton();
  els.removeButton.disabled = true;
  els.restoreButton.disabled = true;
  els.prevButton.disabled = true;
  els.nextButton.disabled = true;
  return job;
}

function updateJob({ label, detail, ratio }) {
  if (!state.job) return;
  if (label) {
    state.job.label = label;
    els.jobLabel.textContent = label;
  }
  if (detail) els.jobDetail.textContent = detail;
  if (Number.isFinite(ratio)) {
    els.jobBar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }
}

function endJob() {
  state.busy = false;
  state.job = null;
  els.jobToast.hidden = true;
  els.jobBar.style.width = '0%';
  renderSelectionState();
  const item = currentItem();
  if (item) {
    els.restoreButton.disabled = false;
    renderCurrent();
  }
  updateDownloadButton();
}

function cancelJob() {
  if (!state.job || els.jobCancelButton.hidden) return;
  state.job.cancel = true;
  els.jobCancelButton.disabled = true;
  els.jobLabel.textContent = '正在取消…';
  els.jobCancelButton.textContent = '稍候';
}

function showToast(message, options = {}) {
  const {
    type = 'success',
    actionLabel = '',
    onAction = null,
    duration = actionLabel ? 7000 : 3800,
  } = options;
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'is-error' : ''}`.trim();
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `
    <span class="toast-icon">${icon(type === 'error' ? 'alert' : 'check')}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    ${actionLabel ? `<button type="button" class="toast-action">${escapeHtml(actionLabel)}</button>` : ''}
  `;
  const close = () => {
    if (!toast.isConnected) return;
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 230);
  };
  const action = $('.toast-action', toast);
  if (action) {
    action.addEventListener('click', () => {
      close();
      onAction?.();
    });
  }
  if (actionLabel) {
    for (const existing of $$('.toast', els.toastRegion)) {
      if (existing.querySelector('.toast-action')) existing.remove();
    }
  }
  els.toastRegion.append(toast);
  let timer = setTimeout(close, duration);
  let remaining = duration;
  let startedAt = Date.now();
  toast.addEventListener('pointerenter', () => {
    clearTimeout(timer);
    remaining -= Date.now() - startedAt;
  });
  toast.addEventListener('pointerleave', () => {
    if (!toast.isConnected) return;
    startedAt = Date.now();
    timer = setTimeout(close, Math.max(1200, remaining));
  });
  while (els.toastRegion.children.length > 3) {
    els.toastRegion.firstElementChild?.remove();
  }
  return toast;
}

/* -------------------------------------------------------------------------- */
/* Settings and helpers                                                        */
/* -------------------------------------------------------------------------- */

function loadSettings() {
  try {
    const raw =
      localStorage.getItem('cleanframe.settings.v2') ||
      localStorage.getItem('cleanframe.settings.v1');
    if (!raw) return;
    const data = JSON.parse(raw);
    const savedLayers = Array.isArray(data.watermarkLayers)
      ? data.watermarkLayers
      : data.watermark
        ? [data.watermark]
        : [];
    const seen = new Set();
    state.watermarkLayers = savedLayers.map((saved, index) => {
      const source = saved && typeof saved === 'object' ? saved : {};
      let id = typeof source.id === 'string' && source.id ? source.id : makeLayerId();
      if (seen.has(id)) id = makeLayerId();
      seen.add(id);
      return normalizeLayer({ ...source, id }, index);
    });
    state.activeLayerId = state.watermarkLayers.some(
      (layer) => layer.id === data.activeLayerId,
    )
      ? data.activeLayerId
      : state.watermarkLayers[0]?.id || null;
    state.keepIcc = data.keepIcc !== false;
    state.outputFormat = ['auto', 'jpeg', 'png', 'webp'].includes(data.outputFormat)
      ? data.outputFormat
      : 'auto';
    state.quality = clamp(Number(data.quality) || 0.92, 0.6, 1);
  } catch {
    // Corrupt or unavailable storage is non-fatal.
  }
}

function persistSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const write = (includeLogos) => {
      localStorage.setItem(
        'cleanframe.settings.v2',
        JSON.stringify({
          watermarkLayers: state.watermarkLayers.map((layer) => ({
            ...layer,
            logoDataUrl: includeLogos ? layer.logoDataUrl : '',
          })),
          activeLayerId: state.activeLayerId,
          keepIcc: state.keepIcc,
          outputFormat: state.outputFormat,
          quality: state.quality,
        }),
      );
    };
    try {
      write(true);
    } catch {
      try {
        write(false);
      } catch {
        // Private browsing / file URLs may disallow storage.
      }
    }
  }, 250);
}

function statusFor(item) {
  if (item.processing) {
    return { label: '处理中…', short: '处理中', className: 'is-working', badgeClass: '' };
  }
  if (item.processError) {
    return {
      label: item.processError,
      short: '处理失败',
      className: 'is-error',
      badgeClass: 'is-error',
      title: item.processError,
    };
  }
  if (item.result?.hasWatermark) {
    return {
      label: item.result.cleaned ? '水印 · 已清' : '已加水印',
      short: '已加水印',
      className: 'is-watermark',
      badgeClass: 'is-watermark',
    };
  }
  if (item.result?.cleaned) {
    return { label: '已清理', short: '已清理', className: 'is-done', badgeClass: 'is-done' };
  }
  return { label: '原图', short: '原图', className: '', badgeClass: '' };
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('复制失败');
}
