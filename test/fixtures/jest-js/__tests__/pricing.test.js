const { priceFor, shippingFor } = require('../src/pricing');
test('shipping', () => expect(shippingFor(10, 'US', true)).toBe(20));
test('price', () => expect(priceFor({ items: [{ qty: 1, price: 10, category: 'books' }] }, null, null, 'US')).toBe(10));
test('deliberately failing', () => expect(1 + 1).toBe(3));
