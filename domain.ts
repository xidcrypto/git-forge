// The forge's business operations, written once and driven by the REST, GraphQL and MCP adapters:
// repository/issue/pull-request creation, comments, the pull-request file diff and the squash
// merge. Serializers here produce the REST v3 shapes every surface agrees on.

import {
  buildCommitData,
  commitTree,
  flattenTree,
  getCommit,
  isAncestor,
  mergeBase,
  parseCommit,
  storeObject,
  storeTreeFromFlat,
  ZERO_OID,
} from './git.ts';
import { globalId, nextEpochSec, nextTimestamp, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';

/** A domain refusal: the adapters turn it into their surface's error shape (status + message). */
export class DomainError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
  }
}

// ------------------------------------------------------------------------------------------------
// Serializers (REST v3 shapes)

export function userJson(store: Store): Record<string, unknown> {
  return {
    login: store.viewerLogin,
    id: store.viewerId,
    type: 'User',
    name: store.viewerName,
    email: store.viewerEmail,
  };
}

export function repoJson(store: Store, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: 0,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(store: Store, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.uid,
    node_id: globalId('Issue', issue.uid),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(store),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(store: Store, comment: { id: number; uid: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.uid),
    body: comment.body,
    user: userJson(store),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.uid,
    node_id: globalId('PullRequest', pull.uid),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(store),
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(store, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(store, repo),
    },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ------------------------------------------------------------------------------------------------
// Issues and comments

/** Validate label names against the repository's label set (an unknown label is a 422). */
export function requireLabels(repo: RepoRec, names: readonly string[]): void {
  for (const name of names) {
    if (!repo.labels.has(name)) throw new DomainError(422, `Label "${name}" does not exist in this repository`);
  }
}

export function createIssue(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; labels?: readonly string[] },
): IssueRec {
  const labels = input.labels ?? [];
  requireLabels(repo, labels);
  const now = nextTimestamp();
  const issue: IssueRec = {
    uid: store.nextIssueUid(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  store.issueIndex.set(issue.uid, { repo, issue });
  return issue;
}

export function addComment(store: Store, repo: RepoRec, issue: IssueRec, body: string): IssueRec['comments'][number] {
  const ids = store.nextCommentIds();
  const comment = { uid: ids.uid, id: ids.id, body, createdAt: nextTimestamp() };
  issue.comments.push(comment);
  store.commentIndex.set(comment.uid, { repo, issue, comment });
  return comment;
}

/** The issue or pull request at a shared number (comments address both, as on GitHub). */
export function issueOrPull(repo: RepoRec, number: number): IssueRec | PullRec | null {
  return repo.issues.get(number) ?? repo.pulls.get(number) ?? null;
}

// ------------------------------------------------------------------------------------------------
// Branches, commits and the contents API's writes

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/**
 * Commit a whole flat file map onto a branch (the contents API's write model): the branch tip is
 * the parent, or the branch is born with a root commit when it has no tip yet. Answers the new
 * commit's oid and updates the ref.
 */
export function commitFiles(
  store: Store,
  repo: RepoRec,
  branch: string,
  files: ReadonlyMap<string, string>,
  message: string,
  /** The parent for a branch being born (its own tip wins when it already has one). */
  parentOverride?: string | null,
): string {
  const tip = branchTip(repo, branch) ?? parentOverride ?? null;
  const tree = storeTreeFromFlat(repo, files);
  const data = buildCommitData({
    tree,
    parents: tip === null ? [] : [tip],
    message,
    name: store.viewerName,
    email: store.viewerEmail,
    time: nextEpochSec(),
  });
  const oid = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.updatedAt = nextTimestamp();
  return oid;
}

/** The flat file map at a branch tip (empty for an unborn branch). */
export function filesAtTip(repo: RepoRec, branch: string): Map<string, string> {
  const tip = branchTip(repo, branch);
  if (tip === null) return new Map();
  const tree = commitTree(repo, tip);
  if (tree === null) return new Map();
  return flattenTree(repo, tree);
}

/** The flat file map at a commit (empty when the commit is unknown). */
export function filesAtCommit(repo: RepoRec, commitOid: string): Map<string, string> {
  const tree = commitTree(repo, commitOid);
  if (tree === null) return new Map();
  return flattenTree(repo, tree);
}

// ------------------------------------------------------------------------------------------------
// Pull requests: creation, the file diff and the squash merge

export function createPull(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): PullRec {
  const headSha = branchTip(repo, input.head);
  if (headSha === null) throw new DomainError(422, `Head branch "${input.head}" does not exist`);
  const baseSha = branchTip(repo, input.base);
  if (baseSha === null) throw new DomainError(422, `Base branch "${input.base}" does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      throw new DomainError(422, `A pull request already exists for ${input.head} into ${input.base}`);
    }
  }
  const now = nextTimestamp();
  const pull: PullRec = {
    uid: store.nextPullUid(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    mergeCommitSha: null,
    mergedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  store.pullIndex.set(pull.uid, { repo, pull });
  return pull;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function textLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level additions/deletions between two blob payloads, via a longest-common-subsequence walk. */
function lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = textLines(before);
  const b = textLines(after);
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array((a.length + 1) * (b.length + 1)).fill(0);
  const width = b.length + 1;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j] ? (dp[(i + 1) * width + (j + 1)] as number) + 1 : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + (j + 1)] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changes between two commits' trees (the pull-request files view diffs merge-base to head). */
export function diffCommits(repo: RepoRec, fromCommit: string, toCommit: string): FileChange[] {
  const before = filesAtCommit(repo, fromCommit);
  const after = filesAtCommit(repo, toCommit);
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = before.get(path);
    const newOid = after.get(path);
    if (oldOid === newOid) continue;
    if (oldOid === undefined && newOid !== undefined) {
      const blob = repo.objects.get(newOid);
      const additions = blob === undefined ? 0 : textLines(blob.data).length;
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (newOid === undefined && oldOid !== undefined) {
      const blob = repo.objects.get(oldOid);
      const deletions = blob === undefined ? 0 : textLines(blob.data).length;
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (oldOid !== undefined && newOid !== undefined) {
      const oldBlob = repo.objects.get(oldOid);
      const newBlob = repo.objects.get(newOid);
      const { additions, deletions } = lineDiff(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/** The three-way merge at the heart of a pull request merge, or the paths that conflict. */
export function threeWayMerge(
  repo: RepoRec,
  baseTip: string,
  headTip: string,
): { files: Map<string, string>; mergeBaseOid: string } | { conflict: string } {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return { conflict: 'the branches share no history' };
  if (base === headTip) return { conflict: 'the head branch has no changes to merge' };
  const atBase = filesAtCommit(repo, base);
  const atBaseTip = filesAtCommit(repo, baseTip);
  const atHead = filesAtCommit(repo, headTip);
  const result = new Map(atBaseTip);
  const paths = new Set([...atBase.keys(), ...atHead.keys()]);
  for (const path of paths) {
    const inBase = atBase.get(path);
    const inHead = atHead.get(path);
    if (inBase === inHead) continue;
    const inBaseTip = atBaseTip.get(path);
    if (inBaseTip !== inBase && inBaseTip !== inHead) {
      return { conflict: `both branches changed ${path}` };
    }
    if (inHead === undefined) result.delete(path);
    else result.set(path, inHead);
  }
  return { files: result, mergeBaseOid: base };
}

/** Whether an open pull request would merge cleanly right now (the GraphQL mergeable field). */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  return 'files' in threeWayMerge(repo, baseTip, headTip) ? 'MERGEABLE' : 'CONFLICTING';
}

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree is the three-way
 * result, the pull request closed as merged. A conflict is a 405, GitHub's merge refusal.
 */
export function mergePull(store: Store, repo: RepoRec, pull: PullRec): { sha: string } {
  if (pull.state !== 'open' || pull.merged) throw new DomainError(405, 'Pull Request is not mergeable');
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) throw new DomainError(405, 'Pull Request is not mergeable');
  const merged = threeWayMerge(repo, baseTip, headTip);
  if ('conflict' in merged) throw new DomainError(405, `Pull Request is not mergeable: ${merged.conflict}`);
  const tree = storeTreeFromFlat(repo, merged.files);
  const data = buildCommitData({
    tree,
    parents: [baseTip],
    message: `${pull.title} (#${pull.number})\n\n${pull.body}`,
    name: store.viewerName,
    email: store.viewerEmail,
    time: nextEpochSec(),
  });
  const sha = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = nextTimestamp();
  pull.updatedAt = pull.mergedAt;
  repo.updatedAt = pull.mergedAt;
  return { sha };
}

/** History from a ref or commit, newest first (the commits list and its `sha` parameter). */
export function historyFrom(repo: RepoRec, startOid: string): Array<{ sha: string; message: string; parents: string[]; time: number }> {
  const out: Array<{ sha: string; message: string; parents: string[]; time: number }> = [];
  const seen = new Set<string>();
  const queue: string[] = [startOid];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    const info = parseCommit(commit.data);
    out.push({ sha: oid, message: info.message, parents: info.parents, time: info.authorTime });
    for (const parent of info.parents) queue.push(parent);
  }
  return out;
}

export { ZERO_OID, isAncestor };
