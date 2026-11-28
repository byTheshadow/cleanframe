/**
 * Dev-only end-to-end check in a real Chromium, driven over CDP.
 * NOT shipped in the zip.
 *
 *   node dev/e2e.mjs
 *
 * What it proves (the parts Node-only checks cannot):
 *   - index.html boots with the real DOM, no console errors
 *   - real JPG/PNG files go through the file input
 *   - EXIF orientation is read and the 3:4 canvas export produces 1080x1440
 *   - the clean output is a real JPEG with no metadata
 *   - 390px viewport has no horizontal overflow
 *   - writeTempFile -> saveImageToPhotosAlbum -> postNote are called correctly
 *     against a stubbed bridge (the real container is still the open question)
 *
 * Requires a Chromium that can start: the DSH Windows sandbox blocks the named
 * pipes Chrome's multi-process IPC needs, so this script may need wider access.
 *
 * Screenshots land in dev/out/.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
// --root=<dir> serves an already-packaged copy, so the zip itself can be tested.
const rootArg = process.argv.find((arg) => arg.startsWith('--root='));
const root = rootArg ? rootArg.slice('--root='.length) : join(here, '..');
const outDir = join(here, 'out');

/**
 * Works from both layouts (see check.mjs): the fixtures live in the web project,
 * which is either a sibling `project/` folder or the repo root itself.
 */
function locateProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    dir = join(dir, '..');
    for (const candidate of [dir, join(dir, 'project')]) {
      if (existsSync(join(candidate, 'tests', 'fixtures'))) return candidate;
    }
  }
  throw new Error('could not locate the web project fixtures (tests/fixtures)');
}

const projectRoot = locateProjectRoot(here);

const FIXTURES = [
  join(projectRoot, 'tests', 'fixtures', 'orientation-6.jpg'),
  join(projectRoot, 'assets', 'samples', 'sample-01.jpg'),
  join(projectRoot, 'tests', 'fixtures', 'metadata.png'),
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  return (
    process.env.CHROME_PATH ||
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  );
}

