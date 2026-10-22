import fs from 'node:fs';
import crypto from 'node:crypto';
import process from 'node:process';

export default async function prepare({ github, context, core }) {
  if (context.ref !== 'refs/heads/main') throw new Error('Run only from main');
  if (!/^[1-9][0-9]{0,8}$/.test(process.env.ISSUE_NUMBER))
    throw new Error('Invalid Issue number');
  const repo = context.repo;
  for (const username of new Set([
    context.actor,
    process.env.GITHUB_TRIGGERING_ACTOR,
  ])) {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...repo,
      username,
    });
    if (!['admin', 'maintain', 'write'].includes(data.permission))
      throw new Error('Write permission required');
  }
  const { data: issue } = await github.rest.issues.get({
    ...repo,
    issue_number: Number(process.env.ISSUE_NUMBER),
  });
  if (issue.pull_request || issue.state !== 'open')
    throw new Error('An open Issue is required');
  const canonical =
    'feat/automated-' +
    crypto
      .createHash('sha256')
      .update(issue.node_id)
      .digest('hex')
      .slice(0, 16);
  const revision = `-r${context.runId}-a${process.env.GITHUB_RUN_ATTEMPT}`;
  if (!/^-r[0-9]+-a[0-9]+$/.test(revision))
    throw new Error('Invalid run identity');
  const prs = await github.paginate(github.rest.pulls.list, {
    ...repo,
    state: 'all',
    per_page: 100,
  });
  const marker = `<!-- latch-owner:${issue.node_id} -->`;
  const candidates = prs.filter(
    (pr) =>
      pr.head.repo?.full_name === `${repo.owner}/${repo.repo}` &&
      pr.user.login === 'github-actions[bot]' &&
      pr.body?.includes(marker),
  );
  const open = candidates.find((pr) => pr.state === 'open' && pr.draft);
  let branch = canonical,
    source = context.sha,
    expectedHead = null;
  if (open) {
    source = open.head.sha;
    const { data: commit } = await github.rest.repos.getCommit({
      ...repo,
      ref: source,
    });
    if (
      commit.committer?.login === 'github-actions[bot]' &&
      commit.commit.message.endsWith(marker)
    ) {
      branch = open.head.ref;
      expectedHead = source;
    } else {
      // Human commits stay intact; continue from their snapshot in a new proposal.
      branch = canonical + revision;
    }
  } else {
    try {
      const { data: ref } = await github.rest.git.getRef({
        ...repo,
        ref: 'heads/' + canonical,
      });
      const { data: commit } = await github.rest.repos.getCommit({
        ...repo,
        ref: ref.object.sha,
      });
      if (
        !prs.some((pr) => pr.head.ref === canonical) &&
        commit.committer?.login === 'github-actions[bot]' &&
        commit.commit.message.endsWith(marker)
      ) {
        source = expectedHead = ref.object.sha; // Recover branch creation followed by failed PR API.
      } else branch = canonical + revision;
    } catch (error) {
      if (error.status !== 404) throw error;
      if (candidates.length) branch = canonical + revision;
    }
  }
  fs.mkdirSync('request', { recursive: true });
  fs.writeFileSync(
    'request/issue.json',
    JSON.stringify({
      number: issue.number,
      node_id: issue.node_id,
      title: issue.title,
      body: issue.body || '',
      base: context.sha,
      source,
      expected_head: expectedHead,
      branch,
    }),
  );
  core.setOutput('base', context.sha);
  core.setOutput('source', source);
}
