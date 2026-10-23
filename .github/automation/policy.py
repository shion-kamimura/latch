"""Repository policy evaluated only by the trusted base revision."""

import base64
import hashlib
import json
import posixpath
import re
import unicodedata

AUTOMATION_CHECK = 'automation'
REQUIRED_SECTIONS = ['変更概要', '関連Issue', '実装内容', '実行したテスト', 'テスト結果', '未検証事項']
HUMAN_REVIEW = ['semantic_issue_scope', 'acceptance_criteria', 'prior_approvals',
                'generated_tests', 'automation_security', 'workflow_permissions']


class PolicyError(ValueError):
    def __init__(self, code, path=None):
        self.code = code
        self.path = safe_path(path) if path is not None else None
        super().__init__('stage=repository_policy error=' + code)


MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_PROPOSAL_BYTES = 32 * 1024 * 1024
MAX_CHANGED_FILES = 1000


def secret_present(data):
    # Deliberately limited detector, not a proof that arbitrary data is secret-free.
    text = data.decode('utf-8', errors='replace') if isinstance(data, bytes) else data
    return bool(re.search(r'-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{64,}-----END (?:[A-Z]+ )*PRIVATE KEY-----|'

                          r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b|'
                          r'(?i:(?:api[_-]?key|access[_-]?token|password|secret)["\']?\s*[=:]\s*["\']?(?!dummy|example|test|placeholder|changeme|\$)[A-Za-z0-9_+/=-]{20,})', text))


def safe_path(path):
    if not isinstance(path, str):
        return '[invalid path]'
    if secret_present(path):
        return '[redacted path]'
    return json.dumps(path[:1024], ensure_ascii=True)


def validate_pr_title(title):
    # Titles are untrusted text for the GitHub API, never shell/code input.
    if (not isinstance(title, str) or not 1 <= len(title) <= 256
            or any(unicodedata.category(char).startswith('C') or
                   unicodedata.category(char) in {'Zl', 'Zp'} for char in title)):
        raise PolicyError('invalid_pr_title')
    match = re.fullmatch(r'(feat|fix|docs|refactor|test|ci|chore): (\S(?:.*\S)?)', title)
    if not match or match[2] != match[2].strip():
        raise PolicyError('invalid_pr_title')
    if re.fullmatch(r'(?:(?:implement\s+)?Issue\s*)?#\d+|implement requested changes', match[2], re.IGNORECASE):
        raise PolicyError('invalid_pr_title')
    if secret_present(title):
        raise PolicyError('invalid_pr_title')
    return title


def allowed(path, maintenance=False):
    # maintenance is a deprecated no-op retained for old requests.
    try:
        encoded_length = len(path.encode('utf-8')) if isinstance(path, str) else 0
    except UnicodeError:
        return False
    if (not isinstance(path, str) or not path or encoded_length > 4096
            or '\\' in path or any(ord(c) < 32 or ord(c) == 127 for c in path)):
        return False
    parts = path.split('/')
    return (not re.match(r'^[A-Za-z]:', path)
            and all(part and part not in {'.', '..'} and part.casefold() != '.git' for part in parts))


def maintenance_path(path):
    return path == 'AGENTS.md' or path.startswith('.github/')


def allowed_change(path, maintenance=False):
    return allowed(path)


def validate_link(path, target):
    if (not isinstance(target, str) or not target or target.startswith('/') or '\\' in target
            or re.match(r'^[A-Za-z]:', target)
            or any(ord(c) < 32 or ord(c) == 127 for c in target)):
        raise PolicyError('unsafe_link', path)
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
    if not allowed(resolved):
        raise PolicyError('unsafe_link', path)


def file_bytes(item):
    value = item['content']
    if not isinstance(value, str):
        raise PolicyError('invalid_file_type', item.get('path'))
    encoding = item.get('encoding', 'utf-8')
    try:
        if encoding == 'base64':
            return base64.b64decode(value, validate=True)
        if encoding == 'utf-8' and '\x00' not in value:
            return value.encode('utf-8')
    except (ValueError, UnicodeError):
        pass
    raise PolicyError('invalid_file_type', item.get('path'))


