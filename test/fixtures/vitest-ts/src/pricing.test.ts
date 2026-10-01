import { describe, expect, it } from 'vitest';
import { shippingFor } from './pricing';
describe('shippingFor', () => {
  it('is free over 200', () => expect(shippingFor(250, 'EU', false)).toBe(0));
  it('charges EU standard', () => expect(shippingFor(50, 'EU', false)).toBe(10));
});
