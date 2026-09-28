'use strict';

// Portable sanity check: parses every kernel32 prototype and verifies struct
// layouts against their Win32 sizes. Runs on any OS (no DLL is loaded off Windows).

const assert = require('assert');
const koffi = require('koffi');
const w = require('../lib/win32');

for (const [name, proto] of Object.entries(w.PROTOTYPES)) {
  koffi.proto(proto);
  console.log(`ok  prototype ${name}`);
}

const is64 = koffi.sizeof('void *') === 8;
const expected = {
  FILETIME: 8,
  PROCESSENTRY32W: is64 ? 568 : 556,
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: 48,
};
for (const [name, size] of Object.entries(expected)) {
  assert.strictEqual(koffi.sizeof(w.structs[name]), size, `${name} size`);
  console.log(`ok  sizeof(${name}) = ${size}`);
}
console.log('all binding checks passed');
