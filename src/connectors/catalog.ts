import type { ConnectorCapability, ConnectorManifest } from './types.js';
import { RestConnectorAdapter, optionalInteger, requiredString } from './rest-adapter.js';

function parameters(properties: ConnectorCapability['parameters']['properties'], required: string[] = []): ConnectorCapability['parameters'] {
  return { type: 'object', properties, required };
}

function capability(
  id: string,
  name: string,
  description: string,
  permission: ConnectorCapability['permission'],
  properties: ConnectorCapability['parameters']['properties'],
  required: string[] = [],
): ConnectorCapability {
  return { id, name, description, permission, parameters: parameters(properties, required) };
}

function manifest(
  id: string,
  name: string,
  description: string,
  category: ConnectorManifest['category'],
  fields: ConnectorManifest['auth']['fields'],
  capabilities: ConnectorCapability[],
): ConnectorManifest {
  return {
    id,
    name,
    description,
    version: '1.0.0',
    category,
    transport: 'rest',
    auth: { type: 'bearer', fields },
    capabilities,
  };
}

function createGitHostingConnectors(fetcher: typeof fetch): RestConnectorAdapter[] {
  const tokenFields = [{
    id: 'token',
    label: 'Access token',
    description: 'Use a token scoped to the repositories and read operations Symbiote should access.',
    required: true,
    secret: true,
  }];
  const hosts = [
    {
      id: 'gitlab',
      name: 'GitLab',
      description: 'Search projects, inspect repositories, issues, and merge requests across GitLab.com or a self-managed instance.',
      baseUrl: 'https://gitlab.com/api/v4',
      probePath: '/user',
      tokenHeader: 'PRIVATE-TOKEN',
      kind: 'gitlab',
    },
    {
      id: 'gitee',
      name: 'Gitee',
      description: 'Search repositories and inspect repository metadata, issues, and pull requests on Gitee.',
      baseUrl: 'https://gitee.com/api/v5',
      probePath: '/user',
      tokenQuery: 'access_token',
      kind: 'gitee',
    },
    {
      id: 'bitbucket',
      name: 'Bitbucket Cloud',
      description: 'Search workspace repositories and inspect repository metadata, issues, and pull requests.',
      baseUrl: 'https://api.bitbucket.org/2.0',
      probePath: '/user',
      kind: 'bitbucket',
    },
    {
      id: 'codeberg',
      name: 'Codeberg',
      description: 'Search repositories and inspect repository metadata, issues, and pull requests on Codeberg.',
      baseUrl: 'https://codeberg.org/api/v1',
      probePath: '/user',
      kind: 'codeberg',
    },
  ] as const;

  return hosts.map(host => {
    const capabilities = [
      capability('search_repositories', 'Search repositories', `Search repositories visible to the connected ${host.name} account.`, 'read', {
        query: { type: 'string' },
        perPage: { type: 'number', description: 'Maximum results (1–50, default 10).' },
        owner: { type: 'string', description: 'Workspace for Bitbucket repository search.' },
      }, ['query', ...(host.kind === 'bitbucket' ? ['owner'] : [])]),
      capability('get_repository', 'Get repository', 'Read repository metadata.', 'read', {
        owner: { type: 'string' },
        repository: { type: 'string', description: 'Repository name, or full namespace/project path for GitLab.' },
      }, ['owner', 'repository']),
      capability('list_issues', 'List issues', 'List issues in a repository.', 'read', {
        owner: { type: 'string' },
        repository: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        perPage: { type: 'number', description: 'Maximum results (1–50, default 20).' },
      }, ['owner', 'repository']),
      capability('list_pull_requests', 'List pull requests', 'List pull requests or merge requests in a repository.', 'read', {
        owner: { type: 'string' },
        repository: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        perPage: { type: 'number', description: 'Maximum results (1–50, default 20).' },
      }, ['owner', 'repository']),
    ];
    const serviceManifest = manifest(
      host.id,
      host.name,
      host.description,
      'development',
      tokenFields,
      capabilities,
    );
    const adapter = new RestConnectorAdapter({
      manifest: serviceManifest,
      baseUrl: host.baseUrl,
      probePath: host.probePath,
      ...('tokenHeader' in host ? { tokenHeader: host.tokenHeader } : {}),
      ...('tokenQuery' in host ? { tokenQuery: host.tokenQuery } : {}),
      fetcher,
    }, [
      {
        capability: capabilities[0],
        buildRequest(input) {
          const query = requiredString(input, 'query', 500);
          const perPage = optionalInteger(input, 'perPage', 10, 1, 50);
          switch (host.kind) {
            case 'gitlab':
              return { method: 'GET', path: '/projects', query: { search: query, per_page: perPage, membership: true } };
            case 'gitee':
              return { method: 'GET', path: '/search/repositories', query: { q: query, per_page: perPage } };
            case 'bitbucket': {
              const owner = requiredString(input, 'owner', 200);
              return { method: 'GET', path: `/repositories/${encodeURIComponent(owner)}`, query: { q: `name~"${query.replace(/["\\]/g, '')}"`, pagelen: perPage } };
            }
            case 'codeberg':
              return { method: 'GET', path: '/repos/search', query: { q: query, limit: perPage } };
          }
        },
      },
      {
        capability: capabilities[1],
        buildRequest(input) {
          const owner = requiredString(input, 'owner', 200);
          const repository = requiredString(input, 'repository', 200);
          if (host.kind === 'gitlab') {
            return { method: 'GET', path: `/projects/${encodeURIComponent(`${owner}/${repository}`)}` };
          }
          return {
            method: 'GET',
            path: host.kind === 'bitbucket'
              ? `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
              : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
          };
        },
      },
      {
        capability: capabilities[2],
        buildRequest(input) {
          const state = String(input.state ?? 'open');
          if (!['open', 'closed', 'all'].includes(state)) throw new Error('state must be open, closed, or all.');
          const owner = requiredString(input, 'owner', 200);
          const repository = requiredString(input, 'repository', 200);
          const perPage = optionalInteger(input, 'perPage', 20, 1, 50);
          const page = host.kind === 'gitlab'
            ? `/projects/${encodeURIComponent(`${owner}/${repository}`)}/issues`
            : host.kind === 'bitbucket'
              ? `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`
              : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`;
          const query: Record<string, string | number> = host.kind === 'gitlab'
            ? { state, per_page: perPage }
            : host.kind === 'bitbucket'
              ? { pagelen: perPage, ...(state !== 'all' ? { q: `state="${state.toUpperCase()}"` } : {}) }
              : { state, ...(host.kind === 'gitee' ? { per_page: perPage } : { limit: perPage }) };
          return { method: 'GET', path: page, query };
        },
      },
      {
        capability: capabilities[3],
        buildRequest(input) {
          const state = String(input.state ?? 'open');
          if (!['open', 'closed', 'all'].includes(state)) throw new Error('state must be open, closed, or all.');
          const owner = requiredString(input, 'owner', 200);
          const repository = requiredString(input, 'repository', 200);
          const perPage = optionalInteger(input, 'perPage', 20, 1, 50);
          const page = host.kind === 'gitlab'
            ? `/projects/${encodeURIComponent(`${owner}/${repository}`)}/merge_requests`
            : host.kind === 'bitbucket'
              ? `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pullrequests`
              : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`;
          const query: Record<string, string | number> = host.kind === 'gitlab'
            ? { state: state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'opened', per_page: perPage }
            : host.kind === 'bitbucket'
              ? { pagelen: perPage, ...(state !== 'all' ? { state: state.toUpperCase() } : {}) }
              : { state, ...(host.kind === 'gitee' ? { per_page: perPage } : { limit: perPage }) };
          return { method: 'GET', path: page, query };
        },
      },
    ]);

    return adapter;
  });
}

const tokenField = [{
  id: 'token',
  label: 'Access token',
  description: 'Stored encrypted in Symbiote’s credential vault.',
  required: true,
  secret: true,
}];

export function createBuiltinConnectors(fetcher: typeof fetch = fetch): RestConnectorAdapter[] {
  const github = manifest(
    'github',
    'GitHub',
    'Search repositories, inspect issues and pull requests using a scoped GitHub token.',
    'development',
    tokenField,
    [
      capability('search_repositories', 'Search repositories', 'Find repositories visible to the connected account.', 'read', {
        query: { type: 'string', description: 'GitHub repository search query.' },
        perPage: { type: 'number', description: 'Results per page (1–50, default 10).' },
      }, ['query']),
      capability('get_repository', 'Get repository', 'Read repository metadata.', 'read', {
        owner: { type: 'string' }, repository: { type: 'string' },
      }, ['owner', 'repository']),
      capability('list_issues', 'List issues', 'List repository issues, including pull requests only when requested by the endpoint.', 'read', {
        owner: { type: 'string' },
        repository: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        perPage: { type: 'number', description: 'Results per page (1–50, default 20).' },
      }, ['owner', 'repository']),
      capability('list_pull_requests', 'List pull requests', 'List pull requests in a repository.', 'read', {
        owner: { type: 'string' },
        repository: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        perPage: { type: 'number', description: 'Results per page (1–50, default 20).' },
      }, ['owner', 'repository']),
    ],
  );
  const githubAdapter = new RestConnectorAdapter({
    manifest: github,
    baseUrl: 'https://api.github.com',
    probePath: '/user',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    fetcher,
  }, [
    {
      capability: github.capabilities[0],
      buildRequest(input) {
        return {
          method: 'GET',
          path: '/search/repositories',
          query: {
            q: requiredString(input, 'query'),
            per_page: optionalInteger(input, 'perPage', 10, 1, 50),
          },
        };
      },
    },
    {
      capability: github.capabilities[1],
      buildRequest(input) {
        return {
          method: 'GET',
          path: `/repos/${encodeURIComponent(requiredString(input, 'owner', 100))}/${encodeURIComponent(requiredString(input, 'repository', 100))}`,
        };
      },
    },
    {
      capability: github.capabilities[2],
      buildRequest(input) {
        const state = input.state ?? 'open';
        if (!['open', 'closed', 'all'].includes(String(state))) throw new Error('state must be open, closed, or all.');
        return {
          method: 'GET',
          path: `/repos/${encodeURIComponent(requiredString(input, 'owner', 100))}/${encodeURIComponent(requiredString(input, 'repository', 100))}/issues`,
          query: { state: String(state), per_page: optionalInteger(input, 'perPage', 20, 1, 50) },
        };
      },
    },
    {
      capability: github.capabilities[3],
      buildRequest(input) {
        const state = input.state ?? 'open';
        if (!['open', 'closed', 'all'].includes(String(state))) throw new Error('state must be open, closed, or all.');
        return {
          method: 'GET',
          path: `/repos/${encodeURIComponent(requiredString(input, 'owner', 100))}/${encodeURIComponent(requiredString(input, 'repository', 100))}/pulls`,
          query: { state: String(state), per_page: optionalInteger(input, 'perPage', 20, 1, 50) },
        };
      },
    },
  ]);

  const notion = manifest(
    'notion',
    'Notion',
    'Search shared pages and inspect page content through the Notion API.',
    'knowledge',
    tokenField,
    [
      capability('search', 'Search pages', 'Search pages and databases available to the integration.', 'read', {
        query: { type: 'string', description: 'Text to search for.' },
        pageSize: { type: 'number', description: 'Maximum results (1–50, default 20).' },
      }, ['query']),
      capability('get_page', 'Get page', 'Read a Notion page by ID.', 'read', {
        pageId: { type: 'string' },
      }, ['pageId']),
      capability('list_block_children', 'Read page blocks', 'Read the block children of a page or block.', 'read', {
        blockId: { type: 'string' },
        pageSize: { type: 'number', description: 'Maximum results (1–100, default 50).' },
      }, ['blockId']),
      capability('create_page', 'Create page', 'Create a page under a parent page or database.', 'create', {
        parent: { type: 'object', description: 'Notion parent object, such as {page_id} or {database_id}.' },
        properties: { type: 'object', description: 'Notion page properties.' },
        children: { type: 'array', description: 'Optional Notion block children.' },
      }, ['parent', 'properties']),
    ],
  );
  const notionAdapter = new RestConnectorAdapter({
    manifest: notion,
    baseUrl: 'https://api.notion.com',
    probePath: '/v1/search',
    headers: { 'Notion-Version': '2022-06-28' },
    fetcher,
  }, [
    {
      capability: notion.capabilities[0],
      buildRequest(input) {
        return {
          method: 'POST',
          path: '/v1/search',
          body: {
            query: requiredString(input, 'query'),
            page_size: optionalInteger(input, 'pageSize', 20, 1, 50),
          },
        };
      },
    },
    {
      capability: notion.capabilities[1],
      buildRequest(input) {
        return { method: 'GET', path: `/v1/pages/${encodeURIComponent(requiredString(input, 'pageId', 100))}` };
      },
    },
    {
      capability: notion.capabilities[2],
      buildRequest(input) {
        return {
          method: 'GET',
          path: `/v1/blocks/${encodeURIComponent(requiredString(input, 'blockId', 100))}/children`,
          query: { page_size: optionalInteger(input, 'pageSize', 50, 1, 100) },
        };
      },
    },
    {
      capability: notion.capabilities[3],
      buildRequest(input) {
        if (!input.parent || typeof input.parent !== 'object' || Array.isArray(input.parent)
          || !input.properties || typeof input.properties !== 'object' || Array.isArray(input.properties)) {
          throw new Error('parent and properties must be JSON objects.');
        }
        if (input.children !== undefined && !Array.isArray(input.children)) {
          throw new Error('children must be a JSON array.');
        }
        return {
          method: 'POST',
          path: '/v1/pages',
          body: {
            parent: input.parent as Record<string, unknown>,
            properties: input.properties as Record<string, unknown>,
            ...(input.children ? { children: input.children } : {}),
          },
        };
      },
    },
  ]);

  const slack = manifest(
    'slack',
    'Slack',
    'Search messages, inspect channels and post messages with a Slack bot token.',
    'communication',
    tokenField,
    [
      capability('search_messages', 'Search messages', 'Search messages visible to the connected Slack app.', 'read', {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Maximum results (1–100, default 20).' },
      }, ['query']),
      capability('list_conversations', 'List conversations', 'List conversations visible to the bot.', 'read', {
        limit: { type: 'number', description: 'Maximum results (1–200, default 100).' },
        cursor: { type: 'string' },
      }),
      capability('get_conversation_history', 'Get conversation history', 'Read recent messages in a conversation.', 'read', {
        channel: { type: 'string' },
        limit: { type: 'number', description: 'Maximum results (1–100, default 20).' },
        cursor: { type: 'string' },
      }, ['channel']),
      capability('post_message', 'Post message', 'Send a message to a Slack conversation. Grant this capability explicitly.', 'create', {
        channel: { type: 'string' },
        text: { type: 'string', description: 'Message text (up to 40,000 characters).' },
      }, ['channel', 'text']),
    ],
  );
  const slackAdapter = new RestConnectorAdapter({
    manifest: slack,
    baseUrl: 'https://slack.com/api',
    probePath: '/auth.test',
    fetcher,
  }, [
    {
      capability: slack.capabilities[0],
      buildRequest(input) {
        return {
          method: 'GET',
          path: '/search.messages',
          query: {
            query: requiredString(input, 'query'),
            count: optionalInteger(input, 'limit', 20, 1, 100),
          },
        };
      },
    },
    {
      capability: slack.capabilities[1],
      buildRequest(input) {
        const query: Record<string, string | number> = {
          limit: optionalInteger(input, 'limit', 100, 1, 200),
        };
        if (typeof input.cursor === 'string' && input.cursor.length > 0) query.cursor = input.cursor.slice(0, 2_000);
        return { method: 'GET', path: '/conversations.list', query };
      },
    },
    {
      capability: slack.capabilities[2],
      buildRequest(input) {
        const query: Record<string, string | number> = {
          channel: requiredString(input, 'channel', 200),
          limit: optionalInteger(input, 'limit', 20, 1, 100),
        };
        if (typeof input.cursor === 'string' && input.cursor.length > 0) query.cursor = input.cursor.slice(0, 2_000);
        return { method: 'GET', path: '/conversations.history', query };
      },
    },
    {
      capability: slack.capabilities[3],
      buildRequest(input) {
        return {
          method: 'POST',
          path: '/chat.postMessage',
          body: {
            channel: requiredString(input, 'channel', 200),
            text: requiredString(input, 'text', 40_000),
          },
        };
      },
    },
  ]);

  const figma = manifest(
    'figma',
    'Figma',
    'Inspect Figma account, files and file nodes with a personal access token.',
    'design',
    tokenField,
    [
      capability('get_profile', 'Get profile', 'Read the connected Figma user profile.', 'read', {}),
      capability('get_file', 'Get file', 'Read a Figma file document.', 'read', {
        fileKey: { type: 'string' },
        depth: { type: 'number', description: 'Optional file tree depth (1–5).' },
      }, ['fileKey']),
      capability('get_file_nodes', 'Get file nodes', 'Read selected nodes from a Figma file.', 'read', {
        fileKey: { type: 'string' },
        nodeIds: { type: 'string', description: 'Comma-separated Figma node IDs.' },
      }, ['fileKey', 'nodeIds']),
    ],
  );
  const figmaAdapter = new RestConnectorAdapter({
    manifest: figma,
    baseUrl: 'https://api.figma.com',
    probePath: '/v1/me',
    tokenHeader: 'X-Figma-Token',
    fetcher,
  }, [
    { capability: figma.capabilities[0], buildRequest: () => ({ method: 'GET', path: '/v1/me' }) },
    {
      capability: figma.capabilities[1],
      buildRequest(input) {
        const depth = input.depth === undefined ? undefined : optionalInteger(input, 'depth', 3, 1, 5);
        return {
          method: 'GET',
          path: `/v1/files/${encodeURIComponent(requiredString(input, 'fileKey', 200))}`,
          ...(depth ? { query: { depth } } : {}),
        };
      },
    },
    {
      capability: figma.capabilities[2],
      buildRequest(input) {
        const ids = requiredString(input, 'nodeIds', 2_000).split(',').map(value => value.trim()).filter(Boolean);
        if (ids.length > 100) throw new Error('nodeIds may contain at most 100 node IDs.');
        return {
          method: 'GET',
          path: `/v1/files/${encodeURIComponent(requiredString(input, 'fileKey', 200))}/nodes`,
          query: { ids: ids.join(',') },
        };
      },
    },
  ]);

  const canva = manifest(
    'canva',
    'Canva',
    'Discover Canva designs and export a design through the Canva Connect API.',
    'design',
    tokenField,
    [
      capability('list_designs', 'List designs', 'Search designs accessible to the connected Canva account.', 'read', {
        query: { type: 'string' },
        continuation: { type: 'string' },
      }),
      capability('get_design', 'Get design', 'Read design metadata by ID.', 'read', {
        designId: { type: 'string' },
      }, ['designId']),
      capability('create_export', 'Export design', 'Request an export for a design. The export can incur provider processing.', 'create', {
        designId: { type: 'string' },
        format: { type: 'string', enum: ['pdf', 'png', 'jpg', 'mp4', 'gif'] },
      }, ['designId', 'format']),
      capability('get_export', 'Get export', 'Check the status and download URL of a Canva export.', 'read', {
        exportId: { type: 'string' },
      }, ['exportId']),
    ],
  );
  const canvaAdapter = new RestConnectorAdapter({
    manifest: canva,
    baseUrl: 'https://api.canva.com',
    probePath: '/rest/v1/users/me',
    fetcher,
  }, [
    {
      capability: canva.capabilities[0],
      buildRequest(input) {
        const query: Record<string, string> = {};
        if (typeof input.query === 'string' && input.query.trim()) query.query = input.query.trim().slice(0, 500);
        if (typeof input.continuation === 'string' && input.continuation) query.continuation = input.continuation.slice(0, 2_000);
        return { method: 'GET', path: '/rest/v1/designs', query };
      },
    },
    {
      capability: canva.capabilities[1],
      buildRequest(input) {
        return { method: 'GET', path: `/rest/v1/designs/${encodeURIComponent(requiredString(input, 'designId', 200))}` };
      },
    },
    {
      capability: canva.capabilities[2],
      buildRequest(input) {
        const format = requiredString(input, 'format', 10);
        if (!['pdf', 'png', 'jpg', 'mp4', 'gif'].includes(format)) throw new Error('Unsupported Canva export format.');
        return {
          method: 'POST',
          path: '/rest/v1/exports',
          body: {
            design_id: requiredString(input, 'designId', 200),
            format: { type: format },
          },
        };
      },
    },
    {
      capability: canva.capabilities[3],
      buildRequest(input) {
        return { method: 'GET', path: `/rest/v1/exports/${encodeURIComponent(requiredString(input, 'exportId', 200))}` };
      },
    },
  ]);

  return [
    githubAdapter,
    ...createGitHostingConnectors(fetcher),
    notionAdapter,
    slackAdapter,
    figmaAdapter,
    canvaAdapter,
  ];
}
