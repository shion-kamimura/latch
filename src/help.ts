export function getHelp(): string {
  return [
    'Latch',
    '',
    'Evidence-based verification for AI-generated code.',
    '',
    'Usage: latch [options]',
    '       latch verify [options]',
    '',
    'Options:',
    '  -h, --help     Show this help message',
    '  -v, --version  Show the CLI version',
    '',
    'Verify options:',
    '  --base <ref>                Compare with a branch, tag, or commit',
    '  --issue-file <path>         Read requirements from a local Markdown file',
    '  --include-untracked <path>  Include one explicitly named untracked file',
    '  --json                      Print the resolved inputs as JSON',
    '',
    'The verify command currently resolves inputs only. Requirement verification',
    'is not implemented yet, so it does not report verification success.',
    '',
  ].join('\n');
}
