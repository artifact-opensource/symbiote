import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  CalendarDays,
  Cloud,
  Check,
  CircleAlert,
  Cpu,
  Database,
  ExternalLink,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  Folder,
  Info,
  LogOut,
  Mail,
  MessageSquare,
  Presentation,
  Users,
  CheckSquare,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import ActivityOrb from './ActivityOrb';
import type { User } from '@firebase/auth';
import { googleSignIn, googleSignOut, observeGoogleUser } from '../lib/firebase';
import {
  GOOGLE_WORKSPACE_SCOPES,
  GOOGLE_WORKSPACE_SERVICES,
  inspectGoogleWorkspaceService,
} from '../lib/googleWorkspace.ts';

export interface GoogleWorkspaceGrant {
  accessToken: string;
  expiresAt: number;
}

const serviceIcons = {
  drive: Folder,
  gmail: Mail,
  calendar: CalendarDays,
  contacts: Users,
  docs: FileText,
  sheets: FileSpreadsheet,
  slides: Presentation,
  tasks: CheckSquare,
  chat: MessageSquare,
  forms: FileQuestion,
} as const;

type ServiceState =
  | { status: 'checking' }
  | { status: 'online' }
  | { status: 'offline'; message: string };

type CloudProvider = 'azure' | 'oci' | 'n8n' | 'kaggle';
export type CloudProviderStatus = Record<CloudProvider, boolean>;

const CLOUD_PROVIDERS: Array<{
  id: CloudProvider;
  name: string;
  description: string;
  info: string;
  apps: string[];
  icon: typeof Cloud;
  fields: Array<{ id: string; label: string; secret?: boolean; multiline?: boolean }>;
}> = [
  {
    id: 'azure',
    name: 'Microsoft Azure',
    description: 'Resource Manager access for the configured subscription, including GPU compute and Azure ML.',
    info: 'Access is scoped to the configured Azure subscription. Virtual machines, GPU compute, Azure ML, and other provisioning actions may incur charges or change cloud resources.',
    apps: ['Resource Manager', 'Virtual machines & GPU', 'Azure Machine Learning', 'Blob Storage'],
    icon: Cloud,
    fields: [
      { id: 'tenantId', label: 'Tenant ID' },
      { id: 'clientId', label: 'Application (client) ID' },
      { id: 'clientSecret', label: 'Client secret', secret: true },
      { id: 'subscriptionId', label: 'Subscription ID' },
    ],
  },
  {
    id: 'oci',
    name: 'Oracle Cloud Infrastructure',
    description: 'Signed Compute, Object Storage, Identity, and Resource Manager API access.',
    info: 'Signed requests use the configured OCI tenancy and region. Compute, networking, storage, and Resource Manager changes apply immediately and may incur charges.',
    apps: ['Compute & GPU', 'Networking', 'Object Storage', 'Resource Manager'],
    icon: Database,
    fields: [
      { id: 'tenancyOcid', label: 'Tenancy OCID' },
      { id: 'userOcid', label: 'User OCID' },
      { id: 'fingerprint', label: 'API key fingerprint' },
      { id: 'region', label: 'Region (for example, us-ashburn-1)' },
      { id: 'privateKey', label: 'Private key PEM', secret: true, multiline: true },
    ],
  },
  {
    id: 'n8n',
    name: 'n8n (local by default)',
    description: 'Build, publish, schedule, and inspect workflows with native agent tools and the n8n editor.',
    info: 'The n8n API key grants broad control over workflows and executions. Symbiote prefers the local .env connection; a saved endpoint and key override it and are encrypted in the local credential vault. Only admin sessions can use n8n tools.',
    apps: ['Workflow lifecycle', 'Schedule & webhook triggers', 'Execution history', 'Admin-only agent tools'],
    icon: Workflow,
    fields: [],
  },
  {
    id: 'kaggle',
    name: 'Kaggle',
    description: 'Discover datasets and manage notebook jobs within Kaggle API and GPU quotas.',
    info: 'The Kaggle API supports dataset discovery and notebook/kernel jobs. Accelerator availability is quota-limited by Kaggle and is not an Azure or OCI GPU cluster.',
    apps: ['Datasets', 'Models', 'Notebooks & kernels', 'Competitions'],
    icon: Cpu,
    fields: [
      { id: 'username', label: 'Username (legacy API key only)' },
      { id: 'apiToken', label: 'API token or legacy key', secret: true },
    ],
  },
];

