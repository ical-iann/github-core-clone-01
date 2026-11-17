// GraphQL over /api/graphql: the gh-style surface the suite exercises.
// A small hand-rolled parser + executor for the documented subset (queries,
// mutations, variables, aliases, inline input objects, inline fragments,
// __type introspection, batched operation arrays). Unknown fields are
// reported in `errors` with HTTP 200, never thrown as transport errors.
import type { ServerResponse } from 'node:http';
import {
  VIEWER,
  currentBaseSha,
  decodeNodeId,
  findRepo,
  findRepoByDbId,
  getObject,
  hasConflict,
  issueNodeId,
  nextSeq,
  nextTimestamp,
  pullNodeId,
  resolveRef,
  squashMerge,
  treeOfCommit,
  type Issue,
  type IssueComment,
  type Pull,
  type Repo,
} from './store.ts';
import { mergeBase } from './gitcore.ts';
import { errorJson, isAuthenticated, sendJson, type Ctx } from './http.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9\-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type Selection =
  | {
      kind: 'field';
      alias: string | null;
      name: string;
      args: Record<string, ValueNode>;
      selections: Selection[];
    }
  | { kind: 'fragment'; typeCondition: string | null; selections: Selection[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, ValueNode | undefined>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected '${value}' but got '${token.value}'`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`Expected name '${value ?? ''}' but got '${token.value}'`);
    }
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const varDefs: Record<string, ValueNode | undefined> = {};
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = token.value as 'query' | 'mutation';
      this.next();
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (token.kind === 'name' && token.value === 'fragment') {
      throw new Error('Named fragment definitions are not supported');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          varDefs[varName] = this.parseValue();
        } else {
          varDefs[varName] = undefined;
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, varDefs, selections };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (this.peek().kind === 'name') {
        throw new Error('Named fragment spreads are not supported');
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected token '${token.value}' as a value`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Typed values and field resolution
// ---------------------------------------------------------------------------

type TypedValue =
  | { __typename: 'User'; login: string; id: number; name?: string; email?: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; totalCount: number; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[]; totalCount: number; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestFileConnection'; repo: Repo; pull: Pull; files: { path: string; status: string }[] }
  | { __typename: 'PullRequestFile'; path: string; status: string }
  | { __typename: 'IssueCommentConnection'; repo: Repo; comments: IssueComment[] }
  | { __typename: 'IssueComment'; repo: Repo; comment: IssueComment }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'Label'; name: string; color: string }
  | { __typename: 'LabelConnection'; labels: { name: string; color: string }[] }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string; typeName: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: '__Schema' }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; repo: Repo; comment: IssueComment }
  | { __typename: 'CommentEdge'; repo: Repo; comment: IssueComment };

