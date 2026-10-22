"""Exercise pinned OpenCode against a local mock, with no API key or external network."""

import json
import io
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import uuid

from run import CHECKS, RUNTIME_ENV, agent_config, agent_failure


def main():
    name = 'smoke-' + uuid.uuid4().hex
    server, agent = name + '-api', name + '-agent'
    mock = '''
const http = require('node:http');
let turn = 0;
http.createServer((req, res) => {
  console.log(req.url === '/v1/chat/completions' ? 'mock_request=chat' : 'mock_request=unsupported');
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const data = JSON.parse(raw);
    if (data.model !== 'deepseek-flash') { res.writeHead(400); res.end(); return; }
    console.log('mock_model=accepted');
    // Exercise the actual tools; a text-only mock cannot detect permission typos.
    const calls = [
      {name: 'bash', arguments: {command: 'printf smoke-command > /work/command.txt', description: 'Create smoke marker'}},
      {name: 'read', arguments: {filePath: '/work/note.txt'}},
      {name: 'edit', arguments: {filePath: '/work/note.txt', oldString: 'before', newString: 'after'}},
    ];
    // OpenCode also makes title/summary requests without tools. Those must not
    // consume a step in the agent's deterministic tool conversation.
    const isAgent = Array.isArray(data.tools) && data.tools.some(item => item.function?.name === 'read');
    const tool = isAgent ? calls[turn++] : null;
    const message = tool ? {role: 'assistant', content: null, tool_calls: [{id: 'call-' + turn,
      type: 'function', function: {name: tool.name, arguments: JSON.stringify(tool.arguments)}}]} :
      {role: 'assistant', content: 'smoke-ok'};
    const choice = {index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop'};
    if (!data.stream) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({id: 'mock', object: 'chat.completion', created: 0,
        model: 'deepseek-flash', choices: [choice], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const first = {...message};
    if (first.tool_calls) first.tool_calls = first.tool_calls.map((call, index) => ({...call, index}));
    for (const [delta, finish] of [[first, null], [{}, choice.finish_reason]]) {
      res.write('data: ' + JSON.stringify({id: 'mock', object: 'chat.completion.chunk', created: 0,
        model: 'deepseek-flash', choices: [{index: 0, delta, finish_reason: finish}]}) + '\\n\\n');
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
            Path(work, 'AGENTS.md').write_text('Use bash, read, and edit as requested, then reply smoke-ok.\n')
            Path(work, 'issue.json').write_text(json.dumps({'title': 'Exercise tools and reply smoke-ok.'}))
            Path(work, 'note.txt').write_text('before\n')
            command('run', '--rm', '--network', 'none', 'latch-agent',
                    'python3', '--version', stdout=subprocess.DEVNULL)
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
                '--model', 'deepseek/deepseek-flash', '--file', '/work/issue.json',
                '--', 'Exercise bash, read, and edit, then reply smoke-ok.',
                capture_output=True, text=True, timeout=120)
            events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            if any(event.get('type') == 'error' for event in events) or 'smoke-ok' not in result.stdout:
                raise SystemExit('OpenCode mock smoke test failed')
            if (not Path(work, 'command.txt').is_file() or
                    Path(work, 'command.txt').read_text() != 'smoke-command' or
                    Path(work, 'note.txt').read_text() != 'after\n'):
                print('Mock tool files: command_created=' + str(Path(work, 'command.txt').is_file()) +
                      ' edit_completed=' + str(Path(work, 'note.txt').read_text() == 'after\n'), flush=True)
                for event in events:
                    part = event.get('part', {})
                    if isinstance(part, dict) and part.get('tool') in {'bash', 'read', 'edit'}:
                        state = part.get('state', {})
                        if isinstance(state, dict) and state.get('status') in {'completed', 'error'}:
                            print('Mock tool=' + part['tool'] + ' status=' + state['status'], flush=True)
                raise SystemExit('OpenCode mock tool execution failed')
            print('Pinned OpenCode completed mock API calls and bash/read/edit successfully.')
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
        status = subprocess.run(['docker', 'logs', server], capture_output=True, text=True)
        for line in status.stdout.splitlines():
            if line in {'mock_request=chat', 'mock_request=unsupported', 'mock_model=accepted'}:
                print(line, flush=True)
        with tempfile.TemporaryDirectory() as diagnostic:
            log = Path(diagnostic, 'agent.log')
            log.write_text((error.stdout or '') + (error.stderr or ''))
            kind = agent_failure(log, error.returncode)
            for line in log.read_text().splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict) and event.get('type') == 'error':
                    detail = event.get('error')
                    detail = detail.get('data', {}) if isinstance(detail, dict) else {}
                    code = detail.get('statusCode') if isinstance(detail, dict) else None
                    if type(code) is int and 100 <= code <= 599:
                        print(f'Mock HTTP status={code}', flush=True)
        raise SystemExit(f'Mock smoke failed; error={kind} exit_code={error.returncode}') from None
    except subprocess.TimeoutExpired:
        raise SystemExit('Mock smoke failed; error=timeout') from None
    finally:
        for container in [agent, server]:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
