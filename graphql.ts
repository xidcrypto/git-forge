// The GraphQL v4 surface: a small parser and executor for exactly the document shapes gh and
// github-mcp-server send (operations with variables, aliases, inline fragments, input objects,
// enum literals, __type introspection, and GitHub's operation batching), executed against the
// same store the REST and git surfaces use. No GraphQL library — the standard library only.

import { addComment, branchTip, createIssue, createPull, mergePull, pullMergeable, diffCommits } from './domain.ts';
import { mergeBase } from './git.ts';
import { globalId, parseGlobalId, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';

// ------------------------------------------------------------------------------------------------
// Parsing

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  fragmentOn: null;
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: SelectionItem[] | null;
}

interface FragmentNode {
  fragmentOn: string;
  selection: SelectionItem[];
}

type SelectionItem = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionItem[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { onType: string; selection: SelectionItem[] }>;
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < input.length) {
    const ch = input[pos] as string;
    if (ch === '#') {
      while (pos < input.length && input[pos] !== '\n') pos += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      pos += 1;
      continue;
    }
    if (ch === '.' && input.startsWith('...', pos)) {
      tokens.push({ kind: 'spread', value: '...' });
      pos += 3;
      continue;
    }
    if ('{}()[]:$=!@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', pos)) {
        const end = input.indexOf('"""', pos + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(pos + 3, end) });
        pos = end + 3;
        continue;
      }
      let value = '';
      pos += 1;
      while (pos < input.length && input[pos] !== '"') {
        if (input[pos] === '\\') {
          const esc = input[pos + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'u' ? String.fromCharCode(parseInt(input.slice(pos + 2, pos + 6), 16)) : esc;
          pos += esc === 'u' ? 6 : 2;
        } else {
          value += input[pos];
          pos += 1;
        }
      }
      if (pos >= input.length) throw new Error('unterminated string');
      pos += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(input.slice(pos));
      if (match === null) throw new Error(`bad number at ${pos}`);
      tokens.push({ kind: 'number', value: match[0] });
      pos += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(pos));
      const word = (match as RegExpExecArray)[0];
      tokens.push({ kind: 'name', value: word });
      pos += word.length;
      continue;
    }
    throw new Error(`unexpected character "${ch}"`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
  }

  private skip(value: string): boolean {
    if (this.peek().value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { onType: string; selection: SelectionItem[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.value === 'query' || token.value === 'mutation') {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        const onType = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { onType, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token "${token.value}"`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      this.next(); // the variable name
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next();
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionItem[] {
    this.expect('{');
    const items: SelectionItem[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().value === 'on') {
          this.next();
          const onType = this.next().value;
          this.skipDirectives();
          items.push({ fragmentOn: onType, selection: this.parseSelectionSet() });
        } else {
          const fragName = this.next().value;
          this.skipDirectives();
          items.push({ fragmentOn: `__spread:${fragName}`, selection: [] });
        }
      } else {
        items.push(this.parseField());
      }
    }
    this.expect('}');
    return items;
  }

  private parseField(): FieldNode {
    let name = this.next().value;
    let alias: string | null = null;
    if (this.skip(':')) {
      alias = name;
      name = this.next().value;
    }
    let args: Record<string, Value> = {};
    if (this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selection: SelectionItem[] | null = null;
    if (this.peek().value === '{') selection = this.parseSelectionSet();
    return { fragmentOn: null, alias, name, args, selection };
  }

  private parseArguments(): Record<string, Value> {
    this.expect('(');
    const args: Record<string, Value> = {};
    while (this.peek().value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return token.value.includes('.') || /[eE]/.test(token.value) ? { kind: 'float', value: Number(token.value) } : { kind: 'int', value: Number(token.value) };
    if (token.value === '[') {
      const items: Value[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek().value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }
}

/** Resolve a parsed argument value against the operation's variables. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = resolveValue(field, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Execution

/** The fields __type reports for each object type (gh's feature-detection probes read these). */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'createdAt', 'updatedAt',
  ],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestChangedFile: ['path'],
  IssueComment: ['id', 'body'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  __Schema: ['queryType', 'mutationType'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'DISCUSSION', 'REPOSITORY', 'USER', 'COMMIT', 'CODE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

type Typed =
  | { form: 'scalar'; value: unknown }
  | { form: 'null' }
  | { form: 'object'; type: string; source: unknown }
  | { form: 'list'; type: string; sources: unknown[] };

const scalar = (value: unknown): Typed => ({ form: 'scalar', value });
const nothing: Typed = { form: 'null' };
const object = (type: string, source: unknown): Typed => ({ form: 'object', type, source });
const list = (type: string, sources: unknown[]): Typed => ({ form: 'list', type, sources });

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, { onType: string; selection: SelectionItem[] }>;
  errors: Array<{ message: string }>;
}

type Resolver = (ctx: Ctx, source: never, args: Record<string, unknown>) => Typed;

interface IssueSource {
  repo: RepoRec;
  issue: IssueRec;
}

interface PullSource {
  repo: RepoRec;
  pull: PullRec;
}

interface ConnectionSource {
  repo: RepoRec;
  page: IssueRec[];
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

const encodeCursor = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64');

function decodeCursor(cursor: string): number | null {
  try {
    const match = /^cursor:([0-9]+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): ConnectionSource {
  let items = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    items = items.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { direction?: string } | undefined;
  if (orderBy !== undefined && orderBy !== null) {
    const sign = orderBy.direction === 'ASC' ? 1 : -1;
    items.sort((a, b) => sign * (a.number - b.number));
  } else {
    items.sort((a, b) => a.number - b.number);
  }
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const number = decodeCursor(after);
    const index = number === null ? -1 : items.findIndex((issue) => issue.number === number);
    start = index === -1 ? items.length : index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const page = items.slice(start, start + first);
  return {
    repo,
    page,
    total: items.length,
    hasNextPage: start + page.length < items.length,
    endCursor: page.length > 0 ? encodeCursor((page[page.length - 1] as IssueRec).number) : null,
    startCursor: page.length > 0 ? encodeCursor((page[0] as IssueRec).number) : null,
  };
}

function pullFiles(repo: RepoRec, pull: PullRec): string[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return [];
  return diffCommits(repo, base, headTip).map((change) => change.filename);
}

function repoByGlobalId(store: Store, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  for (const repo of store.repos.values()) if (repo.id === parsed.uid) return repo;
  return null;
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: (ctx) => object('User', null),
    repository: (ctx, _source, args) => {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? ctx.store.getRepo(args.owner, args.name) : null;
      return repo === null ? nothing : object('Repository', repo);
    },
    node: (ctx, _source, args) => {
      if (typeof args.id !== 'string') return nothing;
      const parsed = parseGlobalId(args.id);
      if (parsed === null) return nothing;
      if (parsed.type === 'Repository') {
        const repo = repoByGlobalId(ctx.store, args.id);
        return repo === null ? nothing : object('Repository', repo);
      }
      if (parsed.type === 'Issue') {
        const found = ctx.store.issueIndex.get(parsed.uid);
        return found === undefined ? nothing : object('Issue', { repo: found.repo, issue: found.issue } satisfies IssueSource);
      }
      if (parsed.type === 'PullRequest') {
        const found = ctx.store.pullIndex.get(parsed.uid);
        return found === undefined ? nothing : object('PullRequest', { repo: found.repo, pull: found.pull } satisfies PullSource);
      }
      if (parsed.type === 'IssueComment') {
        const found = ctx.store.commentIndex.get(parsed.uid);
        return found === undefined ? nothing : object('IssueComment', { uid: found.comment.uid, body: found.comment.body });
      }
      return nothing;
    },
    __type: (_ctx, _source, args) => {
      const name = args.name;
      if (typeof name !== 'string') return nothing;
      if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return nothing;
      return object('__Type', name);
    },
    __schema: () => object('__Schema', null),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = args.input as { repositoryId?: unknown; title?: unknown; body?: unknown };
      const repo = repoByGlobalId(ctx.store, input?.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const issue = createIssue(ctx.store, repo, {
        title: typeof input?.title === 'string' ? input.title : '',
        body: typeof input?.body === 'string' ? input.body : '',
      });
      return object('CreateIssuePayload', { repo, issue } satisfies IssueSource);
    },
    closeIssue: (ctx, _source, args) => {
      const input = args.input as { issueId?: unknown };
      const parsed = typeof input?.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const found = parsed !== null && parsed.type === 'Issue' ? ctx.store.issueIndex.get(parsed.uid) : undefined;
      if (found === undefined) throw new Error('issue not found');
      found.issue.state = 'closed';
      return object('CloseIssuePayload', { repo: found.repo, issue: found.issue } satisfies IssueSource);
    },
    createPullRequest: (ctx, _source, args) => {
      const input = args.input as { repositoryId?: unknown; baseRefName?: unknown; headRefName?: unknown; title?: unknown; body?: unknown };
      const repo = repoByGlobalId(ctx.store, input?.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const pull = createPull(ctx.store, repo, {
        title: typeof input?.title === 'string' ? input.title : '',
        body: typeof input?.body === 'string' ? input.body : '',
        head: typeof input?.headRefName === 'string' ? input.headRefName : '',
        base: typeof input?.baseRefName === 'string' ? input.baseRefName : '',
      });
      return object('CreatePullRequestPayload', { repo, pull } satisfies PullSource);
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = args.input as { pullRequestId?: unknown };
      const parsed = typeof input?.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const found = parsed !== null && parsed.type === 'PullRequest' ? ctx.store.pullIndex.get(parsed.uid) : undefined;
      if (found === undefined) throw new Error('pull request not found');
      mergePull(ctx.store, found.repo, found.pull);
      return object('MergePullRequestPayload', { repo: found.repo, pull: found.pull } satisfies PullSource);
    },
    addComment: (ctx, _source, args) => {
      const input = args.input as { subjectId?: unknown; body?: unknown };
      const parsed = typeof input?.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const found = parsed !== null && parsed.type === 'Issue' ? ctx.store.issueIndex.get(parsed.uid) : undefined;
      if (found === undefined) throw new Error('subject not found');
      const comment = addComment(ctx.store, found.repo, found.issue, typeof input?.body === 'string' ? input.body : '');
      return object('AddCommentPayload', { uid: comment.uid, body: comment.body });
    },
  },
  User: {
    login: (ctx) => scalar(ctx.store.viewerLogin),
    id: (ctx) => scalar(globalId('User', ctx.store.viewerId)),
  },
  Repository: {
    id: (_ctx, repo: RepoRec) => scalar(globalId('Repository', repo.id)),
    databaseId: (_ctx, repo: RepoRec) => scalar(repo.id),
    name: (_ctx, repo: RepoRec) => scalar(repo.name),
    nameWithOwner: (_ctx, repo: RepoRec) => scalar(`${repo.owner}/${repo.name}`),
    description: (_ctx, repo: RepoRec) => scalar(repo.description),
    isPrivate: (_ctx, repo: RepoRec) => scalar(repo.isPrivate),
    owner: () => object('User', null),
    defaultBranchRef: (_ctx, repo: RepoRec) => {
      const tip = branchTip(repo, repo.defaultBranch);
      return tip === null ? nothing : object('Ref', { name: repo.defaultBranch });
    },
    viewerPermission: () => scalar('ADMIN'),
    hasIssuesEnabled: () => scalar(true),
    createdAt: (_ctx, repo: RepoRec) => scalar(repo.createdAt),
    updatedAt: (_ctx, repo: RepoRec) => scalar(repo.updatedAt),
    issue: (_ctx, repo: RepoRec, args) => {
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? nothing : object('Issue', { repo, issue } satisfies IssueSource);
    },
    issues: (_ctx, repo: RepoRec, args) => object('IssueConnection', issuesConnection(repo, args)),
    pullRequest: (_ctx, repo: RepoRec, args) => {
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? nothing : object('PullRequest', { repo, pull } satisfies PullSource);
    },
    pullRequests: (_ctx, repo: RepoRec, args) => {
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : pulls.length;
      return object('PullRequestConnection', { repo, pulls: pulls.slice(0, first) });
    },
  },
  Issue: {
    id: (_ctx, source: IssueSource) => scalar(globalId('Issue', source.issue.uid)),
    number: (_ctx, source: IssueSource) => scalar(source.issue.number),
    title: (_ctx, source: IssueSource) => scalar(source.issue.title),
    state: (_ctx, source: IssueSource) => scalar(source.issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (_ctx, source: IssueSource) => scalar(source.issue.body),
    createdAt: (_ctx, source: IssueSource) => scalar(source.issue.createdAt),
    updatedAt: (_ctx, source: IssueSource) => scalar(source.issue.updatedAt),
    repository: (_ctx, source: IssueSource) => object('Repository', source.repo),
  },
  PullRequest: {
    id: (_ctx, source: PullSource) => scalar(globalId('PullRequest', source.pull.uid)),
    number: (_ctx, source: PullSource) => scalar(source.pull.number),
    title: (_ctx, source: PullSource) => scalar(source.pull.title),
    body: (_ctx, source: PullSource) => scalar(source.pull.body),
    state: (_ctx, source: PullSource) => scalar(source.pull.merged ? 'MERGED' : source.pull.state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: (_ctx, source: PullSource) => scalar(source.pull.merged),
    mergeable: (_ctx, source: PullSource) => scalar(pullMergeable(source.repo, source.pull)),
    headRefName: (_ctx, source: PullSource) => scalar(source.pull.headRef),
    baseRefName: (_ctx, source: PullSource) => scalar(source.pull.baseRef),
    createdAt: (_ctx, source: PullSource) => scalar(source.pull.createdAt),
    updatedAt: (_ctx, source: PullSource) => scalar(source.pull.updatedAt),
    files: (_ctx, source: PullSource, args) => {
      const paths = pullFiles(source.repo, source.pull);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : paths.length;
      return object('PullRequestFilesConnection', { paths: paths.slice(0, first) });
    },
  },
  Ref: {
    name: (_ctx, source: { name: string }) => scalar(source.name),
  },
  IssueConnection: {
    nodes: (_ctx, source: ConnectionSource) => list('Issue', source.page.map((issue) => ({ repo: source.repo, issue } satisfies IssueSource))),
    pageInfo: (_ctx, source: ConnectionSource) => object('PageInfo', source),
    totalCount: (_ctx, source: ConnectionSource) => scalar(source.total),
  },
  PageInfo: {
    hasNextPage: (_ctx, source: ConnectionSource) => scalar(source.hasNextPage),
    endCursor: (_ctx, source: ConnectionSource) => scalar(source.endCursor),
    hasPreviousPage: () => scalar(false),
    startCursor: (_ctx, source: ConnectionSource) => scalar(source.startCursor),
  },
  PullRequestConnection: {
    nodes: (_ctx, source: { repo: RepoRec; pulls: PullRec[] }) => list('PullRequest', source.pulls.map((pull) => ({ repo: source.repo, pull } satisfies PullSource))),
    pageInfo: () => object('PageInfo', { hasNextPage: false, endCursor: null, startCursor: null }),
  },
  PullRequestFilesConnection: {
    nodes: (_ctx, source: { paths: string[] }) => list('PullRequestChangedFile', source.paths.map((path) => ({ path }))),
  },
  PullRequestChangedFile: {
    path: (_ctx, source: { path: string }) => scalar(source.path),
  },
  IssueComment: {
    id: (_ctx, source: { uid: number }) => scalar(globalId('IssueComment', source.uid)),
    body: (_ctx, source: { body: string }) => scalar(source.body),
  },
  CreateIssuePayload: {
    issue: (_ctx, source: IssueSource) => object('Issue', source),
  },
  CloseIssuePayload: {
    issue: (_ctx, source: IssueSource) => object('Issue', source),
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, source: PullSource) => object('PullRequest', source),
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, source: PullSource) => object('PullRequest', source),
  },
  AddCommentPayload: {
    commentEdge: (_ctx, source: { uid: number; body: string }) => object('CommentEdge', source),
  },
  CommentEdge: {
    node: (_ctx, source: { uid: number; body: string }) => object('IssueComment', source),
    cursor: (_ctx, source: { uid: number }) => scalar(encodeCursor(source.uid)),
  },
  __Type: {
    name: (_ctx, source: string) => scalar(source),
    kind: (_ctx, source: string) => scalar(source in ENUM_VALUES ? 'ENUM' : 'OBJECT'),
    fields: (_ctx, source: string) => list('__Field', (TYPE_FIELDS[source] ?? []).map((name) => ({ name }))),
    enumValues: (_ctx, source: string) => list('__EnumValue', (ENUM_VALUES[source] ?? []).map((name) => ({ name }))),
  },
  __Field: {
    name: (_ctx, source: { name: string }) => scalar(source.name),
  },
  __EnumValue: {
    name: (_ctx, source: { name: string }) => scalar(source.name),
  },
  __Schema: {
    queryType: () => object('__Type', 'Query'),
    mutationType: () => object('__Type', 'Mutation'),
  },
};

function completeValue(ctx: Ctx, typed: Typed, selection: SelectionItem[] | null): unknown {
  switch (typed.form) {
    case 'null':
      return null;
    case 'scalar':
      return typed.value;
    case 'object':
      return selection === null ? {} : executeSelection(ctx, typed.type, typed.source, selection);
    case 'list':
      return typed.sources.map((source) => completeValue(ctx, { form: 'object', type: typed.type, source }, selection));
  }
}

function executeSelection(ctx: Ctx, type: string, source: unknown, selection: SelectionItem[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.fragmentOn !== null) {
      if (item.fragmentOn.startsWith('__spread:')) {
        const definition = ctx.fragments.get(item.fragmentOn.slice('__spread:'.length));
        if (definition !== undefined && definition.onType === type) {
          Object.assign(out, executeSelection(ctx, type, source, definition.selection));
        }
      } else if (item.fragmentOn === type) {
        Object.assign(out, executeSelection(ctx, type, source, item.selection));
      }
      continue;
    }
    const key = item.alias ?? item.name;
    if (item.name === '__typename') {
      out[key] = type;
      continue;
    }
    const resolver = RESOLVERS[type]?.[item.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${item.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(item.args)) args[name] = resolveValue(value, ctx.variables);
    try {
      const typed = resolver(ctx, source as never, args);
      out[key] = completeValue(ctx, typed, item.selection);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

function executeOne(store: Store, entry: unknown): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { errors: [{ message: 'a GraphQL request must be an object with a query' }] };
  }
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query === '') return { errors: [{ message: 'query is required' }] };
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const operation = (operationName !== null ? document.operations.find((op) => op.name === operationName) : undefined) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: Ctx = { store, variables, fragments: document.fragments, errors: [] };
  const data = executeSelection(ctx, operation.type === 'mutation' ? 'Mutation' : 'Query', null, operation.selection);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

/** Answer one POST /api/graphql body: one operation object, or GitHub's batch array in order. */
export function executeGraphQL(store: Store, payload: unknown): { status: number; body: unknown } {
  if (Array.isArray(payload)) return { status: 200, body: payload.map((entry) => executeOne(store, entry)) };
  return { status: 200, body: executeOne(store, payload) };
}
