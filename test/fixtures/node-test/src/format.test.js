const test = require('node:test');
const assert = require('node:assert');
const { formatName } = require('./format');
test('name', () => assert.strictEqual(formatName('a', 'b'), 'a b'));