const emptyCloudStatus: CloudProviderStatus = { azure: false, oci: false, n8n: false, kaggle: false };

function authorizationErrorMessage(failure: unknown): string {
  const error = failure && typeof failure === 'object'
    ? failure as { code?: unknown; message?: unknown }
    : {};
  const code = typeof error.code === 'string' ? error.code : '';
  const detail = typeof error.message === 'string' ? error.message : '';
  if (error.code === 'auth/unauthorized-domain') {
    const hostname = window.location.hostname;
    return `Firebase is not allowing sign-in from ${hostname}. In Firebase Console, open Authentication > Settings > Authorized domains and add "${hostname}" without a scheme or port, then reload this page.`;
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Google sign-in is disabled for this Firebase project. Enable the Google provider in Firebase Console > Authentication > Sign-in method.';
  }
  if (code === 'auth/popup-blocked') return 'The browser blocked the Google sign-in popup. Allow popups for this Symbiote site and try again.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Google sign-in was closed before authorization finished. Try again and keep the popup open.';
  if (code === 'auth/network-request-failed') return 'Google sign-in could not reach Firebase or Google. Check the network connection and try again.';
  if (code === 'auth/invalid-oauth-client-id' || code === 'auth/unauthorized-continue-uri') {
    return `The Firebase Google OAuth client or redirect configuration is invalid.${detail ? ` Details: ${detail}` : ''}`;
  }
  if (/invalid_scope|Some requested scopes were invalid/i.test(detail)) {
    return `Google rejected one or more requested Workspace scopes. Check the OAuth consent screen and enabled Google APIs for this OAuth client; this cannot be bypassed in the app.${detail ? ` Details: ${detail}` : ''}`;
  }
  if (/access_denied|org_internal|testing/i.test(detail)) {
    return `Google blocked this account under the OAuth consent-screen audience or organization policy. Add the account as a test user or adjust the Google Cloud OAuth audience if appropriate.${detail ? ` Details: ${detail}` : ''}`;
  }
  if (detail) return `${code ? `${code}: ` : ''}${detail.slice(0, 1_600)}`;
  return 'Google Workspace authorization failed. Check Firebase Google sign-in and the Google Cloud OAuth consent screen.';
}

