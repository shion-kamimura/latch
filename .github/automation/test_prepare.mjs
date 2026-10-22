import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import prepare from './prepare.mjs';

const canonical =
  'feat/automated-' +
  crypto.createHash('sha256').update('node').digest('hex').slice(0, 16);
const marker = '<!-- latch-owner:node -->';
async function scenario({
  state = 'open',
  human = false,
  existing = true,
  draft = true,
  branchExists = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-prepare-'));
  const cwd = process.cwd();
  const oldEnv = { ...process.env };
  try {
    process.chdir(directory);
    Object.assign(process.env, {
      ISSUE_NUMBER: '7',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_TRIGGERING_ACTOR: 'owner',
    });
    const github = {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async () => ({
            data: { permission: 'write' },
          }),
          getCommit: async () => ({
            data: {
              committer: { login: human ? 'person' : 'github-actions[bot]' },
              commit: { message: 'old\n' + marker },
            },
          }),
        },
        issues: {
          get: async () => ({
            data: {
              number: 7,
              node_id: 'node',
              state: 'open',
              title: 'test',
              body: 'test',
            },
          }),
        },
        pulls: { list: () => {} },
        git: {
          getRef: async () => {
            if (!branchExists)
              throw Object.assign(new Error('missing'), { status: 404 });
            return { data: { object: { sha: 'b'.repeat(40) } } };
          },
        },
      },
      paginate: async () =>
        existing
          ? [
              {
                state,
                draft,
                user: { login: 'github-actions[bot]' },
                body: marker,
                head: {
                  ref: canonical,
                  sha: 'b'.repeat(40),
                  repo: { full_name: 'owner/repo' },
                },
              },
            ]
          : [],
    };
    await prepare({
      github,
      context: {
        ref: 'refs/heads/main',
        sha: 'a'.repeat(40),
        runId: 123,
        repo: { owner: 'owner', repo: 'repo' },
        actor: 'owner',
      },
      core: { setOutput() {} },
    });
    return JSON.parse(fs.readFileSync('request/issue.json', 'utf8'));
  } finally {
    process.chdir(cwd);
    process.env = oldEnv;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('owned draft continues from observed source', async () => {
  const request = await scenario();
  assert.equal(request.branch, canonical);
  assert.equal(request.source, 'b'.repeat(40));
  assert.equal(request.expected_head, request.source);
  assert.equal(request.base, 'a'.repeat(40));
});

test('human tip, closed history and ready PR use separate revision', async () => {
  for (const options of [
    { human: true },
    { state: 'closed', branchExists: true },
    { draft: false, branchExists: true },
  ]) {
    const request = await scenario(options);
    assert.equal(request.branch, canonical + '-r123-a2');
    assert.equal(request.expected_head, null);
    assert.equal(request.source, (options.human ? 'b' : 'a').repeat(40));
  }
});

test('stranded owned branch from failed PR API can resume', async () => {
  const request = await scenario({ existing: false, branchExists: true });
  assert.equal(request.branch, canonical);
  assert.equal(request.source, 'b'.repeat(40));
  assert.equal(request.expected_head, request.source);
});
