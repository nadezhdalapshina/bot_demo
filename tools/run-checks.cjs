'use strict';
const {execFileSync} = require('node:child_process');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
const checks = [
  'autosave-unit', 'html-unit', 'safety', 'board-unit', 'navigation-unit',
  'board-layout', 'contact-chat-pair', 'message-media-unit', 'preview',
];
for (const check of checks) {
  execFileSync(process.execPath, ['tools/check-' + check + '.cjs'], {stdio: 'inherit'});
}
