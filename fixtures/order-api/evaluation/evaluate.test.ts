import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { handleRequest } from '../src/api.ts';

interface Case {
  id: string;
  category: 'normal' | 'abnormal' | 'boundary';
  body: unknown;
  expected: { status: number; body: unknown };
}

interface Data {
  request: { method: string; path: string };
  cases: Case[];
}

const data = JSON.parse(
  readFileSync(new URL('./cases.json', import.meta.url), 'utf8'),
) as Data;

async function call(
  method: string,
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
    },
  };
  await handleRequest(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) as unknown };
}

test.each(data.cases.map((item) => [item.id, item] as const))(
  'oracle case %s',
  async (_id, item) => {
    const result = await call(
      data.request.method,
      data.request.path,
      item.body,
    );
    expect(result).toEqual(item.expected);
  },
);

describe('HTTP routing', () => {
  test('unknown path returns 404', async () => {
    expect(await call('POST', '/orders', {})).toEqual({
      status: 404,
      body: { error: 'not found' },
    });
  });

  test('non-POST method returns 404', async () => {
    expect(await call('GET', data.request.path, '')).toEqual({
      status: 404,
      body: { error: 'not found' },
    });
  });

  test('malformed JSON returns 400', async () => {
    expect(await call('POST', data.request.path, '{"lines":')).toEqual({
      status: 400,
      body: { error: 'invalid JSON' },
    });
  });

  test('sets a JSON content type', async () => {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      end(chunk?: string) {
        this.body = chunk ?? '';
      },
    };
    const req = {
      method: 'GET',
      url: '/',
      async *[Symbol.asyncIterator]() {
        yield '';
      },
    };
    await handleRequest(req, res);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});
