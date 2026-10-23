"""Key-bearing API boundary. Never mount this container into the agent."""

import hashlib
import http.server
from pathlib import Path
from decimal import Decimal, InvalidOperation
import json
import os
import socket
import time
import urllib.error
import urllib.request

MODEL = 'deepseek-flash'
MAX_REQUESTS = 10000
MAX_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_OUTPUT = 8192
MAX_RESERVED = 256 * 1024 * 1024
# Official model specification checked 2026-10-22 (see docs).
MAX_CONTEXT = 1_000_000
DEFAULT_COST_CONFIG = {'limit_usd': '5', 'hit_usd_per_million': '0.006',
                       'miss_usd_per_million': '0.3', 'output_usd_per_million': '1.2'}


def cost_config(raw=None):
    """Trusted operator configuration only; never read client parameters."""
    try:
        values = DEFAULT_COST_CONFIG if raw is None else json.loads(raw)
        if not isinstance(values, dict) or set(values) != set(DEFAULT_COST_CONFIG):
            raise ValueError
        result = {key: Decimal(str(value)) for key, value in values.items()}
        if any(not value.is_finite() or not Decimal('0') < value <= Decimal('1000000')
               for value in result.values()):
            raise ValueError
        if result['hit_usd_per_million'] > result['miss_usd_per_million']:
            raise ValueError
        return result
    except (ValueError, TypeError, InvalidOperation):
        raise ValueError('Invalid cost configuration') from None


DEFAULT_MODEL_CONFIG = {'model': MODEL, 'context_tokens': MAX_CONTEXT, 'output_tokens': MAX_OUTPUT,
                        'thinking': 'disabled', 'requests': MAX_REQUESTS}


def model_config(raw=None):
    try:
        value = DEFAULT_MODEL_CONFIG.copy() if raw is None else json.loads(raw)
        if (not isinstance(value, dict) or set(value) != set(DEFAULT_MODEL_CONFIG)
                or value['model'] != MODEL or value['thinking'] not in {'enabled', 'disabled'}
                or type(value['context_tokens']) is not int or not 1 <= value['context_tokens'] <= MAX_CONTEXT
                or type(value['output_tokens']) is not int or not 1 <= value['output_tokens'] <= MAX_OUTPUT
                or value['output_tokens'] > value['context_tokens']
                or type(value['requests']) is not int or not 100 <= value['requests'] <= 100000):
            raise ValueError
        return value
    except (ValueError, TypeError):
        raise ValueError('Invalid model configuration') from None


class PromptCounter:
    """Trusted, operator-provisioned official tokenizer snapshot; never remote code."""
    def __init__(self, directory=None, expected_sha=None):
        self.tokenizer = None
        self.revision = None
        if directory is None:
            return
        root = Path(directory)
        digest = hashlib.sha256()
        for path in sorted(root.rglob('*')):
            if path.is_symlink():
                raise ValueError('Invalid tokenizer snapshot')
            if path.is_file():
                if path.stat().st_size > 64 * 1024 * 1024:
                    raise ValueError('Invalid tokenizer snapshot')
                digest.update(path.relative_to(root).as_posix().encode() + b'\x00')
                digest.update(path.read_bytes())
        if digest.hexdigest() != expected_sha:
            raise ValueError('Tokenizer fingerprint mismatch')
        from transformers import AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
        self.revision = digest.hexdigest()

    def count(self, payload):
        if self.tokenizer is None:
            return None
        try:
            # Official template covers roles, tool definitions and generation prefix.
            # Unsupported modalities/template arguments fail closed to model-context reservation.
            if any(not isinstance(message, dict) or not isinstance(message.get('content', ''), (str, type(None)))
                   for message in payload['messages']):
                return None
            tokens = self.tokenizer.apply_chat_template(payload['messages'], tools=payload.get('tools') or None,
                        tokenize=True, add_generation_prompt=True,
                        enable_thinking=payload['thinking']['type'] == 'enabled')
            return len(tokens) if isinstance(tokens, list) else None
        except (ValueError, TypeError, KeyError):
            return None


