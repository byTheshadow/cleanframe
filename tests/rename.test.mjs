import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRenamePlan, splitFileName, dateStamp } from '../js/rename.js';

const items = [
  { name: '外滩暮色.jpg' },
  { name: '山谷晨雾.png' },
  { name: '夜航.JPEG' },
];

test('splitFileName keeps the original extension', () => {
  assert.deepEqual(splitFileName('photo.final.JPG'), { base: 'photo.final', extension: '.JPG' });
  assert.deepEqual(splitFileName('no-extension'), { base: 'no-extension', extension: '' });
});

test('unified base and numbering produce clear names', () => {
  const result = buildRenamePlan(items, {
    base: '上海旅行.jpg',
    prefix: '',
    suffix: '',
    numbering: true,
    start: 1,
    digits: 2,
    separator: '-',
  });
  assert.equal(result.error, '');
  assert.equal(result.changed, true);
  assert.deepEqual(
    result.plans.map((plan) => plan.newName),
    ['上海旅行-01.jpg', '上海旅行-02.png', '上海旅行-03.JPEG'],
  );
});

test('prefix and suffix work without a unified base', () => {
  const result = buildRenamePlan(items, {
    base: '',
    prefix: '精选-',
    suffix: '-2026',
    numbering: false,
  });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.plans.map((plan) => plan.newName),
    ['精选-外滩暮色-2026.jpg', '精选-山谷晨雾-2026.png', '精选-夜航-2026.JPEG'],
  );
});

test('numbering without a base keeps each original base', () => {
  const result = buildRenamePlan(items.slice(0, 2), {
    base: '',
    numbering: true,
    start: 7,
    digits: 3,
    separator: '_',
  });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.plans.map((plan) => plan.newName),
    ['外滩暮色_007.jpg', '山谷晨雾_008.png'],
  );
});

test('using one base without numbering is rejected as a conflict', () => {
  const result = buildRenamePlan([{ name: 'a.jpg' }, { name: 'b.jpg' }], {
    base: '同一张',
    numbering: false,
  });
  assert.ok(result.error.includes('重名'));
  assert.equal(result.changed, true);
});

test('illegal characters and reserved Windows names are sanitized', () => {
  const result = buildRenamePlan([{ name: 'a.jpg' }], {
    base: 'CON',
    numbering: false,
  });
  assert.equal(result.error, '');
  assert.equal(result.plans[0].newName, '_CON.jpg');

  const illegal = buildRenamePlan([{ name: 'b.png' }], {
    base: '旅行/上海?',
    numbering: false,
  });
  assert.equal(illegal.error, '');
  assert.equal(illegal.plans[0].newName, '旅行-上海.png');
});

test('unchanged names are detected', () => {
  const result = buildRenamePlan(items.slice(0, 1), {
    base: '',
    prefix: '',
    suffix: '',
    numbering: false,
  });
  assert.equal(result.error, '');
  assert.equal(result.changed, false);
  assert.equal(result.plans[0].newName, result.plans[0].oldName);
});

test('empty selections and empty names are rejected', () => {
  assert.ok(buildRenamePlan([], {}).error.includes('先选择'));
  const result = buildRenamePlan([{ name: 'x.jpg' }], { base: '////', numbering: false });
  assert.ok(result.error.includes('名称'));
});

test('date stamp follows local YYYYMMDD', () => {
  assert.equal(dateStamp(new Date(2026, 10, 27)), '20261127');
});
