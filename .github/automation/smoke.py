"""Exercise pinned OpenCode against a local mock, with no API key or external network."""

import json
import io
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import uuid

from run import CHECKS, RUNTIME_ENV, agent_config


def main():
    name = 'smoke-' + uuid.uuid4().hex
    server, agent = name + '-api', name + '-agent'
    mock = '''
const http = require('node:http');
http.createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const data = JSON.parse(raw);
    if (data.model !== 'deepseek-flash') { res.writeHead(400); res.end(); return; }
    const choice = {index: 0, message: {role: 'assistant', content: 'smoke-ok'}, finish_reason: 'stop'};
    if (!data.stream) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({id: 'mock', object: 'chat.completion', choices: [choice]}));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    for (const delta of [{role: 'assistant', content: 'smoke-ok'}, {}]) {
      res.write('data: ' + JSON.stringify({id: 'mock', object: 'chat.completion.chunk', created: 0,
        model: 'deepseek-flash', choices: [{index: 0, delta, finish_reason: delta.content ? null : 'stop'}]}) + '\\n\\n');
    }
    res.end('data: [DONE]\\n\\n');
  });
}).listen(8080, '0.0.0.0');
'''
    def command(*args, **kwargs):
        return subprocess.run(['docker', *args], check=True, **kwargs)
    try:
        command('network', 'create', '--internal', name, stdout=subprocess.DEVNULL)
        command('run', '-d', '--name', server, '--network', name, '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--read-only', 'latch-agent',
                'node', '-e', mock, stdout=subprocess.DEVNULL)
        with tempfile.TemporaryDirectory() as work:
            Path(work, 'AGENTS.md').write_text('Reply smoke-ok without tools.\n')
            result = command('run', '--name', agent, '--network', name,
                *RUNTIME_ENV,
                '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
                '--user', f'{os.getuid()}:{os.getgid()}', '--memory=4g', '--pids-limit=256',
                '--tmpfs', '/tmp:rw,size=512m',
                '--tmpfs', f'/home/node:rw,uid={os.getuid()},gid={os.getgid()},size=512m',
                '--mount', f'type=bind,src={work},dst=/work',
                '-e', 'OPENCODE_CONFIG_CONTENT=' + agent_config(server),
                '-e', 'OPENCODE_DISABLE_DEFAULT_PLUGINS=true',
                '-e', 'OPENCODE_DISABLE_MODELS_FETCH=true',
                '-e', 'OPENCODE_DISABLE_AUTOUPDATE=true',
                'latch-agent', 'opencode', 'run', '--format', 'json',
                '--model', 'deepseek/deepseek-flash', 'Reply smoke-ok without tools.',
                capture_output=True, text=True, timeout=120)
            events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            if any(event.get('type') == 'error' for event in events) or 'smoke-ok' not in result.stdout:
                print(result.stdout)
                print(result.stderr)
                raise SystemExit('OpenCode mock smoke test failed')
            print('Pinned OpenCode completed an offline mock request successfully.')
        command('rm', '-f', agent, stdout=subprocess.DEVNULL)
        # Exercise the same copied dependency layout and offline checks used by
        # the real orchestrator, on the trusted PR snapshot without credentials.
        with tempfile.TemporaryDirectory() as work:
            archive = subprocess.check_output(['git', 'archive', 'HEAD'])
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(work, filter='data')
            for index, check in enumerate(CHECKS):
                setup = 'cp -a /opt/deps/node_modules /work/node_modules && ' if index == 0 else ''
                command('run', '--name', agent, '--network', 'none',
                    *RUNTIME_ENV,
                    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
                    '--user', f'{os.getuid()}:{os.getgid()}', '--memory=4g', '--pids-limit=256',
                    '--tmpfs', '/tmp:rw,size=512m',
                    '--tmpfs', f'/home/node:rw,uid={os.getuid()},gid={os.getgid()},size=512m',
                    '--mount', f'type=bind,src={work},dst=/work', 'latch-agent',
                    'sh', '-c', setup + 'exec pnpm ' + check, timeout=180)
                command('rm', '-f', agent, stdout=subprocess.DEVNULL)
    except subprocess.CalledProcessError as error:
        print(error.stdout or '')
        print(error.stderr or '')
        raise
    finally:
        for container in [agent, server]:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
