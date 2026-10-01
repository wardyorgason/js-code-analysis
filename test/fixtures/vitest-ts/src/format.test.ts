import { expect, it } from 'vitest';
import { formatMoney, formatName } from './format';
it('formats money', () => expect(formatMoney(3, 'EUR')).toBe('€3.00'));
it('formats names', () => {
  expect(formatName('a', 'b')).toBe('a b');
  expect(formatName('', 'b')).toBe('b');
});
