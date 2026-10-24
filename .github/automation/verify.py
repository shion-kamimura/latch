"""Credential-free verification of a saved candidate using its original control base."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import uuid

import candidate
from policy import PolicyError, file_bytes, validate_link
import run


def materialize(source, destination, files):
    before = run.snapshot(source)
    entries = dict(before)
    for item in files:
        if item['content'] is None:
            entries.pop(item['path'], None)
        else:
            entries[item['path']] = item
    for path in entries:
        if any(parent.as_posix() in entries for parent in Path(path).parents if parent.as_posix() != '.'):
            raise PolicyError('candidate_path_collision')
    for path, item in entries.items():
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        mode = item.mode if isinstance(item, run.SourceFile) else item.get('mode', '100644')
        if mode == '120000':
            value = item.read() if isinstance(item, run.SourceFile) else file_bytes(item)
            validate_link(path, value.decode())
            target.symlink_to(value.decode())
        elif isinstance(item, run.SourceFile):
            shutil.copyfile(item.path, target)
            target.chmod(0o755 if mode == '100755' else 0o644)
        else:
            target.write_bytes(file_bytes(item))
            target.chmod(0o755 if mode == '100755' else 0o644)
    return before, run.snapshot(destination)


def main():
    # No provider key, gateway, OpenCode startup or agent invocation exists on this path.
    bundle = candidate.read_json(os.environ['BUNDLE_PATH'])
    manifest, request, data = bundle['manifest'], bundle['request'], bundle['candidate']
    base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    candidate.validate_bundle(bundle, os.environ['GITHUB_REPOSITORY'], os.environ['ORIGIN_RUN_ID'],
                              os.environ['ORIGIN_ATTEMPT'], base)
    if candidate.control_digest() != manifest['control_digest']:
        raise PolicyError('verification_policy_mismatch')
    output = Path(os.environ['OUTPUT_PATH'])
    output.mkdir(parents=True, exist_ok=True)
    control = Path(__file__).resolve().parent
    name = 'latch-verify-' + uuid.uuid4().hex
    registry, network = name + '-registry', name + '-dependencies'
    containers = []
    checks = {check: run.check_result() for check in [*run.CHECKS, 'dependencies']}
    with tempfile.TemporaryDirectory() as temporary:
        source, work = Path(temporary, 'source'), Path(temporary, 'work')
        source.mkdir()
        work.mkdir()
        archive = subprocess.check_output(['git', '-C', os.environ['CANDIDATE_PATH'], 'archive', manifest['source']])
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(source, filter='data')
        before, generated = materialize(source, work, data['files'])
        if candidate.snapshot_digest(generated) != manifest['snapshot_digest']:
            raise PolicyError('candidate_source_mismatch')
        image = subprocess.check_output(['docker', 'image', 'inspect', 'latch-agent', '--format', '{{.Id}}'], text=True).strip()
        uid, gid = os.getuid(), os.getgid()
        common = [*run.RUNTIME_ENV, *run.DOCKER_LOG_LIMITS, '--cap-drop=ALL', '--security-opt=no-new-privileges',
                  '--pids-limit=256', '--memory=4g', '--cpus=2', '--read-only', '--user', f'{uid}:{gid}',
                  '--tmpfs', '/tmp:rw,nosuid,size=512m', '--tmpfs', f'/home/node:rw,nosuid,uid={uid},gid={gid},size=512m',
                  '--mount', f'type=bind,src={work},dst=/work', '-w', '/work']
        try:
            run.execute(['docker', 'pull', 'python:3.12.12-slim-bookworm'], stdout=subprocess.DEVNULL)
            run.execute(['docker', 'network', 'create', '--internal', network], stdout=subprocess.DEVNULL)
            run.execute(['docker', 'create', *run.DOCKER_LOG_LIMITS, '--name', registry, '--network', 'bridge',
                         '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--user', '65534:65534',
                         '--memory=128m', '--cpus=1', '--pids-limit=64', '--mount',
                         f'type=bind,src={control / "registry.py"},dst=/registry.py,readonly',
                         'python:3.12.12-slim-bookworm', 'python', '-B', '/registry.py'], stdout=subprocess.DEVNULL)
            run.execute(['docker', 'network', 'connect', network, registry])
            run.execute(['docker', 'start', registry], stdout=subprocess.DEVNULL)
            cache = Path(os.environ['DEPENDENCY_STORE_PATH']) if os.environ.get('DEPENDENCY_STORE_PATH') else None
            checks = run.verify_checks(work, common, registry, network, name, temporary, data['files'], containers, control, base_store=cache)
            value = run.save_proposal(Path(temporary), before, work, generated, data['files'], checks, data['implementation'], data['pr_title'])
            # Schema 3 is explicitly bound; do not interpret a new bundle as a legacy proposal.
            value.update(schema_version=3, candidate_manifest=manifest,
                         validation={key: manifest[key] for key in ['candidate_digest', 'request_digest', 'snapshot_digest', 'base', 'source', 'control_digest']})
            value['validation'].update(run_id=os.environ['GITHUB_RUN_ID'], attempt=os.environ['GITHUB_RUN_ATTEMPT'], image=image)
            candidate.validate_proposal(value, request, os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
            serialized = json.dumps(value) + '\n'
            if len(serialized.encode()) > run.MAX_PROPOSAL_BYTES:
                raise PolicyError('proposal_too_large')
            # Only publish a complete schema 3 after all identity checks.
            target = output / 'proposal.json.tmp'
            target.write_text(serialized)
            target.replace(output / 'proposal.json')
            if not all(item['status'] == 'passed' or item['reason'] == 'covered_by_test' for item in checks.values()) and data['files']:
                raise ValueError('partial_results')
        except PolicyError:
            (output / 'proposal.json').unlink(missing_ok=True)
            raise
        finally:
            for container in containers + [registry]:
                subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            run.save_execution(output, temporary, request, checks, generated, before, artifact_prefix='issue-validation-diagnostics')


if __name__ == '__main__':
    try:
        main()
    except PolicyError as error:
        raise SystemExit('stage=verification error=' + error.code + '; no AI restart') from None
    except (KeyError, ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit('stage=verification error=verification_incomplete; inspect safe diagnostics, retry saved candidate without AI') from None