interface ExecState {
  errors: { message: string }[];
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'comments', 'labels', 'url', 'repository', 'viewerDidAuthor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'comments', 'labels', 'repository', 'url', 'isDraft', 'draft'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'private', 'url', 'createdAt', 'updatedAt', 'fork', 'isArchived', 'isDisabled', 'visibility', 'sshUrl', 'cloneUrl', 'homepageUrl'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId'],
  SearchType: [],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function typeKind(name: string): string {
  if (TYPE_ENUM_VALUES[name]) return 'ENUM';
  if (name === 'Query' || name === 'Mutation') return 'OBJECT';
  return 'OBJECT';
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function connectionFields<T>(
  items: T[],
  first: number | undefined,
  after: string | null | undefined,
  cursorOf: (item: T) => number,
): { page: T[]; hasNextPage: boolean; endCursor: string | null; totalCount: number } {
  const afterNumber = decodeCursor(after);
  let start = 0;
  if (afterNumber !== null) {
    const idx = items.findIndex((item) => cursorOf(item) === afterNumber);
    start = idx === -1 ? items.length : idx + 1;
  }
  const sliced = items.slice(start);
  const limit = first ?? 30;
  const page = sliced.slice(0, limit);
  return {
    page,
    hasNextPage: sliced.length > page.length,
    endCursor: page.length > 0 ? cursorFor(cursorOf(page[page.length - 1])) : null,
    totalCount: items.length,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  return hasConflict(repo, pull.headSha, currentBaseSha(repo, pull)) ? 'CONFLICTING' : 'MERGEABLE';
}

function pullFiles(repo: Repo, pull: Pull): { path: string; status: string }[] {
  const base = mergeBase(pull.headSha, pull.baseSha, getObject);
  const baseFiles = base ? treeOfCommit(base) : new Map<string, { mode: string; oid: string }>();
  const headFiles = treeOfCommit(pull.headSha);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: { path: string; status: string }[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = baseFiles.get(path);
    const newEntry = headFiles.get(path);
    if (oldEntry?.oid === newEntry?.oid) continue;
    const status = !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified';
    out.push({ path, status });
  }
  return out;
}

function userValue(login: string, id: number, name?: string, email?: string): TypedValue {
  return { __typename: 'User', login, id, name, email };
}

function resolveField(
  parent: TypedValue | null,
  typeName: string,
  field: Extract<Selection, { kind: 'field' }>,
  args: Record<string, unknown>,
  state: ExecState,
): unknown {
  if (parent === null) return null;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return userValue(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email);
      if (field.name === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (owner !== VIEWER.login) return null;
        const repo = owner && name ? findRepo(owner, name) : undefined;
        return repo ? ({ __typename: 'Repository', repo } as TypedValue) : null;
      }
      if (field.name === 'node') {
        const decoded = decodeNodeId(args.id as string);
        if (!decoded) return null;
        const repo = findRepoByDbId(decoded.dbId);
        if (!repo) return null;
        if (decoded.kind === 'repo') return { __typename: 'Repository', repo } as TypedValue;
        if (decoded.kind === 'issue') {
          const issue = repo.issues.find((entry) => entry.number === decoded.number);
          return issue ? ({ __typename: 'Issue', repo, issue } as TypedValue) : null;
        }
        if (decoded.kind === 'pr') {
          const pull = repo.pulls.find((entry) => entry.number === decoded.number);
          return pull ? ({ __typename: 'PullRequest', repo, pull } as TypedValue) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name as string | undefined;
        if (!name || !(TYPE_FIELDS[name] || TYPE_ENUM_VALUES[name])) return null;
        return { __typename: '__Type', name } as TypedValue;
      }
      if (field.name === '__schema') return { __typename: '__Schema' } as TypedValue;
      break;
    }
    case 'User': {
      const user = parent as Extract<TypedValue, { __typename: 'User' }>;
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return Buffer.from(`user:${user.id}`, 'utf8').toString('base64');
      if (field.name === 'databaseId') return user.id;
      if (field.name === 'name') return user.name ?? null;
      if (field.name === 'email') return user.email ?? null;
      if (field.name === 'url') return '';
      if (field.name === 'avatarUrl') return '';
      break;
    }
    case 'Repository': {
      const { repo } = parent as Extract<TypedValue, { __typename: 'Repository' }>;
      switch (field.name) {
        case 'id': return Buffer.from(`repo:${repo.dbId}`, 'utf8').toString('base64');
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userValue(repo.owner, VIEWER.id);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? ({ __typename: 'Ref', name: repo.defaultBranch } as TypedValue) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'private': return repo.isPrivate;
        case 'url': return '';
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'fork': return false;
        case 'isArchived': return false;
        case 'isDisabled': return false;
        case 'visibility': return repo.isPrivate ? 'PRIVATE' : 'PUBLIC';
        case 'sshUrl': return '';
        case 'cloneUrl': return '';
        case 'homepageUrl': return null;
        case 'issue': {
          const issue = repo.issues.find((entry) => entry.number === (args.number as number));
          return issue ? ({ __typename: 'Issue', repo, issue } as TypedValue) : null;
        }
        case 'issues': {
          const states = (args.states as string[] | undefined) ?? null;
          const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
          let list = [...repo.issues];
          if (states) {
            const wanted = new Set(states.map((s) => s.toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const direction = (orderBy.direction ?? 'DESC').toUpperCase();
          list.sort((a, b) =>
            direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
          );
          const conn = connectionFields(list, args.first as number | undefined, args.after as string | null | undefined, (issue) => issue.number);
          return { __typename: 'IssueConnection', repo, issues: conn.page, totalCount: conn.totalCount, hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } as TypedValue;
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((entry) => entry.number === (args.number as number));
          return pull ? ({ __typename: 'PullRequest', repo, pull } as TypedValue) : null;
        }
        case 'pullRequests': {
          const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
          const conn = connectionFields(list, args.first as number | undefined, args.after as string | null | undefined, (pull) => pull.number);
          return { __typename: 'PullRequestConnection', repo, pulls: conn.page, totalCount: conn.totalCount, hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } as TypedValue;
        }
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = parent as Extract<TypedValue, { __typename: 'Issue' }>;
      switch (field.name) {
        case 'id': return issueNodeId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'author': return userValue(VIEWER.login, VIEWER.id);
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.state === 'closed' ? issue.updatedAt : null;
        case 'url': return '';
        case 'viewerDidAuthor': return true;
        case 'repository': return { __typename: 'Repository', repo } as TypedValue;
        case 'comments': {
          const conn = connectionFields(issue.comments, args.first as number | undefined, args.after as string | null | undefined, (comment) => comment.id);
          return { __typename: 'IssueCommentConnection', repo, comments: conn.page } as TypedValue;
        }
        case 'labels': {
          const labels = issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' }));
          return { __typename: 'LabelConnection', labels } as TypedValue;
        }
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = parent as Extract<TypedValue, { __typename: 'PullRequest' }>;
      switch (field.name) {
        case 'id': return pullNodeId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return pullMergeable(repo, pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { __typename: 'Ref', name: pull.headRef } as TypedValue;
        case 'baseRef': return { __typename: 'Ref', name: pull.baseRef } as TypedValue;
        case 'author': return userValue(VIEWER.login, VIEWER.id);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'closedAt': return pull.state === 'closed' ? pull.updatedAt : null;
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommit': return null;
        case 'url': return '';
        case 'isDraft': return false;
        case 'draft': return false;
        case 'repository': return { __typename: 'Repository', repo } as TypedValue;
        case 'files': {
          const all = pullFiles(repo, pull);
          const conn = connectionFields(all, args.first as number | undefined, args.after as string | null | undefined, (file) => file.path.length);
          return { __typename: 'PullRequestFileConnection', repo, pull, files: conn.page } as TypedValue;
        }
        case 'comments': {
          const conn = connectionFields(pull.comments, args.first as number | undefined, args.after as string | null | undefined, (comment) => comment.id);
          return { __typename: 'IssueCommentConnection', repo, comments: conn.page } as TypedValue;
        }
        case 'labels': return { __typename: 'LabelConnection', labels: [] } as TypedValue;
      }
      break;
    }
    case 'IssueConnection': {
      const conn = parent as Extract<TypedValue, { __typename: 'IssueConnection' }>;
      if (field.name === 'nodes') {
        return conn.issues.map((issue) => ({ __typename: 'Issue', repo: conn.repo, issue }) as TypedValue);
      }
      if (field.name === 'edges') {
        return conn.issues.map((issue) => ({
          node: { __typename: 'Issue', repo: conn.repo, issue } as TypedValue,
          cursor: cursorFor(issue.number),
        }));
      }
      if (field.name === 'totalCount') return conn.totalCount;
      if (field.name === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: conn.hasNextPage,
          endCursor: conn.endCursor,
        } as TypedValue;
      }
      break;
    }
    case 'PullRequestConnection': {
      const conn = parent as Extract<TypedValue, { __typename: 'PullRequestConnection' }>;
      if (field.name === 'nodes') {
        return conn.pulls.map((pull) => ({ __typename: 'PullRequest', repo: conn.repo, pull }) as TypedValue);
      }
      if (field.name === 'edges') {
        return conn.pulls.map((pull) => ({
          node: { __typename: 'PullRequest', repo: conn.repo, pull } as TypedValue,
          cursor: cursorFor(pull.number),
        }));
      }
      if (field.name === 'totalCount') return conn.totalCount;
      if (field.name === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: conn.hasNextPage,
          endCursor: conn.endCursor,
        } as TypedValue;
      }
      break;
    }
    case 'PullRequestFileConnection': {
      const conn = parent as Extract<TypedValue, { __typename: 'PullRequestFileConnection' }>;
      if (field.name === 'nodes') {
        return conn.files.map((file) => ({ __typename: 'PullRequestFile', ...file }) as TypedValue);
      }
      if (field.name === 'edges') {
        return conn.files.map((file) => ({
          node: { __typename: 'PullRequestFile', ...file } as TypedValue,
          cursor: cursorFor(file.path.length),
        }));
      }
      if (field.name === 'totalCount') return conn.files.length;
      if (field.name === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } as TypedValue;
      }
      break;
    }
    case 'PullRequestFile': {
      const file = parent as Extract<TypedValue, { __typename: 'PullRequestFile' }>;
      if (field.name === 'path') return file.path;
      if (field.name === 'status') return file.status;
      break;
    }
    case 'IssueCommentConnection': {
      const conn = parent as Extract<TypedValue, { __typename: 'IssueCommentConnection' }>;
      if (field.name === 'nodes') {
        return conn.comments.map((comment) => ({ __typename: 'IssueComment', repo: conn.repo, comment }) as TypedValue);
      }
      if (field.name === 'totalCount') return conn.comments.length;
      if (field.name === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } as TypedValue;
      }
      break;
    }
    case 'IssueComment': {
      const { comment } = parent as Extract<TypedValue, { __typename: 'IssueComment' }>;
      if (field.name === 'id') return Buffer.from(`comment:${comment.id}`, 'utf8').toString('base64');
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return userValue(comment.authorLogin, VIEWER.id);
      if (field.name === 'createdAt') return comment.createdAt;
      if (field.name === 'updatedAt') return comment.updatedAt;
      break;
    }
    case 'Ref': {
      const ref = parent as Extract<TypedValue, { __typename: 'Ref' }>;
      if (field.name === 'name') return ref.name;
      break;
    }
    case 'PageInfo': {
      const page = parent as Extract<TypedValue, { __typename: 'PageInfo' }>;
      if (field.name === 'hasNextPage') return page.hasNextPage;
      if (field.name === 'endCursor') return page.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      break;
    }
    case 'LabelConnection': {
      const conn = parent as Extract<TypedValue, { __typename: 'LabelConnection' }>;
      if (field.name === 'nodes') {
        return conn.labels.map((label) => ({ __typename: 'Label', ...label }) as TypedValue);
      }
      if (field.name === 'totalCount') return conn.labels.length;
      break;
    }
    case 'Label': {
      const label = parent as Extract<TypedValue, { __typename: 'Label' }>;
      if (field.name === 'name') return label.name;
      if (field.name === 'color') return label.color;
      break;
    }
    case '__Type': {
      const t = parent as Extract<TypedValue, { __typename: '__Type' }>;
      if (field.name === 'name') return t.name;
      if (field.name === 'kind') return typeKind(t.name);
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        return (TYPE_FIELDS[t.name] ?? []).map(
          (name) => ({ __typename: '__Field', name, typeName: 'String' }) as TypedValue,
        );
      }
      if (field.name === 'enumValues') {
        return (TYPE_ENUM_VALUES[t.name] ?? []).map(
          (name) => ({ __typename: '__EnumValue', name }) as TypedValue,
        );
      }
      break;
    }
    case '__Field': {
      const f = parent as Extract<TypedValue, { __typename: '__Field' }>;
      if (field.name === 'name') return f.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return { name: f.typeName, kind: 'SCALAR', ofType: null };
      if (field.name === 'args') return [];
      break;
    }
    case '__EnumValue': {
      const e = parent as Extract<TypedValue, { __typename: '__EnumValue' }>;
      if (field.name === 'name') return e.name;
      if (field.name === 'description') return null;
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return { name: 'Query', kind: 'OBJECT' };
      if (field.name === 'mutationType') return { name: 'Mutation', kind: 'OBJECT' };
      if (field.name === 'subscriptionType') return null;
      if (field.name === 'types') {
        return Object.keys(TYPE_FIELDS).map((name) => ({ name, kind: typeKind(name) }));
      }
      if (field.name === 'directives') return [];
      break;
    }
    case 'Mutation': {
      return resolveMutation(field, args, state);
    }
    default: {
      if (field.name === 'id' && (parent as { __typename: string }).__typename) {
        // Generic id fallback for payload types handled below.
      }
      break;
    }
  }
  state.errors.push({
    message: `Cannot query field "${field.name}" on type "${typeName}".`,
  });
  return null;
}

// Payload field resolution (createIssue, closeIssue, ...).
function resolvePayloadField(
  parent: TypedValue,
  field: Extract<Selection, { kind: 'field' }>,
  state: ExecState,
): unknown {
  switch (parent.__typename) {
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const p = parent as Extract<TypedValue, { __typename: 'CreateIssuePayload' | 'CloseIssuePayload' }>;
      if (field.name === 'issue') return { __typename: 'Issue', repo: p.repo, issue: p.issue } as TypedValue;
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const p = parent as Extract<TypedValue, { __typename: 'CreatePullRequestPayload' | 'MergePullRequestPayload' }>;
      if (field.name === 'pullRequest') return { __typename: 'PullRequest', repo: p.repo, pull: p.pull } as TypedValue;
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      const p = parent as Extract<TypedValue, { __typename: 'AddCommentPayload' }>;
      if (field.name === 'commentEdge') return { __typename: 'CommentEdge', repo: p.repo, comment: p.comment } as TypedValue;
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'CommentEdge': {
      const p = parent as Extract<TypedValue, { __typename: 'CommentEdge' }>;
      if (field.name === 'node') return { __typename: 'IssueComment', repo: p.repo, comment: p.comment } as TypedValue;
      if (field.name === 'cursor') return cursorFor(p.comment.id);
      break;
    }
  }
  state.errors.push({
    message: `Cannot query field "${field.name}" on type "${parent.__typename}".`,
  });
  return null;
}

function isPayloadType(typeName: string): boolean {
  return (
    typeName === 'CreateIssuePayload' ||
    typeName === 'CloseIssuePayload' ||
    typeName === 'CreatePullRequestPayload' ||
    typeName === 'MergePullRequestPayload' ||
    typeName === 'AddCommentPayload' ||
    typeName === 'CommentEdge'
  );
}

function repoById(id: unknown): Repo | undefined {
  // The mutations take the repository's global (node) id; accept the numeric
  // databaseId too.
  if (typeof id === 'string') {
    const decoded = decodeNodeId(id);
    if (decoded?.kind === 'repo') return findRepoByDbId(decoded.dbId);
    const numeric = Number(id);
    if (Number.isFinite(numeric)) return findRepoByDbId(numeric);
    return undefined;
  }
  if (typeof id === 'number') return findRepoByDbId(id);
  return undefined;
}

function resolveMutation(
  field: Extract<Selection, { kind: 'field' }>,
  args: Record<string, unknown>,
  state: ExecState,
): TypedValue | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === 'createIssue') {
    const repo = repoById(input.repositoryId);
    if (!repo) {
      state.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const title = input.title as string | undefined;
    if (!title) {
      state.errors.push({ message: 'Field "title" of required type "String!" was not provided.' });
      return null;
    }
    const createdAt = nextTimestamp();
    const issue: Issue = {
      number: repo.nextIssueNumber++,
      title,
      body: (input.body as string | undefined) ?? '',
      state: 'open',
      labels: [],
      createdSeq: nextSeq(),
      createdAt,
      updatedAt: createdAt,
      comments: [],
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', repo, issue } as TypedValue;
  }
  if (field.name === 'closeIssue') {
    const decoded = decodeNodeId(input.issueId as string);
    const repo = decoded ? findRepoByDbId(decoded.dbId) : undefined;
    const issue = repo?.issues.find((entry) => entry.number === decoded?.number);
    if (!repo || !issue) {
      state.errors.push({ message: 'Issue not found.' });
      return null;
    }
    issue.state = 'closed';
    issue.updatedAt = nextTimestamp();
    return { __typename: 'CloseIssuePayload', repo, issue } as TypedValue;
  }
  if (field.name === 'createPullRequest') {
    const repo = repoById(input.repositoryId);
    if (!repo) {
      state.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const headRef = input.headRefName as string;
    const baseRef = input.baseRefName as string;
    const headSha = resolveRef(repo, headRef);
    const baseSha = resolveRef(repo, baseRef);
    if (!headSha || !baseSha) {
      state.errors.push({ message: 'Head or base ref does not exist.' });
      return null;
    }
    const createdAt = nextTimestamp();
    const pull: Pull = {
      number: repo.nextPullNumber++,
      title: (input.title as string | undefined) ?? '',
      body: (input.body as string | undefined) ?? '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: nextSeq(),
      createdAt,
      updatedAt: createdAt,
      comments: [],
    };
    repo.pulls.push(pull);
    return { __typename: 'CreatePullRequestPayload', repo, pull } as TypedValue;
  }
  if (field.name === 'mergePullRequest') {
    const decoded = decodeNodeId(input.pullRequestId as string);
    const repo = decoded ? findRepoByDbId(decoded.dbId) : undefined;
    const pull = repo?.pulls.find((entry) => entry.number === decoded?.number);
    if (!repo || !pull) {
      state.errors.push({ message: 'Pull request not found.' });
      return null;
    }
    if (pull.state === 'closed') {
      state.errors.push({ message: 'Pull request is already closed.' });
      return null;
    }
    const merged = squashMerge(repo, pull);
    if (merged === null) {
      state.errors.push({ message: 'Merge conflict.' });
      return null;
    }
    return { __typename: 'MergePullRequestPayload', repo, pull } as TypedValue;
  }
  if (field.name === 'addComment') {
    const decoded = decodeNodeId(input.subjectId as string);
    const repo = decoded ? findRepoByDbId(decoded.dbId) : undefined;
    const body = input.body as string | undefined;
    if (!body) {
      state.errors.push({ message: 'Field "body" of required type "String!" was not provided.' });
      return null;
    }
    if (!repo || !decoded) {
      state.errors.push({ message: 'Subject not found.' });
      return null;
    }
    const createdAt = nextTimestamp();
    const comment: IssueComment = {
      id: repo.nextCommentId++,
      body,
      authorLogin: VIEWER.login,
      createdAt,
      updatedAt: createdAt,
    };
    if (decoded.kind === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === decoded.number);
      if (!issue) {
        state.errors.push({ message: 'Issue not found.' });
        return null;
      }
      issue.comments.push(comment);
      issue.updatedAt = nextTimestamp();
    } else if (decoded.kind === 'pr') {
      const pull = repo.pulls.find((entry) => entry.number === decoded.number);
      if (!pull) {
        state.errors.push({ message: 'Pull request not found.' });
        return null;
      }
      pull.comments.push(comment);
      pull.updatedAt = nextTimestamp();
    } else {
      state.errors.push({ message: 'Subject not found.' });
      return null;
    }
    return { __typename: 'AddCommentPayload', repo, comment } as TypedValue;
  }
  state.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

// ---------------------------------------------------------------------------
// Selection application
// ---------------------------------------------------------------------------

function applySelections(
  typeName: string,
  value: unknown,
  selections: Selection[],
  variables: Record<string, unknown>,
  state: ExecState,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => applySelections(typeName, entry, selections, variables, state));
  }
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && selection.typeCondition !== typeName) continue;
      const nested = applySelections(typeName, value, selection.selections, variables, state);
      if (nested && typeof nested === 'object') Object.assign(out, nested);
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, node] of Object.entries(selection.args)) {
      args[key] = resolveValue(node, variables);
    }
    const key = selection.alias ?? selection.name;
    let fieldValue: unknown;
    if (isPayloadType(typeName)) {
      fieldValue = resolvePayloadField(value as TypedValue, selection, state);
    } else {
      fieldValue = resolveField(value as TypedValue, typeName, selection, args, state);
    }
    if (selection.selections.length > 0 && fieldValue !== null && fieldValue !== undefined) {
      if (Array.isArray(fieldValue)) {
        // Lists of typed values (nodes/edges): each element keeps its own type.
        out[key] = fieldValue.map((entry) => {
          if (entry && typeof entry === 'object' && '__typename' in entry) {
            return applySelections((entry as { __typename: string }).__typename, entry, selection.selections, variables, state);
          }
          if (entry && typeof entry === 'object' && 'node' in entry) {
            // Edge objects: {node, cursor} — selections apply to the node.
            const edge = entry as { node: unknown; cursor?: string };
            const edgeOut: Record<string, unknown> = {};
            for (const edgeSel of selection.selections) {
              if (edgeSel.kind === 'field' && edgeSel.name === 'cursor') edgeOut[edgeSel.alias ?? 'cursor'] = edge.cursor ?? null;
              else if (edgeSel.kind === 'field' && edgeSel.name === 'node') {
                const node = edge.node;
                edgeOut[edgeSel.alias ?? 'node'] =
                  node && typeof node === 'object' && '__typename' in node
                    ? applySelections((node as { __typename: string }).__typename, node, edgeSel.selections, variables, state)
                    : node;
              }
            }
            return edgeOut;
          }
          return entry;
        });
      } else if (typeof fieldValue === 'object' && '__typename' in (fieldValue as object)) {
        out[key] = applySelections(
          (fieldValue as { __typename: string }).__typename,
          fieldValue,
          selection.selections,
          variables,
          state,
        );
      } else if (typeof fieldValue === 'object') {
        // Plain object (e.g. __Field.type): apply selections generically.
        out[key] = applyPlainSelections(fieldValue as Record<string, unknown>, selection.selections, variables, state);
      } else {
        out[key] = fieldValue;
      }
    } else {
      out[key] = fieldValue;
    }
  }
  return out;
}