def validate_request(request):
    if not isinstance(request, dict):
        raise PolicyError('invalid_request')
    number = request.get('number')
    if type(number) is not int or not 0 < number < 1_000_000_000:
        raise PolicyError('invalid_issue')
    if not isinstance(request.get('base'), str) or not re.fullmatch(r'[0-9a-f]{40}', request['base']):
        raise PolicyError('invalid_base')
    if not isinstance(request.get('branch'), str) or not re.fullmatch(r'feat/automated-[0-9a-f]{16}(?:-r[0-9]+-a[0-9]+)?', request['branch']):
        raise PolicyError('invalid_branch')
    for key in ['source', 'expected_head']:
        if request.get(key) is not None and (not isinstance(request[key], str) or not re.fullmatch(r'[0-9a-f]{40}', request[key])):
            raise PolicyError('invalid_base')
    if 'node_id' in request and (not isinstance(request['node_id'], str) or not re.fullmatch(r'[A-Za-z0-9_=-]{1,200}', request['node_id'])):
        raise PolicyError('invalid_issue')
    if type(request.get('allow_maintenance', False)) is not bool:
        raise PolicyError('invalid_maintenance_approval')
    if not all(isinstance(request.get(key), str) for key in ['title', 'body']):
        raise PolicyError('invalid_requirements')


def validate_issue(request, issue):
    validate_request(request)
    expected = 'feat/automated-' + hashlib.sha256(issue['node_id'].encode()).hexdigest()[:16]
    if ('pull_request' in issue or request['branch'].split('-r')[0] != expected
            or request.get('node_id', issue['node_id']) != issue['node_id']):
        raise PolicyError('issue_mismatch')
    if issue['state'] != 'open':
        return 'closed'
    current = (issue['title'], issue.get('body') or '')
    original = (request['title'], request['body'])
    if current == original:
        return 'unchanged'
    if tuple(' '.join(value.split()) for value in current) == tuple(' '.join(value.split()) for value in original):
        return 'format_only'
    return 'changed'


def validate_files(files, maintenance=False):
    if not isinstance(files, list) or len(files) > MAX_CHANGED_FILES:
        raise PolicyError('invalid_files')
    if len(json.dumps(files).encode()) > MAX_PROPOSAL_BYTES:
        raise PolicyError('proposal_too_large')
    seen = set()
    for item in files:
        if (not isinstance(item, dict) or not {'path', 'content'} <= set(item)
                or set(item) - {'path', 'content', 'encoding', 'mode'}):
            raise PolicyError('invalid_file')
        path, content = item['path'], item['content']
        if not allowed_change(path) or path in seen:
            raise PolicyError('forbidden_path', path)
        if secret_present(path):
            raise PolicyError('secret_detected')
        if item.get('mode', '100644') not in {'100644', '100755', '120000'}:
            raise PolicyError('invalid_file_type', path)
        if content is not None:
            data = file_bytes(item)
            if len(data) > MAX_FILE_BYTES:
                raise PolicyError('file_too_large', path)
            if secret_present(data):
                raise PolicyError('secret_detected', path)
            if item.get('mode') == '120000':
                try:
                    validate_link(path, data.decode('utf-8'))
                except UnicodeError:
                    raise PolicyError('unsafe_link', path) from None
        seen.add(path)
    # Reject links which resolve transitively through another proposed link.
    links = {item['path']: file_bytes(item).decode('utf-8') for item in files
             if item.get('mode') == '120000' and item['content'] is not None}
    for path, target in links.items():
        current = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
        visited = {path}
        for _ in range(len(links) + 1):
            prefix = next((p for p in links if current == p or current.startswith(p + '/')), None)
            if prefix is None:
                break
            if prefix in visited:
                raise PolicyError('unsafe_link', path)
            visited.add(prefix)
            current = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), links[prefix],
                                                       posixpath.relpath(current, prefix)))
            if not allowed(current):
                raise PolicyError('unsafe_link', path)


def validate_body(body, number):
    if not isinstance(body, str) or not re.search(r'^(?:Closes|Refs) #' + str(number) + r'$', body, re.MULTILINE):
        raise PolicyError('missing_issue_link')


def report(request, files, body=None):
    validate_request(request)
    validate_files(files, request.get('allow_maintenance', False))
    if body is not None:
        validate_body(body, request['number'])
    return {'schema_version': 1, 'status': 'passed',
            'mechanical_checks': ['request', 'branch', 'paths', 'file_types', 'issue_number']
                + (['issue_link', 'pr_body'] if body is not None else []),
            'scope_check': 'repository_boundary_only',
            'human_review_required': HUMAN_REVIEW,
            'maintenance_gate': 'removed',
            'warnings': (['large_change'] if len(files) > 100 or len(json.dumps(files).encode()) > 1024 * 1024 else [])}
