'use strict';

// This is a source-level contract for the product hierarchy. The office scene
// can remain as an optional implementation detail, but it must never reclaim
// the primary application surface from files, collaboration, and the ledger.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the app mounts the collaboration workbench instead of the office canvas', () => {
  const app = read('src/renderer/src/App.tsx');
  assert.match(app, /import \{ CollaborationWorkbench \}/);
  assert.match(app, /<CollaborationWorkbench/);
  assert.doesNotMatch(app, /import \{ OfficeFloor \}/);
  assert.doesNotMatch(app, /<OfficeFloor\s*\/>/);
});

test('the workbench keeps files, live agent collaboration, and tasks visible together', () => {
  const source = read('src/renderer/src/components/CollaborationWorkbench.tsx');
  for (const component of ['FileTree', 'AgentDetailPanel', 'TaskRail', 'TeamPulse']) {
    assert.match(source, new RegExp(component), `${component} is missing from the workbench`);
  }
  assert.match(source, /gridTemplateColumns:/, 'the three work areas must share one grid');
  assert.match(source, /filesOpen/, 'the files rail must be collapsible');
  assert.match(source, /tasksOpen/, 'the task rail must be collapsible');
});

test('automatic coordination is opt-in, state-driven, and de-duplicated', () => {
  const source = read('src/renderer/src/components/CollaborationWorkbench.tsx');
  assert.match(source, /useAutoCoordination\(config\.autoMode/);
  assert.match(source, /if \(!enabled\)/, 'automation must stop when Auto Mode is off');
  assert.match(source, /window\.cth\.hiveTasks\(\)/, 'automation must inspect the task ledger');
  assert.match(source, /AUTO_COORDINATION_TAG/);
  assert.match(source, /queuedAlready/, 'a repeated pulse must not queue duplicate work');
  assert.match(source, /Do not duplicate work already in progress/);
});

test('office-only theme controls are not exposed in Settings', () => {
  const settings = read('src/renderer/src/components/SettingsModal.tsx');
  assert.doesNotMatch(settings, /OfficeThemePicker/);
});

test('all locales provide the workbench labels', () => {
  for (const code of ['en', 'zh-CN', 'ar']) {
    const locale = JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));
    assert.ok(locale.workbench, `${code} is missing the workbench namespace`);
    for (const key of ['files', 'tasks', 'collaboration', 'coordinateNow', 'autoOn', 'autoOff']) {
      assert.equal(typeof locale.workbench[key], 'string', `${code} is missing workbench.${key}`);
    }
  }
});