function applyPlainSelections(
  value: Record<string, unknown>,
  selections: Selection[],
  variables: Record<string, unknown>,
  state: ExecState,
): Record<string, unknown> {
  void variables;
  void state;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') continue;
    out[selection.alias ?? selection.name] = value[selection.name] ?? null;
  }
  return out;
}

function executeOperation(
  operation: Operation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const state: ExecState = { errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: TypedValue = { __typename: rootType } as unknown as TypedValue;
  const data = applySelections(rootType, root, operation.selections, variables, state) as Record<string, unknown>;
  if (state.errors.length > 0) {
    return { data, errors: state.errors };
  }
  return { data };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export function handleGraphQL(res: ServerResponse, ctx: Ctx): boolean {
  if (ctx.segments.length !== 2 || ctx.segments[0] !== 'api' || ctx.segments[1] !== 'graphql') {
    return false;
  }
  if (!isAuthenticated(ctx)) {
    errorJson(res, ctx, 401, 'Requires authentication');
    return true;
  }
  if (ctx.method !== 'POST') {
    errorJson(res, ctx, 405, 'Method Not Allowed');
    return true;
  }
  const body = ctx.json;
  const operations: { query: string; variables?: Record<string, unknown> }[] = [];
  if (Array.isArray(body)) {
    for (const entry of body) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).query === 'string') {
        operations.push(entry as { query: string; variables?: Record<string, unknown> });
      }
    }
  } else if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).query === 'string') {
    operations.push(body as { query: string; variables?: Record<string, unknown> });
  } else {
    sendJson(res, ctx, 400, { errors: [{ message: 'Request must include a query string.' }] });
    return true;
  }
  const results = operations.map((operation) => {
    let parsed: Operation[];
    try {
      parsed = new Parser(tokenize(operation.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
    }
    const variables = operation.variables ?? {};
    if (parsed.length === 0) return { data: null, errors: [{ message: 'Empty document.' }] };
    if (parsed.length > 1) {
      // Multiple operations in one document: answer the first; batched
      // requests arrive as a JSON array instead.
      return executeOperation(parsed[0], variables);
    }
    return executeOperation(parsed[0], variables);
  });
  sendJson(res, ctx, 200, Array.isArray(body) ? results : results[0]);
  return true;
}
