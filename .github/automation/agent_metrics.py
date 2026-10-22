"""Private OpenCode output stays private; emit counts from its local session only."""

import json
import re
import subprocess
import sys
import tempfile


def session_counts(data):
    messages = data.get('messages', [])
    summaries = sum(item.get('info', {}).get('summary') is True and
                    not item.get('info', {}).get('error') and
                    item.get('info', {}).get('time', {}).get('completed') is not None
                    for item in messages)
    pruned = sum(part.get('type') == 'tool' and
                 bool(part.get('state', {}).get('time', {}).get('compacted'))
                 for item in messages for part in item.get('parts', []))
    return {'event': 'agent_metrics', 'compactions': summaries, 'pruned_tools': pruned}


def main():
    session = None
    process = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE)
    for line in process.stdout:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
        if len(line) > 100_000:
            continue
        try:
            event = json.loads(line)
            candidate = event.get('sessionID')
            if isinstance(candidate, str) and re.fullmatch(r'ses_[A-Za-z0-9]+', candidate):
                session = candidate
        except (ValueError, AttributeError):
            pass
    code = process.wait()
    metrics = {'event': 'agent_metrics', 'compactions': None, 'pruned_tools': None}
    if session:
        try:
            # Never relay the export or its stderr: both can contain private text.
            with tempfile.TemporaryFile() as export:
                result = subprocess.run(['opencode', 'export', session], stdout=export,
                                        stderr=subprocess.DEVNULL, timeout=30)
                if result.returncode == 0 and export.tell() <= 32 * 1024 * 1024:
                    export.seek(0)
                    metrics = session_counts(json.load(export))
        except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired):
            pass
    print(json.dumps(metrics), flush=True)
    raise SystemExit(code)


if __name__ == '__main__':
    main()
