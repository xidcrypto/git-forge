// The forge's in-memory state: one store behind the REST, git, GraphQL and MCP surfaces, so an
// object created on one surface reads back identically on the others. Nothing here touches the
// network or the filesystem; the git object machinery lives in git.ts, the issue/pull business
// rules in domain.ts.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  /** Globally unique id, the key of the GraphQL global id. */
  uid: number;
  /** The numeric id the REST surface shows; unique across the whole forge. */
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  uid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** Label names, in the order they were attached. */
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  uid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** Branch tips snapshotted at creation, the way the checks read them back. */
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  /** The numeric database id (REST `id`, GraphQL `databaseId`). */
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  /** Full ref names ('refs/heads/main', 'refs/tags/v1') to commit/tag oids. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one per-repo number sequence, as on GitHub. */
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

/** The scenario epoch (wire.ts's fixed seed time); every timestamp the forge mints derives from it. */
export const EPOCH_SEC = 1739175597;

let clockSeq = 0;

/** A deterministic, strictly increasing ISO timestamp (no wall clock anywhere in the forge). */
export function nextTimestamp(): string {
  clockSeq += 1;
  return new Date((EPOCH_SEC + clockSeq) * 1000).toISOString();
}

/** A deterministic, strictly increasing epoch-second for git author/committer lines. */
export function nextEpochSec(): number {
  clockSeq += 1;
  return EPOCH_SEC + clockSeq;
}

/** A Relay-style global id: opaque (never the plain numeric id), stable for the object's life. */
export function globalId(type: string, uid: number): string {
  return Buffer.from(`${type}:${uid}`, 'utf8').toString('base64');
}

/** Decode a global id minted by globalId(); null for anything else. */
export function parseGlobalId(id: string): { type: string; uid: number } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+):([0-9]+)$/.exec(text);
  if (match === null) return null;
  return { type: match[1] as string, uid: Number(match[2]) };
}

/** The whole forge: the viewer's repositories plus the global-id indexes the GraphQL node() read needs. */
export class Store {
  readonly viewerLogin: string;
  readonly viewerId = 1000;
  readonly viewerName: string;
  readonly viewerEmail: string;
  /** Repositories by name (every repository belongs to the viewer; another owner reads as absent). */
  readonly repos = new Map<string, RepoRec>();
  readonly issueIndex = new Map<number, { repo: RepoRec; issue: IssueRec }>();
  readonly pullIndex = new Map<number, { repo: RepoRec; pull: PullRec }>();
  readonly commentIndex = new Map<number, { repo: RepoRec; issue: IssueRec; comment: CommentRec }>();
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;
  private commentIdSeq = 0;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
    this.viewerName = viewerLogin;
    this.viewerEmail = `${viewerLogin}@example.invalid`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec {
    this.repoSeq += 1;
    const now = nextTimestamp();
    const repo: RepoRec = {
      id: this.repoSeq,
      owner: this.viewerLogin,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** The repository at owner/name, or null: a stranger's repository is indistinguishable from a missing one. */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== this.viewerLogin) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewerLogin) return false;
    return this.repos.delete(name);
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()];
  }

  nextIssueUid(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextPullUid(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }

  nextCommentIds(): { uid: number; id: number } {
    this.commentSeq += 1;
    this.commentIdSeq += 1;
    return { uid: this.commentSeq, id: this.commentIdSeq };
  }
}
