/* eslint-disable @typescript-eslint/no-require-imports -- Isolated database test bootstrap. */
const url = new URL(process.env.AGENTIC_TEST_DATABASE_URL || '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^agentic_test_[a-z0-9_]+$/.test(url.searchParams.get('schema') || '')) {
  throw new Error('AGENTIC_TEST_DATABASE_URL must use localhost and an agentic_test_* schema');
}
process.env.DATABASE_URL = url.toString();
process.env.DELIVERY_FEE_LKR = '100';
process.env.DELIVERY_MINIMUM_LKR = '0';
delete process.env.DELIVERY_FREE_ABOVE_LKR;
const Module = require('module');
const path = require('path');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  return resolve.call(this, name.startsWith('@/') ? path.join(__dirname, '..', name.slice(2)) : name, ...args);
};
require('esbuild-register');
require('./verify-agentic-integrity.ts');