export default function CloudSpacesView({
  grant,
  onGrantChange,
  request,
  cloudStatus = emptyCloudStatus,
  onCloudStatusChange,
}: {
  grant: GoogleWorkspaceGrant | null;
  onGrantChange: (grant: GoogleWorkspaceGrant | null) => void;
  request: <T,>(endpoint: string, options?: RequestInit) => Promise<T>;
  cloudStatus?: CloudProviderStatus;
  onCloudStatusChange: (provider: CloudProvider, configured: boolean) => void;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountError, setAccountError] = useState('');
  const [working, setWorking] = useState(false);
  const [services, setServices] = useState<Record<string, ServiceState>>({});

  useEffect(() => observeGoogleUser(currentUser => {
    setUser(currentUser);
    setAccountLoading(false);
    if (!currentUser) {
      setServices({});
      onGrantChange(null);
    }
  }, failure => {
    setAccountError(authorizationErrorMessage(failure));
    setAccountLoading(false);
  }), [onGrantChange]);

  const verifyAllServices = async (accessToken: string) => {
    setServices(Object.fromEntries(GOOGLE_WORKSPACE_SERVICES.map(service => [service.id, { status: 'checking' as const }])));
    const results = await Promise.all(GOOGLE_WORKSPACE_SERVICES.map(async service => {
      try {
        await inspectGoogleWorkspaceService(service.id, accessToken);
        return [service.id, { status: 'online' } satisfies ServiceState] as const;
      } catch (failure) {
        return [service.id, {
          status: 'offline',
          message: failure instanceof Error ? failure.message : `Could not verify ${service.name}.`,
        } satisfies ServiceState] as const;
      }
    }));
    setServices(Object.fromEntries(results));
  };

  const connectAccount = async () => {
    setAccountError('');
    setWorking(true);
    try {
      const result = await googleSignIn(GOOGLE_WORKSPACE_SCOPES);
      setUser(result.user);
      if (!result.accessToken) throw new Error('Google did not return an access token. Check Firebase Google sign-in and OAuth consent configuration.');
      const nextGrant = { accessToken: result.accessToken, expiresAt: Date.now() + 55 * 60 * 1000 };
      onGrantChange(nextGrant);
      await verifyAllServices(result.accessToken);
    } catch (failure) {
      onGrantChange(null);
      setAccountError(authorizationErrorMessage(failure));
    } finally {
      setWorking(false);
    }
  };

  const disconnectAccount = async () => {
    setWorking(true);
    setAccountError('');
    try {
      await googleSignOut();
      onGrantChange(null);
      setServices({});
    } catch (failure) {
      setAccountError(failure instanceof Error ? failure.message : 'Could not sign out of Google.');
    } finally {
      setWorking(false);
    }
  };

  const authorized = Boolean(grant && grant.expiresAt > Date.now());
  const needsReauthorization = Boolean(grant && !authorized);
  const failedServices = GOOGLE_WORKSPACE_SERVICES.filter(service => services[service.id]?.status === 'offline');

  return (
    <div className="page integrations-page">
      <header className="page-heading integrations-heading">
        <div>
          <div className="eyebrow">ACCOUNT CONNECTIONS</div>
          <h1>Integrations</h1>
          <p>Credentials are encrypted locally. Google access stays in memory; cloud secrets are never shown after saving. Connections grant the agent the permissions of those accounts.</p>
        </div>
      </header>
      <div className="integrations-grid" aria-label="Available integrations">
        <article className="surface-card cloud-provider-card integration-provider-card">
          <div className="integration-card-header">
            <span className={`cloud-provider-icon${authorized ? ' cloud-provider-icon-online' : ''}`}><GoogleMark /></span>
            <div className="integration-card-title">
              <h2>Google Workspace</h2>
              <span className={`cloud-provider-status${authorized ? ' cloud-provider-status-online' : ''}`}>{accountLoading ? 'Checking account' : authorized ? 'Authorized' : 'Not connected'}</span>
              {user?.email && <span className="integration-account-name">{user.displayName || user.email}</span>}
            </div>
            <button className="integration-info" type="button" title="One Google consent authorizes the listed Workspace apps, including sending mail and editing or deleting data permitted by the account. The access token is kept in memory for the active agent turn and expires automatically. Google may require OAuth verification and enabling each API." aria-label="About Google Workspace permissions"><Info size={14} /></button>
          </div>
          <div className="integration-card-actions">
            {authorized ? (
              <button className="button button-secondary" type="button" onClick={() => void disconnectAccount()} disabled={working}>
                {working ? <ActivityOrb label="Disconnecting account" compact loading /> : <LogOut size={14} />}
                Disconnect
              </button>
            ) : (
              <button className="button button-primary" type="button" onClick={() => void connectAccount()} disabled={working || accountLoading}>
                {working ? <ActivityOrb label="Authorizing account" compact loading /> : <GoogleMark />}
                {working ? 'Authorizing…' : needsReauthorization ? 'Renew access' : 'Authorize Workspace'}
              </button>
            )}
          </div>
          {accountError && <p className="cloud-account-error" role="alert">{accountError}</p>}
          <div className="integration-google-app-grid" aria-label="Google Workspace apps">
            {GOOGLE_WORKSPACE_SERVICES.map(service => {
              const Icon = serviceIcons[service.id as keyof typeof serviceIcons];
              const state = services[service.id];
              const online = authorized && state?.status === 'online';
              const checking = authorized && state?.status === 'checking';
              const error = state?.status === 'offline' ? state.message : '';
              return (
                <div
                  className={`integration-app${online ? ' integration-app-online' : ''}${checking ? ' integration-app-checking' : ''}`}
                  key={service.id}
                  title={error ? `${service.name}: ${error}` : `${service.name}: ${online ? 'authorized and reachable' : checking ? 'checking access' : 'offline'}`}
                  aria-label={`${service.name}: ${online ? 'online' : checking ? 'checking' : 'offline'}`}
                >
                  <span className="integration-app-icon">{checking ? <ActivityOrb label={`Checking ${service.name}`} loading /> : <Icon size={19} />}</span>
                  <span className="integration-app-name">{service.name}</span>
                  <span className="integration-app-status">{online ? <><Check size={11} />Online</> : checking ? 'Checking' : error ? <><CircleAlert size={11} />Unavailable</> : 'Offline'}</span>
                </div>
              );
            })}
          </div>
          {failedServices.length > 0 && (
            <div className="integration-errors" role="status">
              {failedServices.map(service => {
                const state = services[service.id];
                return <p key={service.id}><strong>{service.name}:</strong> {state?.status === 'offline' ? state.message : ''}</p>;
              })}
            </div>
          )}
        </article>
        {CLOUD_PROVIDERS.map(provider => provider.id === 'n8n' ? (
          <N8nIntegrationCard
            key={provider.id}
            request={request}
            onConfigured={configured => onCloudStatusChange('n8n', configured)}
          />
        ) : (
          <CloudProviderCard
            key={provider.id}
            provider={provider}
            configured={cloudStatus[provider.id]}
            request={request}
            onConfigured={configured => onCloudStatusChange(provider.id, configured)}
          />
        ))}
      </div>
    </div>
  );
}

