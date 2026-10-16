'use strict';
// Static checks for the PWA files (manifest, icons, service worker precache list).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f));

function pngSize(buf) {
  assert.strictEqual(buf.slice(1, 4).toString('latin1'), 'PNG');
  return buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20);
}

test('manifest is valid, relative, and its icons exist with the declared sizes', () => {
  const m = JSON.parse(read('manifest.webmanifest').toString('utf8'));
  assert.strictEqual(m.start_url, './');
  assert.strictEqual(m.scope, './');
  assert.strictEqual(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of m.icons) {
    assert.ok(icon.src.startsWith('./'), icon.src);
    assert.strictEqual(pngSize(read(icon.src)), icon.sizes, icon.src);
  }
  assert.strictEqual(pngSize(read('icons/apple-touch-icon.png')), '180x180');
});

test('service worker precaches only existing, relative files', () => {
  const src = read('sw.js').toString('utf8');
  const list = src.match(/var PRECACHE = \[([\s\S]*?)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.ok(list.includes('./index.html') && list.includes('./engine.js') && list.includes('./net.js'));
  assert.match(src, /var VERSION = 'yaniv-v\d+'/);
  assert.match(src, /cache: 'no-cache'/, 'same-origin fetches must bypass the HTTP cache');
  assert.match(src, /u\.origin \+ u\.pathname/, 'navigations are keyed without the query string');
  for (const u of list) {
    assert.ok(u.startsWith('./'), u);
    if (u !== './') assert.ok(fs.existsSync(path.join(ROOT, u)), u);
  }
});

test('index.html links the manifest and registers the service worker relatively', () => {
  const h = read('index.html').toString('utf8');
  assert.match(h, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
  assert.match(h, /serviceWorker\.register\('\.\/sw\.js'\)/);
  assert.doesNotMatch(h, /\balert\(|\bconfirm\(|window\.prompt/);
});
