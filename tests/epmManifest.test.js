// Unit tests for src/utils/epmManifest.js. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingFromManifest } from '../src/utils/epmManifest.js';

const manifest = {
  listed: ['^epm/input$', '^epm/output(_view)?$'],
  branches: {
    wapp_2026: { commit: 'abc', dirs: { 'epm/input': [['data_wapp', 'dir'], ['readme.md', 'file']] } },
  },
};

test('a covered folder comes back as the Contents API would list it', () => {
  assert.deepEqual(listingFromManifest(manifest, 'wapp_2026', 'epm/input'),
    [{ name: 'data_wapp', type: 'dir' }, { name: 'readme.md', type: 'file' }]);
});

test('a covered folder that does not exist is null, as a 404 from the API', () => {
  assert.equal(listingFromManifest(manifest, 'wapp_2026', 'epm/output_view'), null);
});

test('an uncovered branch or path is left to the API', () => {
  assert.equal(listingFromManifest(manifest, 'other_branch', 'epm/input'), undefined);
  assert.equal(listingFromManifest(manifest, 'wapp_2026', 'epm/input/data_wapp'), undefined);
  assert.equal(listingFromManifest(null, 'wapp_2026', 'epm/input'), undefined);
});
