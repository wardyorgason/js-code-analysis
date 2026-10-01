const assert = require('node:assert');
const { formatMoney } = require('../src/format');
describe('format', () => { it('money', () => assert.strictEqual(formatMoney(1, 'USD'), '$1.00')); });