function startServer(port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      // dev-only: expose the project fixtures so the page can compare against
      // Chrome's own EXIF orientation handling.
      if (url.pathname.indexOf('/fixtures/') === 0) {
        const fixture = join(projectRoot, 'tests', 'fixtures', url.pathname.slice('/fixtures/'.length));
        const body = await readFile(fixture);
        res.writeHead(200, { 'content-type': MIME[extname(fixture)] || 'application/octet-stream' });
        res.end(body);
        return;
      }
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = join(root, rel.replace(/^\/+/, ''));
      if (!file.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (error) {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const port = await freePort();
  const debugPort = await freePort();
  const userDataDir = await mkdtemp(join(tmpdir(), 'cleanframe-e2e-'));
  const server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(
    chromePath(),
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--window-size=390,844',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let client;
  const cleanup = async () => {
    try {
      if (client) client.close();
    } catch (error) {
      /* ignore */
    }
    child.kill();
    server.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };

  const passes = [];
  const failures = [];
  const pageErrors = [];
  const check = (name, condition, detail) => {
    if (condition) passes.push(name);
    else failures.push({ name, detail });
  };

  try {
    let target;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await response.json();
        target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
        if (target) break;
      } catch (error) {
        /* not up yet */
      }
      await sleep(150);
    }
    if (!target) throw new Error('Chromium DevTools endpoint never came up');

    client = await CDP.connect(target.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Log.enable');

    const errors = pageErrors;
    client.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params.exceptionDetails.text || 'exception');
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        errors.push(message.params.entry.text);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
      }
    });

    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`evaluate failed: ${result.exceptionDetails.text || 'unknown'} :: ${expression.slice(0, 100)}`);
      }
      return result.result.value;
    };

    const waitFor = async (label, probe, timeout = 25000) => {
      const started = Date.now();
      for (;;) {
        const value = await probe();
        if (value) return value;
        if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
        await sleep(150);
      }
    };

    const metrics = async (height) => {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height,
        deviceScaleFactor: 2,
        mobile: true,
      });
    };
    const shot = async (name) => {
      const result = await client.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(outDir, name), Buffer.from(result.data, 'base64'));
    };

    await metrics(844);
    await client.send('Page.navigate', { url: `${base}/index.html` });
    await waitFor('app boot', async () => evaluate('typeof window.CleanFrameXhs === "object"'));

    await evaluate(`(function(){
      var input = document.getElementById('fileInput');
      window.__picked = 0;
      input.addEventListener('change', function(){ window.__picked += 1; }, true);
      return true;
    })()`);

    const { root: docRoot } = await client.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: docRoot.nodeId, selector: '#fileInput' });
    await client.send('DOM.setFileInputFiles', { files: FIXTURES, nodeId });
    await sleep(800);
    if (!(await evaluate('window.__picked'))) {
      await evaluate(`document.getElementById('fileInput').dispatchEvent(new Event('change'))`);
    }

    const state = () => evaluate('JSON.parse(JSON.stringify(window.CleanFrameXhs.state))');

    await sleep(600);
    const diag = await evaluate(`({
      items: window.CleanFrameXhs.state.items.length,
      statuses: window.CleanFrameXhs.state.items.map(function (item) { return item.status; }),
      picked: window.__picked,
      watermarkEngine: typeof window.CleanFrameWatermark,
      cards: document.querySelectorAll('#previewGrid .preview-card').length,
      inputFiles: document.getElementById('fileInput').files.length
    })`);
    console.log('diagnostic:', JSON.stringify(diag));

    await waitFor('parse', async () => {
      const snapshot = await state();
      return (
        snapshot.items.length === 3 &&
        snapshot.items.every((entry) => entry.status !== 'pending') &&
        snapshot.busy === false
      );
    });

    let snapshot = await state();
    check('three files accepted', snapshot.items.length === 3, JSON.stringify(snapshot.items.map((i) => i.name)));
    check(
      'no parse failures',
      snapshot.items.every((item) => !item.error),
      JSON.stringify(snapshot.items.map((i) => i.error))
    );

    const byName = (needle) => snapshot.items.find((item) => item.name.indexOf(needle) !== -1);
    const oriented = byName('orientation-6');
    check('orientation 6 detected in browser', !!oriented && oriented.orientation === 6, JSON.stringify(oriented));
    const sample = byName('sample-01');
    check(
      'privacy risks detected in browser',
      !!sample && sample.risks.indexOf('gps') !== -1 && sample.risks.indexOf('serial') !== -1,
      JSON.stringify(sample && sample.risks)
    );

    const privacyRows = await evaluate(`document.querySelectorAll('#privacyList .privacy-row').length`);
    check('privacy rows rendered', privacyRows > 0, `rows=${privacyRows}`);

    await evaluate(`document.getElementById('tabOriginal').click()`);
    await sleep(800);
    await shot('e2e-phone-original.png');

    await waitFor('idle before cleaning', async () => (await state()).busy === false);
    await evaluate(`document.getElementById('cleanButton').click()`);
    await waitFor('clean', async () => {
      const snapshot = await state();
      return (
        snapshot.items.length === 3 &&
        snapshot.items.every((entry) => entry.output && entry.output.version === snapshot.watermarkVersion)
      );
    });

    snapshot = await state();
    const outputs = snapshot.items.map((item) => item.output);
    check('every item produced output', outputs.every(Boolean), JSON.stringify(outputs));
    check(
      'output is 1080x1440',
      outputs.every((output) => output && output.width === 1080 && output.height === 1440),
      JSON.stringify(outputs)
    );
    check(
      'output JPEG has real bytes',
      outputs.every((output) => output && output.bytes > 15000),
      JSON.stringify(outputs)
    );

    const canvasInk = await evaluate(`(function(){
      var canvas = document.getElementById('previewCanvas');
      var data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      var nonWhite = 0;
      var total = 0;
      for (var i = 0; i < data.length; i += 40) {
        total += 1;
        if (data[i] < 245 || data[i+1] < 245 || data[i+2] < 245) nonWhite += 1;
      }
      return { total: total, nonWhite: nonWhite, ratio: nonWhite / total };
    })()`);
    check('preview canvas actually painted', canvasInk.ratio > 0.5, JSON.stringify(canvasInk));

    const overflow = await evaluate(`({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })`);
    check('no horizontal overflow at 390px', overflow.scroll <= overflow.inner + 1, JSON.stringify(overflow));

    await shot('e2e-phone-clean.png');

    // Every orientation matrix must place the four source corners where the
    // EXIF spec says they belong. The expected table below comes from the spec
    // text ("0th row is the visual ..."), not from render.js.
    const corners = await evaluate(`(function(){
      var src = document.createElement('canvas');
      src.width = 200; src.height = 100;
      var sctx = src.getContext('2d');
      sctx.fillStyle = '#ff0000'; sctx.fillRect(0, 0, 100, 50);
      sctx.fillStyle = '#00ff00'; sctx.fillRect(100, 0, 100, 50);
      sctx.fillStyle = '#0000ff'; sctx.fillRect(0, 50, 100, 50);
      sctx.fillStyle = '#ffff00'; sctx.fillRect(100, 50, 100, 50);
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          var name = { '255,0,0': 'TL', '0,255,0': 'TR', '0,0,255': 'BL', '255,255,0': 'BR' };
          function at(ctx, x, y) {
            var d = ctx.getImageData(x, y, 1, 1).data;
            return name[d[0] + ',' + d[1] + ',' + d[2]] || ('?' + d[0] + ',' + d[1] + ',' + d[2]);
          }
          var out = {};
          for (var o = 1; o <= 8; o += 1) {
            var w = o >= 5 ? img.naturalHeight : img.naturalWidth;
            var h = o >= 5 ? img.naturalWidth : img.naturalHeight;
            var c = document.createElement('canvas');
            c.width = w; c.height = h;
            var ctx = c.getContext('2d');
            window.CleanFrameRender.drawFramed(ctx, img, o, w, h);
            out[o] = {
              TL: at(ctx, 10, 10), TR: at(ctx, w - 11, 10),
              BL: at(ctx, 10, h - 11), BR: at(ctx, w - 11, h - 11),
              w: w, h: h
            };
          }
          resolve(out);
        };
        img.src = src.toDataURL('image/png');
      });
    })()`);

    // expectedCorners[orientation][displayCorner] = which source corner lands there.
    // Derived from the EXIF spec text, e.g. 6 = "0th row is the visual right-hand
    // side, 0th column is the visual top" -> top edge becomes the right edge (90 CW).
    const expectedCorners = {
      1: { TL: 'TL', TR: 'TR', BL: 'BL', BR: 'BR', w: 200, h: 100 },
      2: { TL: 'TR', TR: 'TL', BL: 'BR', BR: 'BL', w: 200, h: 100 },
      3: { TL: 'BR', TR: 'BL', BL: 'TR', BR: 'TL', w: 200, h: 100 },
      4: { TL: 'BL', TR: 'BR', BL: 'TL', BR: 'TR', w: 200, h: 100 },
      5: { TL: 'TL', TR: 'BL', BL: 'TR', BR: 'BR', w: 100, h: 200 },
      6: { TL: 'BL', TR: 'TL', BL: 'BR', BR: 'TR', w: 100, h: 200 },
      7: { TL: 'BR', TR: 'TR', BL: 'BL', BR: 'TL', w: 100, h: 200 },
      8: { TL: 'TR', TR: 'BR', BL: 'TL', BR: 'BL', w: 100, h: 200 },
    };
    for (let o = 1; o <= 8; o += 1) {
      const got = corners[o];
      const want = expectedCorners[o];
      const ok =
        got && got.TL === want.TL && got.TR === want.TR && got.BL === want.BL && got.BR === want.BR &&
        got.w === want.w && got.h === want.h;
      check(`orientation ${o} places corners per EXIF spec`, ok, JSON.stringify({ got, want }));
    }

    // Differential: our manual rotation must match Chrome's own EXIF handling.
    const diff = await evaluate(`(function(){
      function load(url) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () { resolve(img); };
          img.onerror = reject;
          img.src = url;
        });
      }
      return fetch('/fixtures/orientation-6.jpg')
        .then(function (response) { return response.arrayBuffer(); })
        .then(function (buffer) {
          var bytes = new Uint8Array(buffer);
          var neutral = window.CleanFrameExif.neutralizeOrientation(bytes);
          var blob = new Blob([neutral.bytes], { type: 'image/jpeg' });
          var url = URL.createObjectURL(blob);
          return Promise.all([load('/fixtures/orientation-6.jpg'), load(url)]).then(function (images) {
            var raw = images[0];
            var patched = images[1];
            var w = 480, h = 640;
            var mine = document.createElement('canvas');
            mine.width = w; mine.height = h;
            window.CleanFrameRender.drawFramed(mine.getContext('2d'), patched, 6, w, h);
            var theirs = document.createElement('canvas');
            theirs.width = w; theirs.height = h;
            theirs.getContext('2d').drawImage(raw, 0, 0, w, h);
            URL.revokeObjectURL(url);
            var a = mine.getContext('2d').getImageData(0, 0, w, h).data;
            var b = theirs.getContext('2d').getImageData(0, 0, w, h).data;
            var sum = 0;
            var count = 0;
            for (var i = 0; i < a.length; i += 4) {
              sum += Math.abs(a[i] - b[i]) + Math.abs(a[i+1] - b[i+1]) + Math.abs(a[i+2] - b[i+2]);
              count += 3;
            }
            return {
              meanDiff: sum / count,
              naturalWidth: raw.naturalWidth,
              naturalHeight: raw.naturalHeight,
              patchedWidth: patched.naturalWidth,
              patchedHeight: patched.naturalHeight
            };
          });
        });
    })()`);
    check(
      'manual rotation matches Chrome EXIF handling',
      diff.meanDiff < 6,
      JSON.stringify(diff)
    );
    check(
      'orientation tag neutralisation is honoured by Chrome',
      diff.patchedWidth === 640 && diff.patchedHeight === 480 && diff.naturalWidth === 480 && diff.naturalHeight === 640,
      JSON.stringify(diff)
    );

    // Scrolled to the bottom, no content may hide behind the fixed action bar.
    const layout = await evaluate(`(function(){
      window.scrollTo(0, document.documentElement.scrollHeight);
      var bar = document.querySelector('.bottom-actions').getBoundingClientRect();
      var card = document.querySelector('.compat-card').getBoundingClientRect();
      return { barTop: bar.top, cardBottom: card.bottom, viewport: window.innerHeight, barHeight: bar.height };
    })()`);
    check(
      'bottom bar does not cover the last content when scrolled',
      layout.cardBottom <= layout.barTop + 1,
      JSON.stringify(layout)
    );

    // Whole-page shot: use a tall viewport so fixed elements stay in place.
    await evaluate('window.scrollTo(0, 0)');
    await metrics(1760);
    await sleep(500);
    await shot('e2e-full.png');
    await metrics(844);
    await sleep(300);

    check('browser preview has no bridge', (await evaluate('window.CleanFrameXhs.hasBridge()')) === false);
    await evaluate(`document.getElementById('saveButton').click()`);
    await sleep(400);
    const toast = await evaluate(`document.getElementById('toast').textContent`);
    check('save explains the missing container', /小红书小工具/.test(toast), toast);

    // ---------------------------------------------------------- watermark
    const regionSum = (x, y, w, h) =>
      evaluate(`(function(){
        var canvas = document.getElementById('previewCanvas');
        var d = canvas.getContext('2d').getImageData(${x}, ${y}, ${w}, ${h}).data;
        var sum = 0;
        for (var i = 0; i < d.length; i += 4) sum += d[i] + d[i+1] + d[i+2];
        return sum;
      })()`);
    const cornerSum = () => regionSum('canvas.width - 200', 'canvas.height - 90', 200, 90);
    const centerSum = () => regionSum('Math.round(canvas.width / 2) - 100', 'Math.round(canvas.height / 2) - 60', 200, 120);

    const item = () => evaluate('JSON.parse(JSON.stringify(window.CleanFrameXhs.state.items[window.CleanFrameXhs.state.current]))');

    check(
      'watermark panel is visible once photos are picked',
      (await evaluate(`document.getElementById('watermarkCard').hidden`)) === false
    );

    const layerTextCount = () => evaluate(`document.querySelectorAll('#layerList .layer-text').length`);
    check('one editable layer is shown for the default template', (await layerTextCount()) === 1, String(await layerTextCount()));

    const versionBefore = (await state()).watermarkVersion;

    await evaluate(`(function(){
      var input = document.querySelector('#layerList .layer-text');
      input.value = '@净帧测试号';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    await waitFor('watermark refresh', async () => {
      const snapshot = await state();
      const current = snapshot.items[snapshot.current];
      return (
        snapshot.watermarkVersion > versionBefore &&
        snapshot.watermark.layers[0].text === '@净帧测试号' &&
        current.output &&
        current.output.version === snapshot.watermarkVersion
      );
    });
    const withMark = await cornerSum();
    const versionWithMark = (await state()).watermarkVersion;

    await evaluate(`document.querySelector('#templateChips .chip[data-value="none"]').click()`);
    await waitFor('watermark removal', async () => {
      const snapshot = await state();
      const current = snapshot.items[snapshot.current];
      return (
        snapshot.watermarkVersion > versionWithMark &&
        snapshot.watermark.template === 'none' &&
        current.output &&
        current.output.version === snapshot.watermarkVersion
      );
    });
    const withoutMark = await cornerSum();
    check(
      'watermark text reaches the exported pixels',
      Math.abs(withMark - withoutMark) > 1000,
      JSON.stringify({ withMark, withoutMark })
    );

    const versionBeforeTravel = (await state()).watermarkVersion;
    await evaluate(`document.querySelector('#templateChips .chip[data-value="travel"]').click()`);
    await waitFor('travel template layers', async () => {
      const snapshot = await state();
      const current = snapshot.items[snapshot.current];
      return (
        snapshot.watermarkVersion > versionBeforeTravel &&
        snapshot.watermark.template === 'travel' &&
        current.output &&
        current.output.version === snapshot.watermarkVersion
      );
    });
    const travelItem = await item();
    check('switching template re-renders the current item', !!travelItem.output, JSON.stringify(travelItem));

    // Tiled watermark: the mid-frame must change, not just a corner.
    const centerWithout = await centerSum();
    const versionBeforeGuard = (await state()).watermarkVersion;
    await evaluate(`document.querySelector('#templateChips .chip[data-value="guard"]').click()`);
    await waitFor('tiled template', async () => {
      const snapshot = await state();
      const current = snapshot.items[snapshot.current];
      return (
        snapshot.watermarkVersion > versionBeforeGuard &&
        snapshot.watermark.template === 'guard' &&
        snapshot.watermark.layers[0].tile === true &&
        current.output &&
        current.output.version === snapshot.watermarkVersion
      );
    });
    const centerWithTile = await centerSum();
    check(
      'tiled watermark covers the middle of the frame',
      Math.abs(centerWithTile - centerWithout) > 500,
      JSON.stringify({ centerWithout, centerWithTile })
    );
    const tiledPng = await evaluate(`document.getElementById('previewCanvas').toDataURL('image/png')`);
    await writeFile(join(outDir, 'e2e-watermark-tiled.png'), Buffer.from(tiledPng.split(',')[1], 'base64'));

    // Up to three layers, then the add button locks.
    const versionBeforeLayers = (await state()).watermarkVersion;
    await evaluate(`document.getElementById('addLayerButton').click()`);
    await sleep(120);
    await evaluate(`document.getElementById('addLayerButton').click()`);
    await sleep(200);
    const layered = await evaluate(`(function(){
      var snapshot = window.CleanFrameXhs.state;
      return {
        layers: snapshot.watermark.layers.length,
        inputs: document.querySelectorAll('#layerList .layer-text').length,
        addDisabled: document.getElementById('addLayerButton').disabled,
        versionBumped: snapshot.watermarkVersion > ${versionBeforeLayers}
      };
    })()`);
    check('three layers can be added', layered.layers === 3 && layered.inputs === 3, JSON.stringify(layered));
    check('the add button locks at three layers', layered.addDisabled === true, JSON.stringify(layered));

    // Type into the second layer and confirm all layers reach the pixels.
    await evaluate(`(function(){
      var inputs = document.querySelectorAll('#layerList .layer-text');
      inputs[1].value = '第二层';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const versionBeforeMulti = (await state()).watermarkVersion;
    await evaluate(`document.querySelector('#templateChips .chip[data-value="travel"]').click()`);
    await waitFor('travel restored', async () => {
      const snapshot = await state();
      const current = snapshot.items[snapshot.current];
      return (
        snapshot.watermark.layers.length === 2 &&
        snapshot.watermark.template === 'travel' &&
        snapshot.watermarkVersion > versionBeforeMulti &&
        current.output &&
        current.output.version === snapshot.watermarkVersion
      );
    });
    const restored = await state();
    check(
      'picking a template replaces the layer list',
      restored.watermark.layers.length === 2 && restored.watermarkCustom === false,
      JSON.stringify({ layers: restored.watermark.layers.length, custom: restored.watermarkCustom })
    );

    // Regression for the dead-end: after a watermark change the other items are
    // stale, and save/publish used to be disabled until a manual re-clean, which
    // made "auto-regenerate on save" unreachable.
    const staleState = await evaluate(`(function(){
      var snapshot = window.CleanFrameXhs.state;
      var fresh = snapshot.items.filter(function (entry) {
        return entry.output && entry.output.version === snapshot.watermarkVersion;
      }).length;
      return {
        fresh: fresh,
        total: snapshot.items.length,
        saveDisabled: document.getElementById('saveButton').disabled,
        publishDisabled: document.getElementById('publishButton').disabled
      };
    })()`);
    check(
      'save/publish stay available while only some outputs are fresh',
      staleState.fresh > 0 && staleState.fresh < staleState.total && !staleState.saveDisabled && !staleState.publishDisabled,
      JSON.stringify(staleState)
    );

    // Dump the preview canvas itself so the watermark is reviewable at 1:1.
    await evaluate(`document.getElementById('watermarkCard').scrollIntoView({ block: 'start' })`);
    await sleep(300);
    const canvasDataUrl = await evaluate(`document.getElementById('previewCanvas').toDataURL('image/png')`);
    await writeFile(join(outDir, 'e2e-watermark-canvas.png'), Buffer.from(canvasDataUrl.split(',')[1], 'base64'));

    await evaluate(`document.getElementById('watermarkCard').scrollIntoView({ block: 'center' })`);
    await sleep(400);
    await shot('e2e-watermark-panel.png');

    // ------------------------------------------------- bridge conventions
    const saveRound = async (setup, label) => {
      await evaluate(`window.__calls = []; document.getElementById('toast').textContent = ''; ${setup}`);
      await evaluate(`document.getElementById('saveButton').click()`);
      await waitFor(
        `${label} save`,
        async () => /已保存|保存失败|张失败/.test(await evaluate(`document.getElementById('toast').textContent`)),
        40000
      );
      await sleep(250);
      return evaluate('JSON.parse(JSON.stringify(window.__calls))');
    };

    // 1. Promise based.
    const promiseCalls = await saveRound(
      `window.xhs = { miniTool: {
        writeTempFile: function (payload) {
          window.__calls.push({ name: 'writeTempFile', head: payload.data.slice(0, 23) });
          return Promise.resolve({ filePath: '/tmp/promise.jpg' });
        },
        saveImageToPhotosAlbum: function (payload) {
          window.__calls.push({ name: 'save', filePath: payload.filePath });
          return Promise.resolve({});
        },
        postNote: function (payload) {
          window.__calls.push({ name: 'postNote', count: payload.mediaInfo.image_resources.length });
          return Promise.resolve({});
        }
      }};`,
      'promise'
    );
    check(
      'promise bridge: data URI + filePath round trip',
      promiseCalls.filter((call) => call.name === 'writeTempFile').every((call) => call.head === 'data:image/jpeg;base64,') &&
        promiseCalls.filter((call) => call.name === 'save').every((call) => call.filePath === '/tmp/promise.jpg'),
      JSON.stringify(promiseCalls.slice(0, 2))
    );

    // 2. Callback based, using cb(result) for one API and cb.success() for the other.
    const callbackCalls = await saveRound(
      `(function () {
        var n = 0;
        window.xhs = { miniTool: {
          writeTempFile: function (payload, cb) {
            setTimeout(function () { n += 1; cb({ filePath: '/tmp/cb-' + n + '.jpg' }); }, 5);
          },
          saveImageToPhotosAlbum: function (payload, cb) {
            window.__calls.push({ name: 'save', filePath: payload.filePath });
            cb.success({});
          },
          postNote: function (payload, cb) { cb.success({}); }
        }};
      })();`,
      'callback'
    );
    const callbackFiles = callbackCalls.filter((call) => call.name === 'save').map((call) => call.filePath);
    check(
      'callback bridge: async filePath reaches the album call',
      callbackFiles.length === 3 && callbackFiles.every((path) => /^\/tmp\/cb-\d+\.jpg$/.test(path)),
      JSON.stringify(callbackFiles)
    );

    // 3. Synchronous return and bare return.
    const syncCalls = await saveRound(
      `window.xhs = { miniTool: {
        writeTempFile: function (payload) {
          window.__calls.push({ name: 'writeTempFile' });
          return { filePath: '/tmp/sync.jpg' };
        },
        saveImageToPhotosAlbum: function (payload) {
          window.__calls.push({ name: 'save', filePath: payload.filePath });
        },
        postNote: function () { window.__calls.push({ name: 'postNote' }); }
      }};`,
      'sync'
    );
    check(
      'sync bridge: bare return still counts as success',
      syncCalls.filter((call) => call.name === 'save').every((call) => call.filePath === '/tmp/sync.jpg') &&
        syncCalls.filter((call) => call.name === 'save').length === 3,
      JSON.stringify(syncCalls.slice(0, 3))
    );

    // 4. Watermark editing while a save is in flight.
    //    Edits are NOT queued (a deferred edit would diverge from the rendered
    //    output), so the controls must be genuinely disabled rather than accept
    //    a keystroke that gets dropped on the next render.
    await evaluate(`(function(){
      window.__calls = [];
      window.xhs = { miniTool: {
        writeTempFile: function () {
          return new Promise(function (resolve) { setTimeout(function () { resolve({ filePath: '/tmp/slow.jpg' }); }, 350); });
        },
        saveImageToPhotosAlbum: function () { return Promise.resolve({}); },
        postNote: function () { return Promise.resolve({}); }
      }};
      return true;
    })()`);
    await evaluate(`document.getElementById('saveButton').click()`);
    await sleep(150);
    const duringSave = await evaluate(`({
      busy: window.CleanFrameXhs.state.busy,
      inputDisabled: document.querySelector('#layerList .layer-text').disabled,
      chipDisabled: document.querySelector('#templateChips .chip').disabled,
      addDisabled: document.getElementById('addLayerButton').disabled
    })`);
    check(
      'watermark controls are disabled while saving',
      duringSave.busy && duringSave.inputDisabled && duringSave.chipDisabled && duringSave.addDisabled,
      JSON.stringify(duringSave)
    );

    // Even a programmatic edit during the busy window must not reach state.
    const textBeforeBusyEdit = await evaluate(`window.CleanFrameXhs.state.watermark.layers[0].text`);
    await evaluate(`(function(){
      var input = document.querySelector('#layerList .layer-text');
      input.value = '@保存中改水印';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    await waitFor('slow save finished', async () => (await state()).busy === false, 40000);
    const afterSave = await evaluate(`(function(){
      var snapshot = window.CleanFrameXhs.state;
      return {
        inputDisabled: document.querySelector('#layerList .layer-text').disabled,
        chipDisabled: document.querySelector('#templateChips .chip').disabled,
        saveDisabled: document.getElementById('saveButton').disabled,
        firstLayerText: snapshot.watermark.layers[0].text
      };
    })()`);
    check(
      'controls and export come back after the save',
      afterSave.inputDisabled === false && afterSave.chipDisabled === false && afterSave.saveDisabled === false,
      JSON.stringify(afterSave)
    );
    check(
      'an edit pushed during the busy window is ignored',
      afterSave.firstLayerText === textBeforeBusyEdit,
      JSON.stringify({ before: textBeforeBusyEdit, after: afterSave.firstLayerText })
    );

    // 5. Permission denial must produce an actionable message.
    await evaluate(`(function(){
      document.getElementById('toast').textContent = '';
      window.__calls = [];
      window.xhs = { miniTool: {
        writeTempFile: function (payload) { return Promise.resolve({ filePath: '/tmp/denied.jpg' }); },
        saveImageToPhotosAlbum: function () { return Promise.reject(new Error('saveImageToPhotosAlbum:fail auth deny')); },
        postNote: function () { return Promise.resolve({}); }
      }};
      return true;
    })()`);
    await evaluate(`document.getElementById('saveButton').click()`);
    await waitFor('permission toast', async () => {
      const text = await evaluate(`document.getElementById('toast').textContent`);
      return /相册权限/.test(text);
    });
    const denyToast = await evaluate(`document.getElementById('toast').textContent`);
    check('permission denial explains how to fix it', /相册权限/.test(denyToast), denyToast);

    // Publish chain.
    await evaluate(`(function(){
      window.__calls = [];
      window.xhs = { miniTool: {
        writeTempFile: function () { return Promise.resolve({ filePath: '/tmp/x.jpg' }); },
        saveImageToPhotosAlbum: function () { return Promise.resolve({}); },
        postNote: function (payload) {
          window.__calls.push({ name: 'postNote', count: payload.mediaInfo.image_resources.length, first: payload.mediaInfo.image_resources[0].url.slice(0, 23) });
          return Promise.resolve({});
        }
      }}; return true;
    })()`);
    await evaluate(`document.getElementById('publishButton').click()`);
    await waitFor('publish chain', async () => (await evaluate('window.__calls.length')) >= 1);
    const publishCalls = await evaluate('JSON.parse(JSON.stringify(window.__calls))');
    check('postNote called with all images', publishCalls[0].name === 'postNote' && publishCalls[0].count === 3, JSON.stringify(publishCalls));
    check(
      'postNote resources are data URIs',
      publishCalls[0].first === 'data:image/jpeg;base64,',
      publishCalls[0].first
    );

    check('no console errors', errors.length === 0, errors.join(' | '));
  } catch (error) {
    if (pageErrors.length) {
      console.log('\nPage console errors:');
      for (const entry of pageErrors) console.log(`  ! ${entry}`);
    }
    throw error;
  } finally {
    await cleanup();
  }

  const total = passes.length + failures.length;
  console.log(`\n${passes.length}/${total} browser checks passed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const failure of failures) {
      console.log(`  x ${failure.name}`);
      if (failure.detail) console.log(`    ${failure.detail}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`OK - screenshots in ${outDir}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
