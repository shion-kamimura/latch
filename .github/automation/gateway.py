"""Key-bearing API boundary. Never mount this container into the agent."""

import http.server
import json
import os
import urllib.error
import urllib.request

MODEL = 'deepseek-flash'
MAX_REQUESTS = 24
MAX_BYTES = 120_000
MAX_OUTPUT = 4096
MAX_RESERVED = 500_000


class Budget:
    def __init__(self):
        self.requests = 0
        self.reserved = 0

    def reserve(self, size):
        # UTF-8 bytes plus output allowance conservatively bounds ordinary text
        # usage; this is an operational limit, not an exact currency budget.
        amount = size + MAX_OUTPUT
        if size > MAX_BYTES or self.requests >= MAX_REQUESTS or self.reserved + amount > MAX_RESERVED:
            raise ValueError('API budget exhausted or request too large')
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
    }).encode()


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


class Handler(http.server.BaseHTTPRequestHandler):
    budget = Budget()

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
        if self.path != '/v1/chat/completions':
            self.reply(404, {'error': 'Unsupported endpoint'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > MAX_BYTES:
                raise ValueError('Invalid request size')
            raw = self.rfile.read(size)
            body = prepare_request(raw)
            self.budget.reserve(len(body))
            request = urllib.request.Request(
                'https://api.deepseek.com/chat/completions', data=body,
                headers={'Authorization': 'Bearer ' + os.environ['DEEPSEEK_API_KEY'],
                         'Content-Type': 'application/json'})
            # No redirects: never send credentials to a client-selected URL.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *_args, **_kwargs):
                    return None
            with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
                data = json.loads(response.read(4_000_001))
            if json.loads(raw).get('stream'):
                payload = stream_response(data)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self.reply(200, data)
            print(f'API request {self.budget.requests}; reserved units {self.budget.reserved}', flush=True)
        except urllib.error.HTTPError as error:
            print(f'DeepSeek HTTP {error.code}', flush=True)
            self.reply(502, {'error': f'DeepSeek HTTP {error.code}'})
        except (ValueError, KeyError, TypeError):
            print('API request rejected: invalid payload or budget exhausted', flush=True)
            self.reply(400, {'error': 'Invalid payload or API budget exhausted'})
        except Exception:
            print('DeepSeek transport failure', flush=True)
            self.reply(502, {'error': 'DeepSeek transport failure'})


if __name__ == '__main__':
    if not os.environ.get('DEEPSEEK_API_KEY'):
        raise SystemExit('DEEPSEEK_API_KEY is required')
    http.server.HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
