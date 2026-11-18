// The REST v3 adapter: routes under /api/v3, GitHub's status codes and shapes, on top of
// domain.ts's operations and git.ts's object store. Every answer is a plain value here; app.ts
// owns the HTTP plumbing (JSON, the request-id header, the 400 for malformed JSON).

import {
  branchTip,
  commitFiles,
  createIssue,
  createPull,
  diffCommits,
  DomainError,
  filesAtTip,
  historyFrom,
  issueJson,
  labelJson,
  mergePull,
  pullJson,
  repoJson,
  userJson,
  addComment,
  commentJson,
} from './domain.ts';
import { getCommit, lookupPath, mergeBase, parseCommit, parseTree, storeObject, ZERO_OID } from './git.ts';
import { nextTimestamp, type RepoRec, type Store } from './store.ts';

export interface RestRequest {
  method: string;
  /** The path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when there was none). */
  body: Record<string, unknown> | undefined;
  /** The request's Host header, for absolute Link URLs. */
  host: string;
}

export interface RestAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function notFound(message = 'Not Found'): RestAnswer {
  return { status: 404, body: { message } };
}

function unprocessable(message: string): RestAnswer {
  return { status: 422, body: { message } };
}

function stringField(body: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = body?.[field];
  return typeof value === 'string' ? value : undefined;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Route one /api/v3 request. Domain errors become their status and message. */
export function handleRest(store: Store, req: RestRequest): RestAnswer {
  try {
    return route(store, req);
  } catch (err) {
    if (err instanceof DomainError) return { status: err.status, body: { message: err.message } };
    throw err;
  }
}

function route(store: Store, req: RestRequest): RestAnswer {
  const [head, ...rest] = req.segments;
  if (head === undefined) {
    if (req.method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (head === 'meta' && rest.length === 0) {
    if (req.method !== 'GET') return notFound();
    return { status: 200, body: { verifiable_password_authentication: false, installed_version: '1.0.0' } };
  }
  if (head === 'user') return userRoute(store, req, rest);
  if (head === 'repos' && rest.length >= 2) {
    const owner = rest[0] as string;
    const name = rest[1] as string;
    return repoRoute(store, req, owner, name, rest.slice(2));
  }
  return notFound();
}

function userRoute(store: Store, req: RestRequest, rest: string[]): RestAnswer {
  if (rest.length === 0) {
    if (req.method !== 'GET') return notFound();
    return { status: 200, body: userJson(store) };
  }
  if (rest.length === 1 && rest[0] === 'repos') {
    if (req.method === 'POST') return createRepo(store, req);
    if (req.method === 'GET') return listUserRepos(store, req);
  }
  return notFound();
}

function createRepo(store: Store, req: RestRequest): RestAnswer {
  const name = stringField(req.body, 'name');
  if (name === undefined || name === '') return unprocessable('name is required');
  if (store.repos.has(name)) return unprocessable('name already exists on this account');
  const isPrivate = req.body?.private === true;
  const description = stringField(req.body, 'description') ?? '';
  const repo = store.createRepo(name, isPrivate, description);
  if (req.body?.auto_init === true) {
    const blob = storeObject(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
    commitFiles(store, repo, repo.defaultBranch, new Map([['README.md', blob]]), 'Initial commit');
  }
  return { status: 201, body: repoJson(store, repo) };
}

function listUserRepos(store: Store, req: RestRequest): RestAnswer {
  const perPage = intParam(req.query, 'per_page', 30);
  const page = intParam(req.query, 'page', 1);
  const all = store.listRepos();
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const base = `http://${req.host}/api/v3/user/repos`;
    const lastPage = Math.ceil(all.length / perPage);
    headers.link = `<${base}?per_page=${perPage}&page=${page + 1}>; rel="next", <${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`;
  }
  return { status: 200, body: slice.map((repo) => repoJson(store, repo)), headers };
}

/** Everything under /repos/{owner}/{repo}: a stranger's repository is a 404 everywhere. */
function repoRoute(store: Store, req: RestRequest, owner: string, name: string, rest: string[]): RestAnswer {
  const repo = store.getRepo(owner, name);
  if (rest.length === 0) {
    if (req.method === 'GET') return repo === null ? notFound() : { status: 200, body: repoJson(store, repo) };
    if (repo === null) return notFound();
    if (req.method === 'PATCH') {
      const description = stringField(req.body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
      repo.updatedAt = nextTimestamp();
      return { status: 200, body: repoJson(store, repo) };
    }
    if (req.method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }
  if (repo === null) return notFound();
  const [head, ...tail] = rest;
  switch (head) {
    case 'contents':
      return contentsRoute(store, req, repo, tail.join('/'));
    case 'git':
      return gitDataRoute(store, req, repo, tail);
    case 'branches':
      return branchesRoute(store, req, repo, tail);
    case 'commits':
      return commitsRoute(store, req, repo);
    case 'labels':
      return labelsRoute(store, req, repo, tail);
    case 'issues':
      return issuesRoute(store, req, repo, tail);
    case 'pulls':
      return pullsRoute(store, req, repo, tail);
    default:
      return notFound();
  }
}

// ------------------------------------------------------------------------------------------------
// Contents

function contentsRoute(store: Store, req: RestRequest, repo: RepoRec, path: string): RestAnswer {
  if (path === '') return notFound();
  if (req.method === 'GET') return getContents(store, req, repo, path);
  if (req.method === 'PUT') return putContents(store, req, repo, path);
  if (req.method === 'DELETE') return deleteContents(store, req, repo, path);
  return notFound();
}

function refTipForRead(store: Store, req: RestRequest, repo: RepoRec): string | null {
  const ref = req.query.get('ref');
  if (ref !== null && ref !== '') {
    const byBranch = branchTip(repo, ref);
    if (byBranch !== null) return byBranch;
    if (getCommit(repo, ref) !== null) return ref;
    return null;
  }
  return branchTip(repo, repo.defaultBranch);
}

function getContents(store: Store, req: RestRequest, repo: RepoRec, path: string): RestAnswer {
  void store;
  const tip = refTipForRead(store, req, repo);
  if (tip === null) return notFound();
  const commit = getCommit(repo, tip);
  if (commit === null) return notFound();
  const tree = parseCommit(commit.data).tree;
  const found = lookupPath(repo, tree, path);
  if (found === null) return notFound();
  if (found.kind === 'blob') {
    const blob = repo.objects.get(found.oid);
    if (blob === undefined) return notFound();
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        name: path.split('/').pop(),
        path,
        sha: found.oid,
        size: blob.data.length,
      },
    };
  }
  const treeObject = repo.objects.get(found.oid);
  if (treeObject === undefined || treeObject.type !== 'tree') return notFound();
  const entries = parseTree(treeObject.data)
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
      size: 0,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return { status: 200, body: entries };
}

function putContents(store: Store, req: RestRequest, repo: RepoRec, path: string): RestAnswer {
  const body = req.body ?? {};
  const message = stringField(body, 'message') ?? 'update';
  const content = stringField(body, 'content');
  if (content === undefined) return unprocessable('content is required');
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  const files = filesAtTip(repo, branch);
  const branchExists = branchTip(repo, branch) !== null;
  if (!branchExists && branch !== repo.defaultBranch) {
    // A contents write naming a fresh branch creates it, seeded from the default branch (the
    // fallback branch-creation route the MCP setup uses when git/refs is unavailable).
    for (const [filePath, oid] of filesAtTip(repo, repo.defaultBranch)) files.set(filePath, oid);
  }
  const existing = files.get(path);
  const sha = stringField(body, 'sha');
  if (existing !== undefined) {
    if (sha === undefined) return unprocessable('"sha" wasn\'t supplied');
    if (sha !== existing) return { status: 409, body: { message: 'The sha does not match the current content' } };
  }
  const blobOid = storeObject(repo, 'blob', bytes);
  files.set(path, blobOid);
  const parent = !branchExists && branch !== repo.defaultBranch ? branchTip(repo, repo.defaultBranch) : undefined;
  const commit = commitFiles(store, repo, branch, files, message, parent);
  return {
    status: existing === undefined ? 201 : 200,
    body: {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit },
    },
  };
}

function deleteContents(store: Store, req: RestRequest, repo: RepoRec, path: string): RestAnswer {
  const body = req.body ?? {};
  const message = stringField(body, 'message') ?? 'delete';
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const files = filesAtTip(repo, branch);
  const existing = files.get(path);
  if (existing === undefined) return notFound();
  const sha = stringField(body, 'sha');
  if (sha !== undefined && sha !== existing) return { status: 409, body: { message: 'The sha does not match the current content' } };
  files.delete(path);
  const commit = commitFiles(store, repo, branch, files, message);
  return { status: 200, body: { content: null, commit: { sha: commit } } };
}

// ------------------------------------------------------------------------------------------------
// Git Data refs, branches, commits

function gitDataRoute(store: Store, req: RestRequest, repo: RepoRec, rest: string[]): RestAnswer {
  void store;
  if (rest[0] !== 'refs') return notFound();
  if (rest.length === 1) {
    if (req.method !== 'POST') return notFound();
    const ref = stringField(req.body, 'ref');
    const sha = stringField(req.body, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
    const object = repo.objects.get(sha);
    if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) return unprocessable('sha does not name a commit');
    if (repo.refs.has(ref)) return unprocessable('Reference already exists');
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: object.type } } };
  }
  if (req.method !== 'GET') return notFound();
  const ref = `refs/${rest.slice(1).join('/')}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  const object = repo.objects.get(oid);
  return { status: 200, body: { ref, object: { sha: oid, type: object?.type ?? 'commit' } } };
}

function branchesRoute(store: Store, req: RestRequest, repo: RepoRec, rest: string[]): RestAnswer {
  void store;
  if (req.method !== 'GET') return notFound();
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), oid }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  if (rest.length === 0) {
    return { status: 200, body: branches.map((branch) => ({ name: branch.name, commit: { sha: branch.oid }, protected: false })) };
  }
  const name = rest.join('/');
  const branch = branches.find((entry) => entry.name === name);
  if (branch === undefined) return notFound();
  return { status: 200, body: { name: branch.name, commit: { sha: branch.oid }, protected: false } };
}

function commitsRoute(store: Store, req: RestRequest, repo: RepoRec): RestAnswer {
  void store;
  if (req.method !== 'GET') return notFound();
  const shaParam = req.query.get('sha');
  let start: string | null = null;
  if (shaParam !== null && shaParam !== '') {
    start = branchTip(repo, shaParam) ?? (getCommit(repo, shaParam) !== null ? shaParam : null);
    if (start === null) return { status: 200, body: [] };
  } else {
    start = branchTip(repo, repo.defaultBranch);
  }
  if (start === null) return { status: 200, body: [] };
  const history = historyFrom(repo, start);
  return {
    status: 200,
    body: history.map((entry) => {
      const commit = getCommit(repo, entry.sha);
      const info = commit === null ? null : parseCommit(commit.data);
      const author = identOf(commit?.data, 'author');
      const committer = identOf(commit?.data, 'committer');
      return {
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { name: author.name, email: author.email, date: new Date(entry.time * 1000).toISOString() },
          committer: { name: committer.name, email: committer.email, date: new Date(entry.time * 1000).toISOString() },
          tree: { sha: info?.tree ?? ZERO_OID },
        },
        parents: entry.parents.map((parent) => ({ sha: parent })),
      };
    }),
  };
}

/** One `author`/`committer` ident out of a commit object's headers. */
function identOf(data: Buffer | undefined, kind: 'author' | 'committer'): { name: string; email: string } {
  if (data === undefined) return { name: '', email: '' };
  const head = data.toString('utf8', 0, Math.min(data.length, 8192));
  for (const line of head.split('\n')) {
    if (line === '') break;
    if (line.startsWith(`${kind} `)) {
      const match = /^(.*?) <(.*?)> [0-9]+ [+-][0-9]{4}$/.exec(line.slice(kind.length + 1));
      if (match !== null) return { name: match[1] as string, email: match[2] as string };
    }
  }
  return { name: '', email: '' };
}

// ------------------------------------------------------------------------------------------------
// Labels

function labelsRoute(store: Store, req: RestRequest, repo: RepoRec, rest: string[]): RestAnswer {
  void store;
  if (rest.length !== 0) return notFound();
  if (req.method === 'GET') {
    const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, body: labels.map((label) => ({ name: label.name, color: label.color, description: label.description })) };
  }
  if (req.method === 'POST') {
    const name = stringField(req.body, 'name');
    if (name === undefined || name === '') return unprocessable('name is required');
    if (repo.labels.has(name)) return unprocessable('Label already exists');
    const color = (stringField(req.body, 'color') ?? 'ededed').replace(/^#/, '');
    const description = stringField(req.body, 'description') ?? null;
    repo.labels.set(name, { name, color, description });
    return { status: 201, body: { name, color, description } };
  }
  return notFound();
}

// ------------------------------------------------------------------------------------------------
// Issues and comments

function issuesRoute(store: Store, req: RestRequest, repo: RepoRec, rest: string[]): RestAnswer {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const title = stringField(req.body, 'title');
      if (title === undefined || title === '') return unprocessable('title is required');
      const labels = Array.isArray(req.body?.labels) ? (req.body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
      const issue = createIssue(store, repo, { title, body: stringField(req.body, 'body') ?? '', labels });
      return { status: 201, body: issueJson(store, repo, issue) };
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      const perPage = intParam(req.query, 'per_page', 30);
      const page = intParam(req.query, 'page', 1);
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const slice = issues.slice((page - 1) * perPage, page * perPage);
      return { status: 200, body: slice.map((issue) => issueJson(store, repo, issue)) };
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) return notFound();
  if (rest.length === 1) {
    const issue = repo.issues.get(number);
    if (issue === undefined) return notFound();
    if (req.method === 'GET') return { status: 200, body: issueJson(store, repo, issue) };
    if (req.method === 'PATCH') {
      const state = stringField(req.body, 'state');
      if (state === 'closed' || state === 'open') issue.state = state;
      const title = stringField(req.body, 'title');
      if (title !== undefined) issue.title = title;
      const body = stringField(req.body, 'body');
      if (body !== undefined) issue.body = body;
      if (Array.isArray(req.body?.labels)) {
        const labels = (req.body.labels as unknown[]).filter((label): label is string => typeof label === 'string');
        for (const name of labels) if (!repo.labels.has(name)) return unprocessable(`Label "${name}" does not exist in this repository`);
        issue.labels = labels;
      }
      issue.updatedAt = nextTimestamp();
      return { status: 200, body: issueJson(store, repo, issue) };
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    const issue = repo.issues.get(number);
    if (issue === undefined) return notFound();
    if (req.method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(store, comment)) };
    }
    if (req.method === 'POST') {
      const body = stringField(req.body, 'body');
      if (body === undefined) return unprocessable('body is required');
      const comment = addComment(store, repo, issue, body);
      return { status: 201, body: commentJson(store, comment) };
    }
  }
  return notFound();
}

// ------------------------------------------------------------------------------------------------
// Pull requests

function pullsRoute(store: Store, req: RestRequest, repo: RepoRec, rest: string[]): RestAnswer {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const title = stringField(req.body, 'title');
      const head = stringField(req.body, 'head');
      const base = stringField(req.body, 'base');
      if (title === undefined || head === undefined || base === undefined) return unprocessable('title, head and base are required');
      const pull = createPull(store, repo, { title, body: stringField(req.body, 'body') ?? '', head, base });
      return { status: 201, body: pullJson(store, repo, pull) };
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const perPage = intParam(req.query, 'per_page', 30);
      const page = intParam(req.query, 'page', 1);
      const slice = pulls.slice((page - 1) * perPage, page * perPage);
      return { status: 200, body: slice.map((pull) => pullJson(store, repo, pull)) };
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (pull === undefined) return notFound();
    if (req.method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (pull === undefined) return notFound();
    if (req.method !== 'GET') return notFound();
    const headTip = branchTip(repo, pull.headRef);
    const baseTip = branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { status: 200, body: [] };
    const base = mergeBase(repo, baseTip, headTip);
    const changes = base === null ? allFilesAdded(repo, headTip) : diffCommits(repo, base, headTip);
    return {
      status: 200,
      body: changes.map((change) => ({
        filename: change.filename,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      })),
    };
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) return notFound();
    if (req.method !== 'PUT') return notFound();
    const { sha } = mergePull(store, repo, pull);
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

/** Every file at a commit as an 'added' change (the files view for unrelated histories). */
function allFilesAdded(repo: RepoRec, commitOid: string): ReturnType<typeof diffCommits> {
  const tree = parseCommit((getCommit(repo, commitOid) as { data: Buffer }).data).tree;
  const out: ReturnType<typeof diffCommits> = [];
  const walk = (treeOid: string, prefix: string): void => {
    const treeObject = repo.objects.get(treeOid);
    if (treeObject === undefined || treeObject.type !== 'tree') return;
    for (const entry of parseTree(treeObject.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else {
        const blob = repo.objects.get(entry.oid);
        const additions = blob === undefined ? 0 : blob.data.toString('utf8').split('\n').length;
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      }
    }
  };
  walk(tree, '');
  return out;
}
