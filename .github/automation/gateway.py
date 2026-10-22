"""Key-bearing API boundary. Never mount this container into the agent."""

import http.server
import json
import os
import socket
import time
import urllib.error
import urllib.request

MODEL = 'deepseek-flash'
MAX_REQUESTS = 150
MAX_BYTES = 512 * 1024
MAX_OUTPUT = 8192
MAX_RESERVED = 32 * 1024 * 1024
MAX_CONTEXT = 131072


class Rejected(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


class Budget:
    def __init__(self):
        self.requests = 0
        self.reserved = 0

    def reserve(self, size):
        # Bound cumulative outbound JSON volume, independently of token usage.
        # This is an operational byte limit, not a monetary or token budget.
        amount = size
        if size > MAX_BYTES:
            raise Rejected('request_too_large')
        if self.requests >= MAX_REQUESTS:
            raise Rejected('request_limit')
        if self.reserved + amount > MAX_RESERVED:
            raise Rejected('reserved_limit')
        self.requests += 1
        self.reserved += amount


def prepare_request(raw):
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get('model') != MODEL:
        raise ValueError('Only deepseek-flash is allowed')
    # Rebuild the payload rather than forwarding arbitrary client parameters.
    return json.dumps({
        'model': MODEL,
        'messages': value['messages'],
        'tools': value.get('tools', []),
        'max_tokens': MAX_OUTPUT,
        'stream': False,
        'thinking': {'type': 'disabled'},
    }, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def stream_response(data):
    chunks = []
    for choice in data['choices']:
        message = choice['message']
        delta = {key: value for key, value in message.items() if value is not None}
        if 'tool_calls' in delta:
            delta['tool_calls'] = [dict(call, index=index) for index, call in enumerate(delta['tool_calls'])]
        chunks.append({'id': data['id'], 'object': 'chat.completion.chunk',
                       'model': MODEL, 'created': data.get('created', 0),
                       'choices': [{'index': choice['index'], 'delta': delta, 'finish_reason': None}]})
        chunks.append({'id': data['id'], 'object': 'chat.completion.chunk',
                       'model': MODEL, 'created': data.get('created', 0),
                       'choices': [{'index': choice['index'], 'delta': {}, 'finish_reason': choice['finish_reason']}],
                       'usage': data.get('usage', {})})
    return (''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n').encode()


def usage_record(data, elapsed_ms):
    """Extract only counts and fixed finish labels; never include model content."""
    def count(value):
        return value if type(value) is int and 0 <= value <= 10_000_000 else None
    usage = data.get('usage', {}) if isinstance(data, dict) else {}
    if not isinstance(usage, dict):
        usage = {}
    prompt = count(usage.get('prompt_tokens'))
    completion = count(usage.get('completion_tokens'))
    hit = count(usage.get('prompt_cache_hit_tokens'))
    miss = count(usage.get('prompt_cache_miss_tokens'))
    if prompt is None or hit is None or miss is None or hit + miss != prompt:
        hit = miss = None
    finish = 'unknown'
    choices = data.get('choices') if isinstance(data, dict) else None
    if isinstance(choices, list) and len(choices) == 1 and isinstance(choices[0], dict):
        candidate = choices[0].get('finish_reason')
        if isinstance(candidate, str) and candidate in {'stop', 'length', 'tool_calls',
                'content_filter', 'insufficient_system_resource', 'aborted'}:
            finish = candidate
    return {'event': 'api_usage', 'prompt_tokens': prompt, 'completion_tokens': completion,
            'cache_hit_tokens': hit, 'cache_miss_tokens': miss, 'finish_reason': finish,
            'elapsed_ms': max(0, min(int(elapsed_ms), 3_600_000)),
            'completed_at_unix': int(time.time())}


class Handler(http.server.BaseHTTPRequestHandler):
    budget = Budget()
    received = 0
    attempted = 0

    @classmethod
    def status(cls, outcome, http_status=0, reason='none', request_bytes=0):
        # Never include URLs, headers, exception strings, or request/response bodies.
        print(json.dumps({'event': 'api_status', 'outcome': outcome,
                          'received': cls.received, 'attempted': cls.attempted,
                          'http_status': http_status, 'reason': reason,
                          'request_bytes': request_bytes, 'reserved': cls.budget.reserved,
                          'reserved_limit': MAX_RESERVED, 'request_limit': MAX_REQUESTS}), flush=True)

    def log_message(self, *_args):
        pass

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self.reply(200, {'ready': True})
        else:
            self.reply(404, {'error': 'Unsupported endpoint'})

    def do_POST(self):
        type(self).received += 1
        if self.path != '/v1/chat/completions':
            self.status('rejected', reason='unsupported_endpoint')
            self.reply(404, {'error': 'Unsupported endpoint'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > MAX_BYTES:
                raise Rejected('invalid_request_size')
            raw = self.rfile.read(size)
            body = prepare_request(raw)
            try:
                self.budget.reserve(len(body))
            except Rejected as error:
                self.status('rejected', reason=error.reason, request_bytes=len(body))
                self.reply(400, {'error': error.reason})
                return
            request = urllib.request.Request(
                'https://api.deepseek.com/chat/completions', data=body,
                headers={'Authorization': 'Bearer ' + os.environ['DEEPSEEK_API_KEY'],
                         'Content-Type': 'application/json'})
            # No redirects: never send credentials to a client-selected URL.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *_args, **_kwargs):
                    return None
            started = time.monotonic()
            type(self).attempted += 1
            self.status('attempt', request_bytes=len(body))
            with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
                status = response.status
                self.status('success', status)
                try:
                    raw_response = response.read(4_000_001)
                    if len(raw_response) > 4_000_000:
                        raise ValueError
                    data = json.loads(raw_response)
                except (ValueError, UnicodeError):
                    self.status('invalid_response', status)
                    self.reply(502, {'error': 'Invalid upstream response'})
                    return
            print(json.dumps(usage_record(data, (time.monotonic() - started) * 1000)), flush=True)
            if json.loads(raw).get('stream'):
                payload = stream_response(data)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self.reply(200, data)
        except urllib.error.HTTPError as error:
            self.status('http_error', error.code)
            self.reply(502, {'error': f'DeepSeek HTTP {error.code}'})
        except (TimeoutError, socket.timeout):
            self.status('timeout')
            self.reply(504, {'error': 'DeepSeek timeout'})
        except urllib.error.URLError as error:
            timed_out = isinstance(error.reason, TimeoutError)
            self.status('timeout' if timed_out else 'transport_error')
            self.reply(504 if timed_out else 502, {'error': 'DeepSeek connection failed'})
        except Rejected as error:
            self.status('rejected', reason=error.reason)
            self.reply(400, {'error': error.reason})
        except (ValueError, KeyError, TypeError):
            self.status('rejected', reason='invalid_payload')
            self.reply(400, {'error': 'Invalid payload or API budget exhausted'})
        except Exception:
            self.status('transport_error')
            self.reply(502, {'error': 'DeepSeek transport failure'})


if __name__ == '__main__':
    if not os.environ.get('DEEPSEEK_API_KEY'):
        raise SystemExit('DEEPSEEK_API_KEY is required')
    server = http.server.HTTPServer(('0.0.0.0', 8080), Handler)
    Handler.status('ready')
    server.serve_forever()
