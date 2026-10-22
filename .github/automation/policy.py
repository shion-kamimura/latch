"""Repository policy evaluated only by the trusted base revision."""

import hashlib
import re
import unicodedata

AUTOMATION_CHECK = 'automation'
REQUIRED_SECTIONS = ['変更概要', '関連Issue', '実装内容', '実行したテスト', 'テスト結果', '未検証事項']
HUMAN_REVIEW = ['semantic_issue_scope', 'acceptance_criteria', 'prior_approvals',
                'generated_tests', 'automation_security', 'workflow_permissions']


class PolicyError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__('stage=repository_policy error=' + code)


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
    return title


def allowed(path, maintenance=False):
    if not isinstance(path, str) or len(path) > 200 or '\\' in path:
        return False
    if maintenance is True and path == '.github/pull_request_template.md':
        return True
    parts = path.split('/')
    if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', part)
           or part in {'.', '..'} for part in parts):
        return False
    if path == 'README.md':
        return True
    if len(parts) > 1 and parts[0] in {'src', 'tests', 'docs'}:
        return path.endswith(('.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.txt'))
    if maintenance is not True:
        return False
    if path == 'AGENTS.md':
        return True
    # Only these exact hidden directories are exceptions; traversal stays forbidden.
    return False


def maintenance_path(path):
    if not isinstance(path, str) or len(path) > 200 or '\\' in path:
        return False
    parts = path.split('/')
    if len(parts) != 3 or parts[0] != '.github':
        return False
    name = parts[2]
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
        return False
    return ((parts[1] == 'automation' and (name.endswith('.py') or name == 'Dockerfile'))
            or (parts[1] == 'workflows' and name.endswith(('.yml', '.yaml'))))


def allowed_change(path, maintenance=False):
    return allowed(path, maintenance) or (maintenance is True and maintenance_path(path))


def validate_request(request):
    if not isinstance(request, dict):
        raise PolicyError('invalid_request')
    number = request.get('number')
    if type(number) is not int or not 0 < number < 1_000_000_000:
        raise PolicyError('invalid_issue')
    if not isinstance(request.get('base'), str) or not re.fullmatch(r'[0-9a-f]{40}', request['base']):
        raise PolicyError('invalid_base')
    if not isinstance(request.get('branch'), str) or not re.fullmatch(r'feat/automated-[0-9a-f]{16}', request['branch']):
        raise PolicyError('invalid_branch')
    if type(request.get('allow_maintenance', False)) is not bool:
        raise PolicyError('invalid_maintenance_approval')
    if not all(isinstance(request.get(key), str) for key in ['title', 'body']):
        raise PolicyError('invalid_requirements')


def validate_issue(request, issue):
    validate_request(request)
    expected = 'feat/automated-' + hashlib.sha256(issue['node_id'].encode()).hexdigest()[:16]
    if issue['state'] != 'open' or 'pull_request' in issue or request['branch'] != expected:
        raise PolicyError('issue_mismatch')
    if request['title'] != issue['title'] or request['body'] != (issue.get('body') or ''):
        raise PolicyError('issue_changed')


def validate_files(files, maintenance=False):
    if not isinstance(files, list) or len(files) > 100:
        raise PolicyError('invalid_files')
    seen = set()
    for item in files:
        if not isinstance(item, dict) or set(item) != {'path', 'content'}:
            raise PolicyError('invalid_file')
        path, content = item['path'], item['content']
        if not allowed_change(path, maintenance) or path in seen:
            raise PolicyError('forbidden_path')
        if content is not None and (not isinstance(content, str) or '\x00' in content
                                    or len(content.encode('utf-8')) > 500_000):
            raise PolicyError('invalid_file_type')
        seen.add(path)


def validate_body(body, number):
    if not isinstance(body, str) or f'Closes #{number}\n' not in body:
        raise PolicyError('missing_issue_link')
    for section in REQUIRED_SECTIONS:
        if not re.search(r'^## ' + re.escape(section) + r'\n\n\S', body, re.MULTILINE):
            raise PolicyError('missing_pr_section')


def report(request, files, body=None):
    validate_request(request)
    validate_files(files, request.get('allow_maintenance', False))
    if body is not None:
        validate_body(body, request['number'])
    return {'schema_version': 1, 'status': 'passed',
            'mechanical_checks': ['request', 'branch', 'paths', 'file_types', 'issue_number']
                + (['issue_link', 'pr_body'] if body is not None else []),
            'scope_check': 'allowed_paths_only',
            'human_review_required': HUMAN_REVIEW,
            'maintenance_approved': request.get('allow_maintenance', False)}
