"""Real pnpm cold/warm and failure checks, using disposable credential-free containers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

from run import (RUNTIME_ENV, clone_store, dependency_command, diagnostic_command,
                 prepare_dependencies, stop_container)

LOCK = '''lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      is-number:
        specifier: 7.0.0
        version: 7.0.0
packages:
  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}
snapshots:
  is-number@7.0.0: {}
'''


def main():
    name = 'deps-smoke-' + uuid.uuid4().hex
    registry, network = name + '-registry', name + '-network'
    containers = [registry]
    control = Path(__file__).resolve().parent
    def execute(args):
        return subprocess.run(args, check=True, stdout=subprocess.DEVNULL, timeout=60)
    try:
        execute(['docker', 'pull', 'python:3.12.12-slim-bookworm'])
        execute(['docker', 'network', 'create', '--internal', network])
        execute(['docker', 'create', '--name', registry, '--network', 'bridge', '--read-only',
                 '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', '65534:65534',
                 '--mount', f'type=bind,src={control / "registry.py"},dst=/registry.py,readonly',
                 'python:3.12.12-slim-bookworm', 'python', '-B', '/registry.py'])
        execute(['docker', 'network', 'connect', network, registry])
        execute(['docker', 'start', registry])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            work = root / 'work'; work.mkdir()
            manifest = {'name': 'dependency-smoke', 'version': '1.0.0', 'private': True,
                        'packageManager': 'pnpm@12.14.0', 'dependencies': {'is-number': '7.0.0'}}
            (work / 'package.json').write_text(json.dumps(manifest))
            (work / 'pnpm-lock.yaml').write_text(LOCK)
            (work / '.pnpmfile.cjs').write_text('throw Error("networked_hook_must_not_run");')
            (work / 'node_modules').mkdir()
            (work / 'node_modules/tampered').touch()
            uid, gid = os.getuid(), os.getgid()
            common = [*RUNTIME_ENV, '--cap-drop=ALL', '--security-opt=no-new-privileges',
                      '--read-only', '--user', f'{uid}:{gid}', '--pids-limit=128', '--memory=1g', '--cpus=1',
                      '--tmpfs', '/tmp:rw,nosuid,size=256m',
                      '--tmpfs', f'/home/node:rw,nosuid,uid={uid},gid={gid},size=128m',
                      '--mount', f'type=bind,src={work},dst=/work', '-w', '/work']
            stores, results = [], []
            for state in ['cold', 'warm']:
                install = name + '-' + state
                containers.extend([install, install + '-runtime', install + '-scripts'])
                store = prepare_dependencies(work, common, registry, network, install, root,
                                             store=stores[0] if stores else None)
                stores.append(store)
                if (work / 'node_modules/tampered').exists():
                    raise AssertionError('agent_modules_retained')
                check = name + '-check-' + state
                containers.append(check)
                try:
                    execute(['docker', 'run', '--name', check, '--network', 'none', *common, 'latch-agent',
                             'node', '-e', "const n=require('is-number'); if(!n(42)||n('bad')) process.exit(1)"])
                finally:
                    stop_container(check)
                result = json.loads((root / 'dependency_fetch.safe.json').read_text())
                results.append({key: result[key] for key in ['elapsed_ms', 'downloaded', 'reused', 'added']})
                print('dependency_smoke cache=' + state + ' check=passed metrics=' + json.dumps(results[-1]), flush=True)
            if not results[0]['downloaded'] or results[1]['downloaded'] != 0 or not results[1]['reused']:
                raise AssertionError('cold_warm_fetch_difference_not_observed')
            # Mutating a consumer copy cannot poison the saved producer's bytes.
            copy = root / 'tampered-store'
            clone_store(stores[0], copy)
            entry = next(path for path in copy.rglob('*') if path.is_file())
            relative = entry.relative_to(copy)
            original = (stores[0] / relative).read_bytes()
            entry.write_bytes(b'consumer-tampering')
            if (stores[0] / relative).read_bytes() != original:
                raise AssertionError('shared_store_mutated')
            install = name + '-corrupt-cache'
            containers.extend([install, install + '-runtime', install + '-scripts'])
            prepare_dependencies(work, common, registry, network, install, root, store=copy)
            print('dependency_smoke corrupt_cache=recovered', flush=True)
            manifest['dependencies']['is-number'] = '8.0.0'
            (work / 'package.json').write_text(json.dumps(manifest))
            install = name + '-mismatch'
            containers.extend([install, install + '-runtime', install + '-scripts'])
            try:
                prepare_dependencies(work, common, registry, network, install, root, store=stores[0])
                raise AssertionError('lockfile_mismatch_accepted')
            except ValueError as error:
                if str(error) != 'stage=dependencies error=dependency_mismatch':
                    raise
            print('dependency_smoke lockfile_mismatch=classified', flush=True)
            # A changed candidate manifest + regenerated lock can fetch a new dependency.
            manifest['dependencies'] = {'is-number': '7.0.0', 'is-odd': '3.0.1'}
            (work / 'package.json').write_text(json.dumps(manifest))
            lock = name + '-new-lock'
            containers.append(lock)
            lock_command = dependency_command(network, common, registry, lock)
            lock_command = [arg.replace('--store-dir=/pnpm/store', '--store-dir=/tmp/lock-store')
                            for arg in lock_command if arg != '--frozen-lockfile'] + ['--lockfile-only']
            result = diagnostic_command(lock_command, root / 'new-lock.log', 'dependency_fetch', 90)
            stop_container(lock)
            if result.returncode:
                raise AssertionError('fixture_lock_generation_failed')
            install = name + '-new-dependency'
            containers.extend([install, install + '-runtime', install + '-scripts'])
            prepare_dependencies(work, common, registry, network, install, root, store=stores[0])
            if not (work / 'node_modules/is-odd').exists():
                raise AssertionError('new_dependency_missing')
            print('dependency_smoke new_dependency=installed', flush=True)
            manifest['scripts'] = {'postinstall': 'node -e "process.exit(19)"'}
            (work / 'package.json').write_text(json.dumps(manifest))
            install = name + '-lifecycle'
            containers.extend([install, install + '-runtime', install + '-scripts'])
            try:
                prepare_dependencies(work, common, registry, network, install, root, store=stores[0])
                raise AssertionError('lifecycle_failure_ignored')
            except ValueError as error:
                if str(error) != 'stage=dependencies error=install_script_failed':
                    raise
            print('dependency_smoke lifecycle_failure=classified', flush=True)
    finally:
        for container in containers:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
