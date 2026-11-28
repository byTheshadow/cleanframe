/**
 * Dev-only verification for the mini-tool. NOT shipped in the zip.
 *
 *   node dev/check.mjs
 *
 * Two jobs:
 *   1. Run the EXIF reader against the known-good fixtures from project/tests.
 *   2. Static-scan the runtime files for APIs that the mini-tool container
 *      forbids, plus syntax/CSS outside the Chrome 61 baseline.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * This folder is used from two layouts:
 *   starter:  cleanframe-xhs-starter/xhs-minitool/dev  -> ../project/tests/fixtures
 *   in-repo:  cleanframe/xhs-minitool/dev              -> ../tests/fixtures
 * Walk up and accept either so the checks run wherever the copy lives.
 */
function locateProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    dir = join(dir, '..');
    for (const candidate of [dir, join(dir, 'project')]) {
      if (existsSync(join(candidate, 'tests', 'fixtures'))) return candidate;
    }
  }
  return null;
}

const projectRoot = locateProjectRoot(here);
const fixtureDirs = projectRoot
  ? [join(projectRoot, 'tests', 'fixtures'), join(projectRoot, 'assets', 'samples')]
  : [];

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNear(actual, expected, tolerance, label) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ~${expected}, got ${actual}`);
  }
}

// Load the classic script in this realm so instanceof checks stay consistent.
function loadScript(relativePath, key) {
  const source = readFileSync(join(root, relativePath), 'utf8');
  const sandbox = {};
  // eslint-disable-next-line no-new-func
  new Function('window', source)(sandbox);
  assert(sandbox[key], `${relativePath} did not publish ${key}`);
  return sandbox[key];
}

const Exif = loadScript('assets/exif.js', 'CleanFrameExif');
const Render = loadScript('assets/render.js', 'CleanFrameRender');
const Watermark = loadScript('assets/watermark.js', 'CleanFrameWatermark');

function parseFixture(name) {
  const bytes = readFileSync(resolveFixture(name));
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return { record: Exif.parse(copy, copy.byteLength), bytes: copy };
}

function resolveFixture(name) {
  for (const dir of fixtureDirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`fixture not found: ${name}`);
}

function fieldValue(record, labelPart) {
  const hits = record.fields.filter((field) => field.label.indexOf(labelPart) !== -1);
  return hits.length ? hits.map((field) => field.value).join(' | ') : '';
}

// ------------------------------------------------------------ fixture cases

check('orientation-6.jpg reports orientation 6', () => {
  const { record } = parseFixture('orientation-6.jpg');
  assertEqual(record.format, 'jpeg', 'format');
  assertEqual(record.orientation, 6, 'orientation');
  assertEqual(record.displayWidth, record.height, 'displayWidth swaps');
  assert(record.orientationLabel.indexOf('90') !== -1, `label was ${record.orientationLabel}`);
});

check('sample-01.jpg exposes GPS, device, author, IPTC keyword', () => {
  const { record } = parseFixture('sample-01.jpg');
  assertEqual(record.format, 'jpeg', 'format');
  assertEqual(record.width, 1800, 'width');
  assertEqual(record.height, 1200, 'height');
  assert(record.hasExif, 'hasExif');
  assert(record.hasXmp, 'hasXmp');
  assert(record.hasIptc, 'hasIptc');
  assert(record.gps, 'gps present');
  assertNear(record.gps.latitude, 31.2401, 0.00001, 'latitude');
  assertNear(record.gps.longitude, 121.4904, 0.00001, 'longitude');
  assert(fieldValue(record, '相机型号').indexOf('X-T5') !== -1, `model was "${fieldValue(record, '相机型号')}"`);
  assert(fieldValue(record, '作者').indexOf('林屿') !== -1, `author was "${fieldValue(record, '作者')}"`);
  assert(fieldValue(record, '关键词').indexOf('外滩') !== -1, `keyword was "${fieldValue(record, '关键词')}"`);
  assert(record.risks.some((risk) => risk.id === 'gps'), 'gps risk');
  assert(record.risks.some((risk) => risk.id === 'serial'), 'serial risk');
});

check('metadata.png parses tEXt and iTXt', () => {
  const { record } = parseFixture('metadata.png');
  assertEqual(record.format, 'png', 'format');
  assertEqual(record.width, 720, 'width');
  assertEqual(record.height, 480, 'height');
  assert(record.hasExif, 'eXIf chunk seen');
  assert(fieldValue(record, '标题').indexOf('PNG 元数据测试') !== -1, `title was "${fieldValue(record, '标题')}"`);
  assert(fieldValue(record, '注释').indexOf('Unicode iTXt') !== -1, `comment was "${fieldValue(record, '注释')}"`);
});

check('metadata.webp parses EXIF and XMP', () => {
  const { record } = parseFixture('metadata.webp');
  assertEqual(record.format, 'webp', 'format');
  assertEqual(record.width, 720, 'width');
  assertEqual(record.height, 480, 'height');
  assert(record.hasXmp, 'hasXmp');
  assert(fieldValue(record, '作者（XMP）').indexOf('WebP Author') !== -1, `xmp author was "${fieldValue(record, '作者（XMP）')}"`);
});

check('neutralizeOrientation rewrites the tag without resizing the file', () => {
  const { bytes } = parseFixture('orientation-6.jpg');
  const result = Exif.neutralizeOrientation(bytes);
  assert(result.patched, `patch failed: ${result.reason}`);
  assertEqual(result.bytes.length, bytes.length, 'byte length preserved');
  const after = Exif.parse(result.bytes, result.bytes.length);
  assertEqual(after.orientation, 1, 'orientation after patch');
  assertEqual(after.width, 640, 'raw width still readable');
  assertEqual(after.height, 480, 'raw height still readable');
  // The patched copy is deliberately un-rotated, so display dims follow raw dims.
  assertEqual(after.displayWidth, 640, 'patched record reports raw geometry');
});

check('neutralizeOrientation leaves the original buffer untouched', () => {
  const { bytes } = parseFixture('orientation-6.jpg');
  const before = Exif.parse(bytes, bytes.length).orientation;
  Exif.neutralizeOrientation(bytes);
  const after = Exif.parse(bytes, bytes.length).orientation;
  assertEqual(after, before, 'source buffer mutated');
});

check('non-JPEG input is reported, not thrown', () => {
  const { bytes } = parseFixture('metadata.png');
  const result = Exif.neutralizeOrientation(bytes);
  assertEqual(result.patched, false, 'patched');
  assertEqual(result.reason, 'not-jpeg', 'reason');
});

// ------------------------------------------------------- framing geometry

check('portrait 3:4 source fills the frame exactly', () => {
  const plan = Render.framePlan(1080, 1440, 1, 1080, 1440);
  assertEqual(plan.scale, 1, 'scale');
  assertEqual(plan.offsetX, 0, 'offsetX');
  assertEqual(plan.offsetY, 0, 'offsetY');
});

check('rotated raw landscape becomes a filling portrait frame', () => {
  // orientation-6.jpg is a 640x480 sensor frame that displays as 480x640.
  const plan = Render.framePlan(640, 480, 6, 1080, 1440);
  assertEqual(plan.orientedWidth, 480, 'orientedWidth');
  assertEqual(plan.orientedHeight, 640, 'orientedHeight');
  assertEqual(plan.scale, 2.25, 'scale');
  assertEqual(plan.offsetX, 0, 'offsetX');
  assertEqual(plan.offsetY, 0, 'offsetY');
});

check('landscape source is cropped on the sides, not letterboxed', () => {
  const plan = Render.framePlan(1800, 1200, 1, 1080, 1440);
  assertEqual(plan.orientedWidth, 1800, 'orientedWidth');
  assertEqual(plan.scale, 1.2, 'scale');
  assertEqual(plan.drawnWidth, 2160, 'drawnWidth');
  assertEqual(plan.drawnHeight, 1440, 'drawnHeight');
  assertEqual(plan.offsetX, -540, 'offsetX centres the crop');
  assertEqual(plan.offsetY, 0, 'offsetY');
});

check('orientation 3 keeps geometry, orientation 8 swaps it', () => {
  const flipped = Render.framePlan(640, 480, 3, 1080, 1440);
  assertEqual(flipped.orientedWidth, 640, 'orientation 3 width');
  const mirrored = Render.framePlan(640, 480, 8, 1080, 1440);
  assertEqual(mirrored.orientedWidth, 480, 'orientation 8 width');
  assertEqual(mirrored.orientedHeight, 640, 'orientation 8 height');
});

check('every orientation matrix is accepted by a drawing context', () => {
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const calls = [];
    const ctx = {
      transform: (...args) => calls.push(args),
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      rect: () => {},
      clip: () => {},
      translate: () => {},
      scale: () => {},
      drawImage: () => {},
      fillRect: () => {},
      set imageSmoothingEnabled(value) {},
      set imageSmoothingQuality(value) {},
    };
    Render.drawFramed(ctx, { naturalWidth: 640, naturalHeight: 480 }, orientation, 1080, 1440);
    if (orientation > 1) assertEqual(calls.length, 1, `orientation ${orientation} applied one matrix`);
  }
});

// ------------------------------------------------------------- watermark

check('template list covers the MVP set', () => {
  const ids = Watermark.TEMPLATES.map((template) => template.id);
  for (const required of ['none', 'handle', 'minimal', 'travel', 'shop']) {
    assert(ids.indexOf(required) !== -1, `missing template ${required}`);
  }
});

check('normalize rejects unknown position and colour', () => {
  const config = Watermark.normalize({ template: 'handle', primary: 'x', position: 'middle-center', color: 'lime' });
  assertEqual(config.position, 'bottom-right', 'position fallback');
  assertEqual(config.color, 'auto', 'colour fallback');
  assertEqual(config.enabled, true, 'enabled');
});

check('empty text produces no layer', () => {
  const config = Watermark.normalize({ template: 'handle', primary: '   ' });
  assertEqual(Watermark.buildLayers(config).length, 0, 'blank primary should not draw');
});

check('the none template draws nothing', () => {
  const config = Watermark.normalize({ template: 'none', primary: 'anything' });
  assertEqual(config.enabled, false, 'enabled');
  assertEqual(Watermark.buildLayers(config).length, 0, 'layers');
});

check('primary follows the chosen corner, secondary keeps its own', () => {
  const config = Watermark.normalize({
    template: 'travel',
    primary: '上海 · 外滩',
    secondary: '2026.11.27',
    position: 'top-left',
  });
  const layers = Watermark.buildLayers(config);
  assertEqual(layers.length, 2, 'layer count');
  assertEqual(layers[0].position, 'top-left', 'primary follows the user');
  assertEqual(layers[1].position, 'bottom-right', 'secondary stays put');
  assertEqual(layers[1].text, '2026.11.27', 'secondary text');
});

check('text is clamped and whitespace collapsed', () => {
  const long = 'x'.repeat(60);
  const config = Watermark.normalize({ template: 'handle', primary: `  a   b  ${long}` });
  assert(config.primary.length <= 28, `length was ${config.primary.length}`);
  const layers = Watermark.buildLayers(config);
  assertEqual(layers[0].text, config.primary.replace(/\s+/g, ' ').replace(/^ | $/g, ''), 'collapsed');
});

check('every template builds drawable layers with text', () => {
  for (const template of Watermark.TEMPLATES) {
    if (template.id === 'none') continue;
    const config = Watermark.normalize({
      template: template.id,
      primary: '主文字',
      secondary: '副文字',
    });
    const layers = Watermark.buildLayers(config);
    assertEqual(layers.length, template.layers.length, `${template.id} layer count`);
    for (const layer of layers) {
      assert(layer.size > 0 && layer.size < 20, `${template.id} size`);
      assert(layer.opacity > 0 && layer.opacity <= 1, `${template.id} opacity`);
      assert(layer.font.indexOf('sans') !== -1 || layer.font.indexOf('mono') !== -1, `${template.id} font`);
    }
  }
});

check('watermark drawing is safe on an unreadable canvas', () => {
  // Mimics a tainted canvas: getImageData throws.
  const calls = [];
  const context = {
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    measureText: (text) => ({ width: text.length * 10 }),
    save: () => {},
    restore: () => {},
    fillText: (text) => calls.push(text),
    getImageData: () => {
      throw new Error('SecurityError');
    },
  };
  const painted = Watermark.draw(context, 1080, 1440, { template: 'handle', primary: '@净帧' });
  assertEqual(painted, 1, 'one layer');
  assertEqual(calls.length, 1, 'text still drawn');
  assertEqual(calls[0], '@净帧', 'text content');
});

check('dark ink is chosen over a bright background', () => {
  const fills = [];
  const context = {
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    measureText: () => ({ width: 100 }),
    save: () => {},
    restore: () => {},
    fillText: () => fills.push(context.fillStyle),
    getImageData: (x, y, w, h) => ({ data: new Uint8Array(w * h * 4).fill(250) }),
  };
  Watermark.draw(context, 1080, 1440, { template: 'handle', primary: 'x', color: 'auto' });
  assertEqual(fills[0], '#16171a', 'dark ink on bright pixels');
});

check('light ink is chosen over a dark background', () => {
  const fills = [];
  const context = {
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    measureText: () => ({ width: 100 }),
    save: () => {},
    restore: () => {},
    fillText: () => fills.push(context.fillStyle),
    getImageData: (x, y, w, h) => ({ data: new Uint8Array(w * h * 4).fill(12) }),
  };
  Watermark.draw(context, 1080, 1440, { template: 'handle', primary: 'x', color: 'auto' });
  assertEqual(fills[0], '#ffffff', 'white ink on dark pixels');
});

// --------------------------------------------------------- static compliance

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (entry === 'dev') continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const allRuntimeFiles = walk(root);
const runtimeFiles = allRuntimeFiles.filter((file) => /\.(html|js|css)$/.test(file));

check('zip root has index.html and no dev-only files', () => {
  assert(existsSync(join(root, 'index.html')), 'index.html missing from the zip root');
  const devLeaks = allRuntimeFiles.filter((file) => /[\\/]dev[\\/]/.test(file));
  assertEqual(devLeaks.length, 0, 'dev files inside runtime');
});

check('runtime payload stays inside the zip budget', () => {
  let total = 0;
  for (const file of allRuntimeFiles) total += statSync(file).size;
  const budget = 2 * 1024 * 1024;
  assert(total <= budget, `runtime bytes ${total} exceeds the ${budget} byte target`);
  console.log(`    runtime payload: ${(total / 1024).toFixed(1)} KB across ${allRuntimeFiles.length} files`);
});

const forbidden = [
  ['ES module script tag', /type\s*=\s*["']module["']/],
  ['static import', /(^|\n)\s*import\s+[\w{*]/],
  ['import()', /\bimport\s*\(/],
  ['export statement', /(^|\n)\s*export\s+(default|const|let|var|function|class|\{)/],
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['clipboard API', /navigator\s*\.\s*clipboard/],
  ['execCommand', /\bexecCommand\s*\(/],
  ['anchor download', /\.download\s*=|download\s*=\s*["']/],
  ['window.open', /window\s*\.\s*open\s*\(/],
  ['target=_blank', /target\s*=\s*["']_blank["']/],
  ['<dialog>', /<dialog\b/i],
  ['showModal', /\bshowModal\s*\(/],
  ['eval', /(^|[^.\w])eval\s*\(/],
  ['new Function', /new\s+Function\s*\(/],
  ['WebAssembly', /\bWebAssembly\b/],
  ['Worker', /\bnew\s+Worker\s*\(/],
  ['serviceWorker', /\bserviceWorker\b/],
  ['createImageBitmap', /\bcreateImageBitmap\b/],
  ['DecompressionStream', /\bDecompressionStream\b/],
  ['Blob.arrayBuffer', /\.\s*arrayBuffer\s*\(\s*\)\s*\.then|await[^;]*\.\s*arrayBuffer\s*\(\s*\)/],
  ['String.replaceAll', /\.replaceAll\s*\(/],
  ['optional chaining', /\?\.[A-Za-z_$[(]/],
  ['nullish coalescing', /\?\?[^?]/],
  ['inline handler attribute', /\son(click|change|input|load|error|touchstart)\s*=/i],
  ['XMLHttpRequest fallback', /\bActiveXObject\b/],
  ['remote URL reference', /(https?:)?\/\/(cdn|unpkg|jsdelivr|fonts\.googleapis)/i],
];

const cssForbidden = [
  ['flex gap (needs margin fallback)', /display\s*:\s*flex[^}]*?[\s;]gap\s*:/i],
  ['inset shorthand', /(^|[;{\s])inset\s*:/i],
  ['clamp()', /\bclamp\s*\(/],
  ['aspect-ratio', /aspect-ratio\s*:/i],
  ['backdrop-filter', /backdrop-filter\s*:/i],
  ['focus-visible only', /:focus-visible/],
];

check('runtime files contain no container-forbidden API', () => {
  const hits = [];
  for (const file of runtimeFiles) {
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of forbidden) {
      const match = pattern.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        hits.push(`${relative(root, file)}:${line} ${label}`);
      }
    }
  }
  assert(hits.length === 0, `\n  ${hits.join('\n  ')}`);
});

check('runtime CSS stays inside the Chrome 61 baseline', () => {
  const hits = [];
  for (const file of runtimeFiles.filter((f) => f.endsWith('.css'))) {
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of cssForbidden) {
      const match = pattern.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        hits.push(`${relative(root, file)}:${line} ${label}`);
      }
    }
  }
  assert(hits.length === 0, `\n  ${hits.join('\n  ')}`);
});

check('index.html loads no inline script and lists scripts in dependency order', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  assert(scripts.length > 0, 'no script tags');
  for (const [, attrs] of scripts) {
    assert(/src\s*=/.test(attrs), `inline script found: ${attrs}`);
  }
  const order = scripts.map(([, attrs]) => (/src\s*=\s*["']([^"']+)/.exec(attrs) || [])[1]);
  const before = (name) => {
    const at = order.findIndex((src) => new RegExp(`${name}$`).test(src));
    assert(at !== -1, `${name} is not loaded`);
    return at;
  };
  const appAt = before('app\\.js');
  for (const engine of ['exif', 'render', 'watermark']) {
    const engineAt = before(`${engine}\\.js`);
    assert(engineAt < appAt, `${engine}.js must load before app.js`);
  }
});

// ------------------------------------------------------------------- report

const total = passed + failures.length;
console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) {
    console.log(`  x ${failure.name}`);
    console.log(`    ${failure.message.replace(/\n/g, '\n    ')}`);
  }
  process.exitCode = 1;
} else {
  console.log('OK');
}
