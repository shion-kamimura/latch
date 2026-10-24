"""Versioned, bounded data contract; an artifact never grants execution authority."""
import hashlib
import json
import os
from pathlib import Path
import re
import time

from policy import PolicyError, MAX_PROPOSAL_BYTES, validate_files, validate_pr_title, validate_request

TTL_SECONDS = 86400
IMPLEMENTATIONS = {'completed', 'timeout', 'api_error', 'startup_error', 'abnormal_exit', 'agent_error',
                   'configuration_error', 'model_configuration_error', 'provider_initialization_error', 'host_io_error'}
CONTROL_FILES = ['candidate.py', 'run.py', 'verify.py', 'resume.py', 'publish.py', 'policy.py', 'registry.py', 'Dockerfile']


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()


def control_digest():
    root = Path(__file__).parent
    return digest({name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in CONTROL_FILES})


def snapshot_digest(snapshot):
    return hashlib.sha256(json.dumps({path: [item.digest, item.mode] for path, item in sorted(snapshot.items())},
                                     sort_keys=True).encode()).hexdigest()


def read_json(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_PROPOSAL_BYTES:
        raise PolicyError('invalid_candidate_file')
    return json.loads(path.read_text())


def validate_bundle(bundle, repository, origin_run, origin_attempt, base, now=None):
    if not isinstance(bundle, dict) or set(bundle) != {'manifest', 'request', 'candidate'}:
        raise PolicyError('invalid_candidate_bundle')
    manifest, request, candidate = bundle['manifest'], bundle['request'], bundle['candidate']
    validate_request(request)
    keys = {'schema_version', 'repository', 'origin_run', 'origin_attempt', 'base', 'source', 'created_at',
            'expires_at', 'request_digest', 'candidate_digest', 'snapshot_digest', 'control_digest', 'agent_image'}
    if (not isinstance(manifest, dict) or set(manifest) != keys or type(manifest['schema_version']) is not int or manifest['schema_version'] != 1
            or manifest['repository'] != repository or manifest['origin_run'] != str(origin_run)
            or manifest['origin_attempt'] != str(origin_attempt) or manifest['base'] != base
            or request['base'] != base or manifest['source'] != request.get('source', base)):
        raise PolicyError('candidate_identity_mismatch')
    if (not isinstance(candidate, dict) or set(candidate) != {'files', 'implementation', 'pr_title'}
            or not isinstance(candidate['implementation'], str) or candidate['implementation'] not in IMPLEMENTATIONS):
        raise PolicyError('invalid_candidate')
    validate_files(candidate['files'])
    if candidate['files']:
        validate_pr_title(candidate['pr_title'])
    now = time.time() if now is None else now
    if (type(manifest['created_at']) is not int or type(manifest['expires_at']) is not int
            or manifest['expires_at'] != manifest['created_at'] + TTL_SECONDS
            or manifest['created_at'] > now + 60 or now >= manifest['expires_at']):
        raise PolicyError('candidate_expired')
    if (manifest['request_digest'] != digest(request) or manifest['candidate_digest'] != digest(candidate)
            or not all(isinstance(manifest[key], str) and re.fullmatch(r'[0-9a-f]{64}', manifest[key])
                       for key in ['snapshot_digest', 'control_digest'])
            or not isinstance(manifest['agent_image'], str)
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', manifest['agent_image'])):
        raise PolicyError('candidate_digest_mismatch')
    return bundle


def save_bundle(output, request, files, implementation, title, snapshot):
    import subprocess
    candidate = {'files': files, 'implementation': implementation, 'pr_title': title}
    created = int(time.time())
    manifest = {'schema_version': 1, 'repository': os.environ['GITHUB_REPOSITORY'],
                'origin_run': os.environ['GITHUB_RUN_ID'], 'origin_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
                'base': request['base'], 'source': request.get('source', request['base']),
                'created_at': created, 'expires_at': created + TTL_SECONDS,
                'request_digest': digest(request), 'candidate_digest': digest(candidate),
                'snapshot_digest': snapshot_digest(snapshot), 'control_digest': control_digest(),
                'agent_image': subprocess.check_output(['docker', 'image', 'inspect', 'latch-agent', '--format', '{{.Id}}'], text=True).strip()}
    bundle = {'manifest': manifest, 'request': request, 'candidate': candidate}
    validate_bundle(bundle, manifest['repository'], manifest['origin_run'], manifest['origin_attempt'], manifest['base'])
    text = json.dumps(bundle) + '\n'
    if len(text.encode()) > MAX_PROPOSAL_BYTES:
        raise PolicyError('proposal_too_large')
    temporary = Path(output, 'candidate.json.tmp')
    temporary.write_text(text)
    temporary.replace(Path(output, 'candidate.json'))
    return bundle


def validate_proposal(proposal, request, repository, run_id, attempt):
    bundle = {'manifest': proposal['candidate_manifest'], 'request': request,
              'candidate': {key: proposal[key] for key in ['files', 'implementation', 'pr_title']}}
    m = bundle['manifest']
    validate_bundle(bundle, repository, m['origin_run'], m['origin_attempt'], request['base'])
    if m['control_digest'] != control_digest():
        raise PolicyError('verification_policy_mismatch')
    expected = {'candidate_digest': m['candidate_digest'], 'request_digest': m['request_digest'],
                'snapshot_digest': m['snapshot_digest'], 'base': m['base'], 'source': m['source'],
                'control_digest': m['control_digest'], 'run_id': str(run_id), 'attempt': str(attempt)}
    v = proposal.get('validation', {})
    if (set(v) != set(expected) | {'image'} or any(v.get(k) != value for k, value in expected.items())
            or not isinstance(v['image'], str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', v['image'])):
        raise PolicyError('validation_identity_mismatch')
    return bundle
