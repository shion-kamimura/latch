import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_UNITS_PER_LINE = 10;

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderRequest {
  lines: OrderLine[];
  couponCode?: string;
}

export interface OrderTotal {
  subtotalCents: number;
  totalCents: number;
  appliedCoupon: string | null;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const COUPONS: Record<string, number> = {
  SAVE10: 10,
  SAVE20: 20,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseLine(value: unknown): Result<OrderLine> {
  if (!isRecord(value)) return { ok: false, error: 'invalid line' };
  const { sku, quantity, unitPriceCents } = value;
  if (typeof sku !== 'string' || !/^[A-Z0-9-]{3,32}$/.test(sku)) {
    return { ok: false, error: 'invalid sku' };
  }
  if (
    !isNonNegativeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_UNITS_PER_LINE
  ) {
    return { ok: false, error: 'invalid quantity' };
  }
  if (!isNonNegativeInteger(unitPriceCents)) {
    return { ok: false, error: 'invalid unit price' };
  }
  return { ok: true, value: { sku, quantity, unitPriceCents } };
}

function parseCoupon(value: unknown): Result<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || !Object.hasOwn(COUPONS, value)) {
    return { ok: false, error: 'unknown coupon' };
  }
  return { ok: true, value };
}

function couponPercent(code: string): number {
  return COUPONS[code] ?? 0;
}

export function calculateOrder(body: unknown): Result<OrderTotal> {
  if (!isRecord(body)) return { ok: false, error: 'invalid body' };
  const { lines, couponCode } = body;
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, error: 'lines must be a non-empty array' };
  }

  const coupon = parseCoupon(couponCode);
  if (!coupon.ok) return coupon;

  let subtotalCents = 0;
  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line.ok) return line;
    subtotalCents += line.value.quantity * line.value.unitPriceCents;
  }

  const appliedCoupon = coupon.value ?? null;
  const discount = Math.round(
    (subtotalCents * couponPercent(appliedCoupon ?? '')) / 100,
  );
  return {
    ok: true,
    value: {
      subtotalCents,
      totalCents: subtotalCents - discount,
      appliedCoupon,
    },
  };
}

interface Response {
  status: number;
  body: unknown;
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const result = await route(req);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(result.body));
}

async function route(req: IncomingMessage): Promise<Response> {
  if (req.method !== 'POST' || req.url !== '/orders/total') {
    return { status: 404, body: { error: 'not found' } };
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  const total = calculateOrder(body);
  if (!total.ok) return { status: 400, body: { error: total.error } };
  return { status: 200, body: total.value };
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
