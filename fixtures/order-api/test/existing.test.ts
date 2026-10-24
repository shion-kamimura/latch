import { expect, test } from 'vitest';
import { calculateOrder, MAX_UNITS_PER_LINE } from '../src/api.ts';

const line = {
  sku: 'SKU-001',
  quantity: 2,
  unitPriceCents: 500,
};

test('calculates the subtotal without a coupon', () => {
  expect(calculateOrder({ lines: [line] })).toEqual({
    ok: true,
    value: { subtotalCents: 1000, totalCents: 1000, appliedCoupon: null },
  });
});

test('applies SAVE10 to a single line', () => {
  expect(calculateOrder({ lines: [line], couponCode: 'SAVE10' })).toEqual({
    ok: true,
    value: { subtotalCents: 1000, totalCents: 900, appliedCoupon: 'SAVE10' },
  });
});

test('sums multiple lines', () => {
  const other = { sku: 'SKU-002', quantity: 1, unitPriceCents: 250 };
  const result = calculateOrder({ lines: [line, other] });
  expect(result).toEqual({
    ok: true,
    value: { subtotalCents: 1250, totalCents: 1250, appliedCoupon: null },
  });
});

test('rejects an empty line list', () => {
  expect(calculateOrder({ lines: [] })).toEqual({
    ok: false,
    error: 'lines must be a non-empty array',
  });
});

test('rejects a quantity above the per-line maximum', () => {
  const result = calculateOrder({
    lines: [{ ...line, quantity: MAX_UNITS_PER_LINE + 1 }],
  });
  expect(result).toEqual({ ok: false, error: 'invalid quantity' });
});
