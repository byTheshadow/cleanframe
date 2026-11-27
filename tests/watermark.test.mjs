import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLayer,
  normalizeLayers,
  hasVisibleWatermark,
  renderWatermarked,
} from '../js/watermark.js';
import {
  WATERMARK_PRESETS,
  findPreset,
  presetLayers,
} from '../js/watermark-presets.js';

test('watermark layers keep identity, order and visibility', () => {
  const layers = normalizeLayers([
    { id: 'top', name: '主标题', text: 'MAIN', enabled: true },
    { id: 'bottom', name: '小字', text: 'SECOND', enabled: false },
  ]);
  assert.equal(layers.length, 2);
  assert.equal(layers[0].id, 'top');
  assert.equal(layers[0].name, '主标题');
  assert.equal(layers[0].enabled, true);
  assert.equal(layers[1].enabled, false);
  assert.ok(layers[0].opacity > 0);
  assert.ok(layers[0].size >= 1.5);
});

test('layer normalization handles missing and invalid values', () => {
  const layer = normalizeLayer({ id: 'x', text: 'OK', opacity: 0, size: 999 });
  assert.equal(layer.id, 'x');
  assert.equal(layer.type, 'text');
  assert.equal(layer.opacity, 0.05);
  assert.equal(layer.size, 18);
  assert.equal(normalizeLayer(null, 2).id, 'watermark-3');
});

test('visible watermark detection respects disable and logo requirements', () => {
  assert.equal(hasVisibleWatermark([{ id: 'a', text: 'HELLO' }]), true);
  assert.equal(hasVisibleWatermark([{ id: 'a', text: 'HELLO', enabled: false }]), false);
  assert.equal(hasVisibleWatermark([{ id: 'a', text: '   ' }]), false);
  assert.equal(hasVisibleWatermark([{ id: 'logo', type: 'logo' }]), false);
  assert.equal(
    hasVisibleWatermark([{ id: 'logo', type: 'logo' }], { logo: { width: 10 } }),
    true,
  );
});

test('all built-in presets are editable layer stacks', () => {
  assert.ok(WATERMARK_PRESETS.length >= 6);
  const ids = new Set(WATERMARK_PRESETS.map((preset) => preset.id));
  assert.equal(ids.size, WATERMARK_PRESETS.length);
  for (const preset of WATERMARK_PRESETS) {
    assert.ok(preset.name);
    assert.ok(preset.layers.length >= 1);
    assert.ok(preset.layers.every((layer) => layer.text || layer.type === 'logo'));
  }
  const studio = findPreset('studio');
  assert.equal(studio.layers.length, 2);
  const layers = presetLayers('studio', () => `id-${Math.random().toString(36).slice(2)}`);
  assert.equal(layers.length, 2);
  assert.ok(layers.every((layer) => layer.id && layer.enabled));
  assert.ok(layers.some((layer) => layer.name === '工作室名'));
});

test('empty watermark export is rejected before touching the canvas', async () => {
  await assert.rejects(
    renderWatermarked(new Blob(['x']), []),
    /没有可用的水印图层/,
  );
});