interface N8nConnectionInfo {
  configured: boolean;
  source: 'local-env' | 'saved-override' | 'none';
  apiBaseUrl: string;
  editorUrl: string;
  isLocal: boolean;
}

function isN8nConnectionInfo(value: unknown): value is N8nConnectionInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'configured' in value
    && typeof value.configured === 'boolean'
    && 'source' in value
    && (value.source === 'local-env' || value.source === 'saved-override' || value.source === 'none')
    && 'apiBaseUrl' in value
    && typeof value.apiBaseUrl === 'string'
    && 'editorUrl' in value
    && typeof value.editorUrl === 'string'
    && 'isLocal' in value
    && typeof value.isLocal === 'boolean';
}

function N8nIntegrationCard({
  request,
  onConfigured,
}: {
  request: <T,>(endpoint: string, options?: RequestInit) => Promise<T>;
  onConfigured: (configured: boolean) => void;
}) {
  const endpoint = '/api/integrations/n8n';
  const [connection, setConnection] = useState<N8nConnectionInfo | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [working, setWorking] = useState(true);
  const [health, setHealth] = useState<'unknown' | 'online' | 'offline'>('unknown');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorLoaded, setEditorLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const isSavedOverride = connection?.source === 'saved-override';
  const onConfiguredRef = useRef(onConfigured);
  onConfiguredRef.current = onConfigured;

  const getConnectionInfo = useCallback(async () => {
    const result = await request<unknown>(endpoint);
    if (!isN8nConnectionInfo(result)) {
      throw new Error('The gateway does not provide n8n connection details yet. Rebuild and restart it to activate the updated integration.');
    }
    return result;
  }, [endpoint, request]);

  const reloadConnection = useCallback(async () => {
    setWorking(true);
    setError('');
    try {
      const next = await getConnectionInfo();
      setConnection(next);
      setBaseUrl(next.source === 'saved-override' ? next.apiBaseUrl : '');
      onConfiguredRef.current(next.configured);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not read n8n connection settings.');
      return null;
    } finally {
      setWorking(false);
    }
  }, [getConnectionInfo]);

  useEffect(() => {
    void reloadConnection();
  }, [reloadConnection]);

  const testConnection = async () => {
    setWorking(true);
    setMessage('');
    setError('');
    setHealth('unknown');
    try {
      await request(`${endpoint}/test`, { method: 'POST' });
      setHealth('online');
      setMessage('Connection test succeeded.');
    } catch (failure) {
      setHealth('offline');
      setError(failure instanceof Error ? failure.message : 'n8n connection test failed.');
    } finally {
      setWorking(false);
    }
  };

  const saveOverride = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connection) {
      setError('Connection settings are unavailable. Refresh the gateway before changing n8n credentials.');
      return;
    }
    if (!baseUrl.trim()) {
      setError('Enter an n8n API root, including /api/v1.');
      return;
    }
    if (!apiKey.trim() && !isSavedOverride) {
      setError('Enter an API key to save a new n8n override.');
      return;
    }
    setWorking(true);
    setMessage('');
    setError('');
    try {
      await request(endpoint, {
        method: 'POST',
        body: JSON.stringify({ baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      });
      setConnection(null);
      setHealth('unknown');
      setApiKey('');
    } catch (failure) {
      setError(`Could not save the override: ${failure instanceof Error ? failure.message : 'Unknown error.'}`);
      setWorking(false);
      return;
    }
    try {
      const next = await getConnectionInfo();
      setConnection(next);
      onConfigured(next.configured);
    } catch (failure) {
      setError(`Override saved, but connection settings could not be refreshed: ${failure instanceof Error ? failure.message : 'Unknown error.'}`);
      setWorking(false);
      return;
    }
    try {
      await request(`${endpoint}/test`, { method: 'POST' });
      setHealth('online');
      setMessage('Override saved and connection test succeeded.');
    } catch (failure) {
      setHealth('offline');
      setError(`Override saved, but the connection test failed: ${failure instanceof Error ? failure.message : 'Unknown error.'}`);
    } finally {
      setWorking(false);
    }
  };

  const removeOverride = async () => {
    if (!window.confirm('Remove the saved n8n endpoint and API key? Symbiote will fall back to the local .env settings.')) return;
    setWorking(true);
    setMessage('');
    setError('');
    try {
      await request(endpoint, { method: 'DELETE' });
      setConnection(null);
      setHealth('unknown');
      setBaseUrl('');
      setApiKey('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not remove the saved n8n override.');
      setWorking(false);
      return;
    }
    try {
      const next = await request<N8nConnectionInfo>(endpoint);
      if (!isN8nConnectionInfo(next)) {
        throw new Error('The gateway did not return valid n8n connection details.');
      }
      setConnection(next);
      onConfigured(next.configured);
      setMessage(next.configured ? 'Saved override removed; using the local .env connection.' : 'Saved override removed. n8n is not configured.');
    } catch (failure) {
      setError(`Saved override removed, but connection settings could not be refreshed: ${failure instanceof Error ? failure.message : 'Unknown error.'}`);
    } finally {
      setWorking(false);
    }
  };

  const statusLabel = !connection
    ? working ? 'Checking settings' : 'Settings unavailable'
    : health === 'online'
      ? 'Connected'
      : health === 'offline'
        ? 'Connection failed'
        : connection.configured
          ? 'Configured'
          : 'Not configured';
  const sourceLabel = connection
    ? connection.source === 'saved-override'
      ? 'Encrypted saved override'
      : connection.source === 'local-env'
        ? 'Local .env'
        : 'Default local endpoint'
    : 'Connection source unavailable';

  return (
    <article className="surface-card cloud-provider-card integration-provider-card n8n-integration-card">
      <div className="integration-card-header">
        <span className={`cloud-provider-icon${health === 'online' ? ' cloud-provider-icon-online' : ''}`}><Workflow size={18} /></span>
        <div className="integration-card-title">
          <h2>n8n (local by default)</h2>
          <span className={`cloud-provider-status${health === 'online' ? ' cloud-provider-status-online' : ''}`} aria-live="polite">{statusLabel}</span>
        </div>
        <button className="integration-info" type="button" title={CLOUD_PROVIDERS.find(provider => provider.id === 'n8n')?.info} aria-label="About n8n access and permissions"><Info size={14} /></button>
      </div>

      <div className="n8n-connection-details">
        <span>{sourceLabel}</span>
        <code>{connection?.apiBaseUrl ?? 'Connection details unavailable'}</code>
        {connection?.source === 'local-env' && <p>The API key is read from Symbiote .env and is never displayed here.</p>}
        {connection?.source === 'saved-override' && <p>The saved API key is encrypted in the local credential vault and is never displayed here.</p>}
        {connection?.source === 'none' && <p>Set N8N_API_KEY in Symbiote .env or configure a secured override below.</p>}
      </div>

      <div className="integration-provider-apps" aria-label="n8n capabilities">
        {['Workflow lifecycle', 'Schedule & webhook triggers', 'Execution history', 'Admin-only agent tools'].map(app => (
          <span className="integration-provider-app" key={app}><Check size={12} />{app}</span>
        ))}
      </div>

      <div className="n8n-agent-note">
        <Workflow size={15} />
        <p><strong>Agent workflow tools</strong> are available only in admin sessions. Recurring automations belong in n8n Schedule Trigger workflows; publish a workflow to activate its schedule.</p>
      </div>

      <div className="integration-card-actions n8n-actions">
        <button className="button button-primary" type="button" onClick={() => void testConnection()} disabled={working || !connection?.configured}>
          {working ? <ActivityOrb label="Testing n8n connection" compact loading /> : <RefreshCw size={14} />}
          Test connection
        </button>
        {connection?.editorUrl && (
          <a className="button button-secondary" href={connection.editorUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} />Open editor
          </a>
        )}
        {connection?.isLocal && (
          <button className="button button-secondary" type="button" onClick={() => { setEditorOpen(open => !open); setEditorLoaded(false); }}>
            {editorOpen ? 'Close embedded editor' : 'Embed local editor'}
          </button>
        )}
        <button className="button button-secondary" type="button" onClick={() => void reloadConnection()} disabled={working}>
          <RefreshCw size={13} />Refresh
        </button>
      </div>

      {editorOpen && connection?.isLocal && (
        <section className="n8n-editor-panel" aria-label="Embedded local n8n editor">
          <div className="n8n-editor-heading">
            <div><strong>Local n8n editor</strong><span>Loaded only when requested</span></div>
            <a href={connection.editorUrl} target="_blank" rel="noopener noreferrer" aria-label="Open n8n editor in a new tab"><ArrowUpRight size={15} /></a>
          </div>
          {!editorLoaded && <p className="n8n-editor-loading">Loading the local editor…</p>}
          <iframe
            title="Local n8n workflow editor"
            src={connection.editorUrl}
            loading="lazy"
            onLoad={() => setEditorLoaded(true)}
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          />
        </section>
      )}

      <details className="cloud-provider-credentials n8n-override">
        <summary>{isSavedOverride ? 'Manage saved endpoint override' : 'Configure a remote n8n override'}</summary>
        {!connection && <p className="n8n-override-unavailable">Connection details are unavailable. Rebuild and restart the gateway before changing n8n credentials.</p>}
        <form onSubmit={event => void saveOverride(event)} className="cloud-provider-form">
          <label className="cloud-provider-field n8n-override-url">
            <span>n8n REST API root (for example, https://host/api/v1)</span>
            <input
              type="url"
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
              placeholder="https://n8n.example.com/api/v1"
              autoComplete="url"
              disabled={!connection || working}
              required
            />
          </label>
          <label className="cloud-provider-field n8n-override-key">
            <span>{isSavedOverride ? 'Replace API key (leave blank to keep the saved key)' : 'n8n REST API key'}</span>
            <input
              type="password"
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              placeholder={isSavedOverride ? 'Stored securely; value is not shown' : 'Paste API key'}
              autoComplete="new-password"
              disabled={!connection || working}
              required={!isSavedOverride}
            />
          </label>
          <div className="cloud-provider-actions">
            <button className="button button-primary" type="submit" disabled={!connection || working || !baseUrl.trim() || (!apiKey.trim() && !isSavedOverride)}>
              {working ? <ActivityOrb label="Saving n8n override" compact loading /> : <Check size={14} />}
              Save & test override
            </button>
            {isSavedOverride && <button className="button button-secondary" type="button" onClick={() => void removeOverride()} disabled={working}><LogOut size={14} />Revert to local settings</button>}
          </div>
        </form>
      </details>
      {message && <p className="cloud-provider-message" role="status">{message}</p>}
      {error && <p className="cloud-provider-error" role="alert"><CircleAlert size={13} />{error}</p>}
    </article>
  );
}

function CloudProviderCard({
  provider,
  configured,
  request,
  onConfigured,
}: {
  provider: (typeof CLOUD_PROVIDERS)[number];
  configured: boolean;
  request: <T,>(endpoint: string, options?: RequestInit) => Promise<T>;
  onConfigured: (configured: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const Icon = provider.icon;
  const endpoint = `/api/integrations/${provider.id}`;

  const testConnection = async () => {
    setWorking(true);
    setMessage('');
    setError('');
    try {
      await request(`${endpoint}/test`, { method: 'POST' });
      setMessage('Connection test succeeded.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Connection test failed.');
    } finally {
      setWorking(false);
    }
  };

  const saveCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setMessage('');
    setError('');
    try {
      await request(endpoint, { method: 'POST', body: JSON.stringify(values) });
      onConfigured(true);
      setValues({});
      setMessage('Credentials saved. Testing connection…');
      try {
        await request(`${endpoint}/test`, { method: 'POST' });
        setMessage('Credentials saved and connection test succeeded.');
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Credentials saved, but the connection test failed.');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save credentials.');
    } finally {
      setWorking(false);
    }
  };

  const disconnect = async () => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      await request(endpoint, { method: 'DELETE' });
      onConfigured(false);
      setMessage('Local credentials removed.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not remove credentials.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <article className="surface-card cloud-provider-card integration-provider-card">
      <div className="integration-card-header">
        <span className={`cloud-provider-icon${configured ? ' cloud-provider-icon-online' : ''}`}><Icon size={18} /></span>
        <div className="integration-card-title">
          <h2>{provider.name}</h2>
          <span className={`cloud-provider-status${configured ? ' cloud-provider-status-online' : ''}`}>{configured ? 'Credentials saved' : 'Not connected'}</span>
        </div>
        <button className="integration-info" type="button" title={provider.info} aria-label={`About ${provider.name} permissions`}><Info size={14} /></button>
      </div>
      <div className="integration-provider-apps" aria-label={`${provider.name} services`}>
        {provider.apps.map(app => <span className="integration-provider-app" key={app}><Check size={12} />{app}</span>)}
      </div>
      <details className="cloud-provider-credentials">
        <summary>{configured ? 'Manage credentials' : 'Connect account'}</summary>
        <form onSubmit={event => void saveCredentials(event)} className="cloud-provider-form">
          {provider.fields.map(field => (
            <label className="cloud-provider-field" key={field.id}>
              <span>{field.label}</span>
              {field.multiline ? (
                <textarea
                  value={values[field.id] ?? ''}
                  onChange={event => setValues(previous => ({ ...previous, [field.id]: event.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                  rows={4}
                  className={field.secret ? 'cloud-provider-secret' : undefined}
                />
              ) : (
                <input
                  type={field.secret ? 'password' : 'text'}
                  value={values[field.id] ?? ''}
                  onChange={event => setValues(previous => ({ ...previous, [field.id]: event.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </label>
          ))}
          <div className="cloud-provider-actions">
            <button className="button button-primary" type="submit" disabled={working}>
              {working ? <ActivityOrb label="Saving integration settings" compact loading /> : <Check size={14} />}
              Save & test
            </button>
            {configured && <button className="button button-secondary" type="button" onClick={() => void testConnection()} disabled={working}>Test</button>}
            {configured && <button className="button button-secondary" type="button" onClick={() => void disconnect()} disabled={working}><LogOut size={14} />Disconnect</button>}
          </div>
        </form>
      </details>
      {message && <p className="cloud-provider-message" role="status">{message}</p>}
      {error && <p className="cloud-provider-error" role="alert"><CircleAlert size={13} />{error}</p>}
    </article>
  );
}

function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.27c0-.78-.07-1.53-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.27-2.09 3.57-5.16 3.57-8.65Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.95-2.92l-3.87-3c-1.08.72-2.46 1.15-4.08 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.27a12 12 0 0 0 0 10.76l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.77c1.77 0 3.35.61 4.6 1.8l3.43-3.42A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.27 6.62l4 3.1c.95-2.84 3.6-4.95 6.73-4.95Z" />
    </svg>
  );
}