class Rejected(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


class Budget:
    def __init__(self, pricing=None, settings=None):
        self.settings = model_config() if settings is None else model_config(json.dumps(settings))
        self.measurements = {}
        self.last_count_basis = 'model_context_fallback'
        self.tokenizer_revision = None
        self.requests = 0
        self.reserved = 0
        self.pricing = cost_config() if pricing is None else cost_config(json.dumps(pricing))
        self.estimated = Decimal(0)
        self.held = Decimal(0)
        self.unsettled_requests = 0
        self.warnings = set()
        self.stopped = False

    def maximum_cost(self, prompt_tokens=None):
        # Entire published context at peak cache-miss rates; no tokenizer guess.
        return ((self.settings['context_tokens'] if prompt_tokens is None else prompt_tokens) * self.pricing['miss_usd_per_million'] +
                self.settings['output_tokens'] * self.pricing['output_usd_per_million']) / 1_000_000

    def warn(self, name, value, limit):
        if value * 5 >= limit * 4:
            self.warnings.add(name)

    def authorize(self, size, prompt_tokens=None, fingerprint=None):
        self.last_count_basis = 'tokenizer' if prompt_tokens is not None else 'model_context_fallback'
        if prompt_tokens is None and fingerprint in self.measurements:
            prompt_tokens = self.measurements[fingerprint]
            self.last_count_basis = 'identical_request_usage'
        if prompt_tokens is not None and (type(prompt_tokens) is not int or not 0 <= prompt_tokens <= self.settings['context_tokens']):
            raise Rejected('invalid_payload')
        amount = self.maximum_cost(prompt_tokens)
        if self.stopped or self.estimated + self.held + amount > self.pricing['limit_usd']:
            raise Rejected('cost_limit')
        self.reserve(size)
        self.held += amount
        self.unsettled_requests += 1
        self.warn('cost', self.estimated + self.held, self.pricing['limit_usd'])
        return amount

    def settle(self, record, reservation, fingerprint=None):
        prompt, output = record['prompt_tokens'], record['completion_tokens']
        if prompt is None or output is None:
            return  # Ambiguous charges keep their full reservation.
        if prompt > self.settings['context_tokens'] or output > self.settings['output_tokens']:
            self.stopped = True
            return
        hit, miss = record['cache_hit_tokens'], record['cache_miss_tokens']
        if hit is None or miss is None:
            hit, miss = 0, prompt
        cost = (hit * self.pricing['hit_usd_per_million'] +
                miss * self.pricing['miss_usd_per_million'] +
                output * self.pricing['output_usd_per_million']) / 1_000_000
        self.held -= reservation
        self.unsettled_requests -= 1
        self.estimated += cost
        if fingerprint is not None and len(self.measurements) < self.settings['requests']:
            self.measurements[fingerprint] = prompt
        if self.maximum_cost(prompt) > reservation:
            self.stopped = True  # Tokenizer/provider disagreement: reconcile usage, stop further sending.
        self.warn('cost', self.estimated + self.held, self.pricing['limit_usd'])

    def release(self, reservation):
        self.held -= reservation
        self.unsettled_requests -= 1

    def record(self):
        return {'event': 'api_budget', 'estimated_usd': str(self.estimated),
                'held_usd': str(self.held), 'pricing': {key: str(value) for key, value in self.pricing.items()},
                'warnings': sorted(self.warnings), 'accounting_exceeded': self.stopped,
                'unsettled_requests': self.unsettled_requests, 'count_basis': self.last_count_basis,
                'model_config': self.settings, 'tokenizer_revision': self.tokenizer_revision}

    def reserve(self, size):
        # Bound cumulative outbound JSON volume, independently of token usage.
        # This is an operational byte limit, not a monetary or token budget.
        amount = size
        if size > MAX_BYTES:
            raise Rejected('request_too_large')
        if self.requests >= self.settings['requests']:
            raise Rejected('request_limit')
        self.requests += 1
        self.reserved += amount
        self.warn('requests', self.requests, self.settings['requests'])
        self.warn('cumulative_bytes', self.reserved, MAX_RESERVED)
        self.warn('request_bytes', size, MAX_BYTES)


def prepare_request(raw, settings=None):
    settings = model_config() if settings is None else settings
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get('model') != MODEL:
        raise ValueError('Only deepseek-flash is allowed')
    # Rebuild the payload rather than forwarding arbitrary client parameters.
    return json.dumps({
        'model': MODEL,
        'messages': value['messages'],
        'tools': value.get('tools', []),
        'max_tokens': settings['output_tokens'],
        'stream': False,
        'thinking': {'type': settings['thinking']},
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
    counter = PromptCounter()
    received = 0
    attempted = 0

    @classmethod
    def status(cls, outcome, http_status=0, reason='none', request_bytes=0):
        # Never include URLs, headers, exception strings, or request/response bodies.
        print(json.dumps({'event': 'api_status', 'outcome': outcome,
                          'received': cls.received, 'attempted': cls.attempted,
                          'http_status': http_status, 'reason': reason,
                          'request_bytes': request_bytes, 'reserved': cls.budget.reserved,
                          'reserved_limit': MAX_RESERVED, 'request_limit': cls.budget.settings['requests']}), flush=True)
        print(json.dumps(cls.budget.record()), flush=True)

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
        reservation = None
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > MAX_BYTES:
                raise Rejected('invalid_request_size')
            raw = self.rfile.read(size)
            body = prepare_request(raw, self.budget.settings)
            payload = json.loads(body)
            fingerprint = hashlib.sha256(body).hexdigest()
            prompt_tokens = self.counter.count(payload)
            request = urllib.request.Request(
                'https://api.deepseek.com/chat/completions', data=body,
                headers={'Authorization': 'Bearer ' + os.environ['DEEPSEEK_API_KEY'],
                         'Content-Type': 'application/json'})
            try:
                reservation = self.budget.authorize(len(body), prompt_tokens, fingerprint)
            except Rejected as error:
                self.status('rejected', reason=error.reason, request_bytes=len(body))
                self.reply(400, {'error': error.reason})
                return
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
                    raw_response = response.read(MAX_RESPONSE_BYTES + 1)
                    if len(raw_response) > MAX_RESPONSE_BYTES:
                        raise ValueError
                    data = json.loads(raw_response)
                except (ValueError, UnicodeError):
                    self.status('invalid_response', status)
                    self.reply(502, {'error': 'Invalid upstream response'})
                    return
            record = usage_record(data, (time.monotonic() - started) * 1000)
            self.budget.settle(record, reservation, fingerprint)
            print(json.dumps(record), flush=True)
            print(json.dumps(self.budget.record()), flush=True)
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
            # Authentication, validation and rate-limit rejection have no completion usage.
            if reservation is not None and error.code in {400, 401, 403, 404, 422, 429}:
                self.budget.release(reservation)
            self.status('http_error', error.code)
            self.reply(502, {'error': f'DeepSeek HTTP {error.code}'})
        except (TimeoutError, socket.timeout):
            self.status('timeout')
            self.reply(504, {'error': 'DeepSeek timeout'})
        except urllib.error.URLError as error:
            if reservation is not None and isinstance(error.reason, (socket.gaierror, ConnectionRefusedError)):
                self.budget.release(reservation)  # Definitively failed before any HTTP request body.
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
    Handler.budget = Budget({key: str(value) for key, value in
                            cost_config(os.environ.get('LATCH_COST_CONFIG')).items()},
                            model_config(os.environ.get('LATCH_MODEL_CONFIG')))
    Handler.counter = PromptCounter(os.environ.get('LATCH_TOKENIZER_DIRECTORY'),
                                    os.environ.get('LATCH_TOKENIZER_SHA256'))
    Handler.budget.tokenizer_revision = Handler.counter.revision
    server = http.server.HTTPServer(('0.0.0.0', 8080), Handler)
    Handler.status('ready')
    server.serve_forever()
