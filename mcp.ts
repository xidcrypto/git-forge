// The MCP surface: JSON-RPC 2.0 over Streamable HTTP at /mcp, answering plain application/json.
// Both protocol eras the suite accepts are served: the 2026-07-28 revision's handshake-free
// `server/discover`, and the legacy initialize + notifications/initialized handshake. The tools
// are thin wrappers over domain.ts, so an object made over MCP is the same object over REST.
// The tools array is built once and served verbatim — two tools/list answers are byte-identical.

import { createIssue, createPull, DomainError, issueJson, mergePull, pullJson, repoJson } from './domain.ts';
import type { RepoRec, Store } from './store.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const OWNER_REPO_PROPS = {
  owner: { type: 'string', description: 'The repository owner (the token login)' },
  repo: { type: 'string', description: 'The repository name' },
  full_name: { type: 'string', description: 'The repository full name, owner/repo (alternative to owner and repo)' },
} as const;

export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: { type: 'object', properties: { ...OWNER_REPO_PROPS }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash)',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO_PROPS,
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

export interface McpAnswer {
  status: number;
  /** The JSON body; undefined for a notification's empty 202. */
  body?: unknown;
}

function rpcError(id: unknown, code: number, message: string): McpAnswer {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpAnswer {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve the repository a tool call addresses (owner/repo, or a full_name instead). */
function resolveRepo(store: Store, args: Record<string, unknown>): RepoRec {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [namedOwner, namedRepo] = args.full_name.split('/', 2);
    if (owner === '') owner = namedOwner as string;
    if (repo === '') repo = namedRepo as string;
  }
  const found = store.getRepo(owner, repo);
  if (found === null) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

function callTool(store: Store, name: string, args: Record<string, unknown>, id: unknown): McpAnswer {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(id, -32602, `missing required argument: ${required}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = args.name as string;
        if (store.repos.has(repoName)) return rpcResult(id, toolFailure(`repository ${repoName} already exists`));
        const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
        return rpcResult(id, toolResult(repoJson(store, repo)));
      }
      case 'get_repo': {
        return rpcResult(id, toolResult(repoJson(store, resolveRepo(store, args))));
      }
      case 'create_issue': {
        const repo = resolveRepo(store, args);
        const issue = createIssue(store, repo, {
          title: args.title as string,
          body: typeof args.body === 'string' ? args.body : '',
        });
        return rpcResult(id, toolResult(issueJson(store, repo, issue)));
      }
      case 'list_issues': {
        const repo = resolveRepo(store, args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => a.number - b.number);
        return rpcResult(id, toolResult(issues.map((issue) => issueJson(store, repo, issue))));
      }
      case 'create_pull_request': {
        const repo = resolveRepo(store, args);
        const pull = createPull(store, repo, {
          title: args.title as string,
          body: typeof args.body === 'string' ? args.body : '',
          head: args.head as string,
          base: args.base as string,
        });
        return rpcResult(id, toolResult(pullJson(store, repo, pull)));
      }
      case 'merge_pull_request': {
        const repo = resolveRepo(store, args);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const pull = repo.pulls.get(number);
        if (pull === undefined) return rpcResult(id, toolFailure(`pull request #${number} not found`));
        mergePull(store, repo, pull);
        return rpcResult(id, toolResult(pullJson(store, repo, pull)));
      }
      default:
        return rpcError(id, -32602, `unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof DomainError) return rpcResult(id, toolFailure(err.message));
    return rpcResult(id, toolFailure(err instanceof Error ? err.message : String(err)));
  }
}

/** Handle one JSON-RPC message (a request, or a notification with no id). */
function handleMessage(store: Store, message: Record<string, unknown>): McpAnswer {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (id === undefined) {
    // A notification: acknowledged with an empty 202, never a body.
    return { status: 202 };
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return callTool(store, toolName, args, id);
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Answer one POST /mcp. `rawBody` is the exact request text: a body that is not JSON is the
 * transport's parse error (HTTP 400, -32700); a JSON array is a batch, answered in order.
 * Authentication is app.ts's job and happens before this is called.
 */
export function handleMcp(store: Store, rawBody: string): McpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleMessage(store, (entry ?? {}) as Record<string, unknown>));
    const bodies = answers.map((answer) => answer.body).filter((body) => body !== undefined);
    if (bodies.length === 0) return { status: 202 };
    return { status: 200, body: bodies };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  return handleMessage(store, parsed as Record<string, unknown>);
}
