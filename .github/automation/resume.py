"""Authorize a main-origin artifact, check its archive digest, and read only data."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime

from candidate import TTL_SECONDS, validate_bundle
from policy import MAX_PROPOSAL_BYTES, PolicyError
from publish import api


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def inspect_origin():
    if os.environ['GITHUB_REF'] != 'refs/heads/main':
        raise PolicyError('main_required')
    for actor in {os.environ['GITHUB_ACTOR'], os.environ['GITHUB_TRIGGERING_ACTOR']}:
        if not re.fullmatch(r'[A-Za-z0-9-]{1,100}(?:\[bot\])?', actor):
            raise PolicyError('invalid_actor')
        if api('GET', '/collaborators/' + actor + '/permission')['permission'] not in {'admin', 'maintain', 'write'}:
            raise PolicyError('write_permission_required')
    run_id, attempt = os.environ['ORIGIN_RUN_ID'], os.environ['ORIGIN_ATTEMPT']
    if not all(re.fullmatch(r'[1-9][0-9]{0,19}', value) for value in [run_id, attempt]):
        raise PolicyError('invalid_origin')
    run = api('GET', '/actions/runs/' + run_id)
    if (str(run['id']) != run_id or run['repository']['full_name'] != os.environ['GITHUB_REPOSITORY']
            or str(run['repository']['id']) != os.environ['GITHUB_REPOSITORY_ID']
            or run['head_repository']['id'] != run['repository']['id']
            or run['event'] != 'workflow_dispatch' or run['head_branch'] != 'main'
            or run['path'] != '.github/workflows/issue-draft-pr.yml'
            or not re.fullmatch(r'[0-9a-f]{40}', run['head_sha'])
            or int(attempt) > run['run_attempt']):
        raise PolicyError('untrusted_origin')
    # The candidate's own creation deadline is also checked after downloading.
    return run


def find_artifact(run_id, attempt):
    name = f'issue-candidate-{run_id}-{attempt}'
    matches = []
    for page in range(1, 101):
        items = api('GET', f'/actions/runs/{run_id}/artifacts?per_page=100&page={page}')['artifacts']
        matches.extend(item for item in items if item['name'] == name)
        if len(items) < 100:
            break
    else:
        raise PolicyError('artifact_lookup_limit')
    if len(matches) != 1:
        raise PolicyError('candidate_missing')
    artifact = matches[0]
    now = time.time()
    if (artifact['expired'] or now >= timestamp(artifact['expires_at'])
            or now - timestamp(artifact['created_at']) >= TTL_SECONDS):
        raise PolicyError('candidate_expired')
    if (not 0 < artifact['size_in_bytes'] <= MAX_PROPOSAL_BYTES + 1024 * 1024
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', artifact.get('digest') or '')):
        raise PolicyError('invalid_artifact')
    return artifact


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def download_archive(artifact):
    # Authorization is used only on api.github.com; never forward it to blob storage.
    url = 'https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + '/actions/artifacts/' + str(artifact['id']) + '/zip'
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                                                  'Accept': 'application/vnd.github+json'})
    try:
        response = urllib.request.build_opener(NoRedirect).open(request, timeout=60)
    except urllib.error.HTTPError as error:
        location = error.headers.get('Location', '')
        if error.code != 302 or not location.startswith('https://'):
            raise PolicyError('artifact_download_failed') from None
        response = urllib.request.urlopen(location, timeout=60)
    with response:
        data = response.read(MAX_PROPOSAL_BYTES + 1024 * 1024 + 1)
    if ('sha256:' + hashlib.sha256(data).hexdigest() != artifact['digest']
            or len(data) != artifact['size_in_bytes']):
        raise PolicyError('artifact_digest_mismatch')
    return data


def decode_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if (len(members) != 1 or members[0].filename != 'candidate.json'
                or members[0].file_size > MAX_PROPOSAL_BYTES
                or members[0].external_attr >> 16 & 0o170000 == 0o120000):
            raise PolicyError('invalid_artifact_archive')
        # Read a bounded, allowlisted member; never extract paths from the archive.
        with archive.open(members[0]) as source:
            value = source.read(MAX_PROPOSAL_BYTES + 1)
        if len(value) > MAX_PROPOSAL_BYTES:
            raise PolicyError('invalid_artifact_archive')
        return json.loads(value)


def main():
    run = inspect_origin()
    if '--inspect' in sys.argv:
        bundle = None
    else:
        artifact = find_artifact(os.environ['ORIGIN_RUN_ID'], os.environ['ORIGIN_ATTEMPT'])
        bundle = decode_archive(download_archive(artifact))
        validate_bundle(bundle, os.environ['GITHUB_REPOSITORY'], os.environ['ORIGIN_RUN_ID'],
                        os.environ['ORIGIN_ATTEMPT'], run['head_sha'])
        output = Path(os.environ['BUNDLE_PATH'])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(bundle) + '\n')
        output.with_name('issue.json').write_text(json.dumps(bundle['request']) + '\n')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('base=' + run['head_sha'] + '\n')
            if bundle:
                output.write('source=' + bundle['manifest']['source'] + '\n')


if __name__ == '__main__':
    try:
        main()
    except PolicyError as error:
        raise SystemExit('stage=resume error=' + error.code + '; no AI restart') from None
    except (KeyError, ValueError, OSError, zipfile.BadZipFile, urllib.error.URLError):
        raise SystemExit('stage=resume error=candidate_unavailable_or_invalid; no AI restart, inspect origin and expiry') from None
