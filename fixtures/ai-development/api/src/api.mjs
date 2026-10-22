import { URL } from 'node:url';

export function handleDuration(url) {
  const request = new URL(url, 'http://localhost');
  if (request.pathname !== '/duration') return { status: 404 };
  const ms = Number(request.searchParams.get('ms'));
  if (!Number.isFinite(ms)) {
    return { status: 400, error: 'invalid duration' };
  }
  return { status: 200, duration: `${ms}ms` };
}
