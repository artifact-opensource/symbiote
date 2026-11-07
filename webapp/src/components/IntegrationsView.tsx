import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  CheckCircle2,
  CalendarDays,
  ChartCandlestick,
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
  GitBranch,
  Info,
  LogOut,
  KeyRound,
  Mail,
  MessageSquare,
  Network,
  Presentation,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Users,
  CheckSquare,
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

export interface TailscaleIntegrationStatus {
  connected: boolean;
  ip: string | null;
  error?: string;
  enabled: boolean;
  mode: 'lan' | 'tailscale';
  accessUrl: string;
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
    name: 'n8n Cloud',
    description: 'Manage and execute workflows through the n8n public API.',
    info: 'The API key can inspect, create, edit, activate, deactivate, and execute workflows in the configured n8n Cloud workspace. Workflows can affect connected external systems.',
    apps: ['Workflows', 'Executions', 'Activation & management'],
    icon: Workflow,
    fields: [
      { id: 'baseUrl', label: 'API root (https://…/api/v1)' },
      { id: 'apiKey', label: 'API key', secret: true },
    ],
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
  tailscaleStatus,
  onTailscaleStatusChange,
}: {
  grant: GoogleWorkspaceGrant | null;
  onGrantChange: (grant: GoogleWorkspaceGrant | null) => void;
  request: <T,>(endpoint: string, options?: RequestInit) => Promise<T>;
  cloudStatus?: CloudProviderStatus;
  onCloudStatusChange: (provider: CloudProvider, configured: boolean) => void;
  tailscaleStatus: TailscaleIntegrationStatus | null;
  onTailscaleStatusChange: (status: TailscaleIntegrationStatus) => void;
}) {
  const [gitIdentity, setGitIdentity] = useState({ userName: '', userEmail: '' });
  const [gitWorking, setGitWorking] = useState(false);
  const [gitError, setGitError] = useState('');
  const [gitMessage, setGitMessage] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountError, setAccountError] = useState('');
  const [working, setWorking] = useState(false);
  const [services, setServices] = useState<Record<string, ServiceState>>({});
  const [tailscaleWorking, setTailscaleWorking] = useState(false);
  const [tailscaleError, setTailscaleError] = useState('');

  useEffect(() => {
    let active = true;
    void request<{ identity: typeof gitIdentity }>('/api/integrations/git')
      .then(result => { if (active) setGitIdentity(result.identity); })
      .catch(failure => { if (active) setGitError(failure instanceof Error ? failure.message : 'Git identity is unavailable.'); });
    return () => { active = false; };
  }, [request]);

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

  const updateTailscaleAccess = async (enabled: boolean) => {
    setTailscaleWorking(true);
    setTailscaleError('');
    try {
      const status = await request<TailscaleIntegrationStatus>('/api/integrations/tailscale', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      onTailscaleStatusChange(status);
    } catch (failure) {
      setTailscaleError(failure instanceof Error ? failure.message : 'Tailscale access could not be updated.');
    } finally {
      setTailscaleWorking(false);
    }
  };

  const refreshTailscaleStatus = async () => {
    setTailscaleWorking(true);
    setTailscaleError('');
    try {
      onTailscaleStatusChange(await request<TailscaleIntegrationStatus>('/api/integrations/tailscale'));
    } catch (failure) {
      setTailscaleError(failure instanceof Error ? failure.message : 'Tailscale status could not be read.');
    } finally {
      setTailscaleWorking(false);
    }
  };

  const saveGitIdentity = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGitWorking(true);
    setGitError('');
    setGitMessage('');
    try {
      const result = await request<{ identity: typeof gitIdentity }>('/api/integrations/git', {
        method: 'PUT',
        body: JSON.stringify({ identity: gitIdentity }),
      });
      setGitIdentity(result.identity);
      setGitMessage('Git commit identity saved. Existing Git credential helpers and SSH keys will be used for remotes.');
    } catch (failure) {
      setGitError(failure instanceof Error ? failure.message : 'Git identity could not be saved.');
    } finally {
      setGitWorking(false);
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
          <p>Credentials are encrypted locally. Saving only replaces fields you enter; blank fields keep their existing values. Connections grant the agent the permissions of these accounts.</p>
        </div>
      </header>
      <div className="integrations-grid" aria-label="Available integrations">
        <article className="surface-card cloud-provider-card integration-provider-card">
          <div className="integration-card-header">
            <span className={`cloud-provider-icon${gitIdentity.userName && gitIdentity.userEmail ? ' cloud-provider-icon-online' : ''}`}><GitBranch size={20} /></span>
            <div className="integration-card-title">
              <h2>Git</h2>
              <span className={`cloud-provider-status${gitIdentity.userName && gitIdentity.userEmail ? ' cloud-provider-status-online' : ''}`}>
                {gitIdentity.userName && gitIdentity.userEmail ? 'Commit identity configured' : 'Built-in · configure commit identity'}
              </span>
            </div>
            <span className="integration-info" title="Native Git works with any standard Git remote. Authentication remains in your existing SSH agent or operating-system credential helper; Symbiote does not store remote credentials."><Info size={14} /></span>
          </div>
          <form className="market-integration-form" onSubmit={event => void saveGitIdentity(event)}>
            <label>Git user name<input autoComplete="name" value={gitIdentity.userName} onChange={event => setGitIdentity(current => ({ ...current, userName: event.target.value }))} placeholder="Name on commits" maxLength={200} required={Boolean(gitIdentity.userEmail)} /></label>
            <label>Git email<input type="email" autoComplete="email" value={gitIdentity.userEmail} onChange={event => setGitIdentity(current => ({ ...current, userEmail: event.target.value }))} placeholder="you@example.com" maxLength={320} required={Boolean(gitIdentity.userName)} /></label>
            <div className="market-integration-actions">
              <button className="button button-primary" type="submit" disabled={gitWorking}>
                {gitWorking ? <ActivityOrb label="Saving Git identity" compact loading /> : <GitBranch size={14} />}
                Save Git identity
              </button>
            </div>
          </form>
          <small className="integration-account-name">This identity applies to Symbiote-created commits without changing your global Git configuration. Native Git supports GitHub, GitLab, Gitee, Bitbucket, and any standard Git server.</small>
          {gitMessage && <p className="cloud-provider-message" role="status">{gitMessage}</p>}
          {gitError && <p className="cloud-provider-error" role="alert">{gitError}</p>}
        </article>
        <article className="surface-card cloud-provider-card integration-provider-card tailscale-integration-card">
          <div className="integration-card-header">
            <span className={`cloud-provider-icon${tailscaleStatus?.connected ? ' cloud-provider-icon-online' : ''}`}><Network size={20} /></span>
            <div className="integration-card-title">
              <h2>Tailscale</h2>
              <span className={`cloud-provider-status${tailscaleStatus?.connected ? ' cloud-provider-status-online' : ''}`}>
                {tailscaleStatus ? tailscaleStatus.connected ? 'Connected' : 'Not connected' : 'Checking status'}
              </span>
              {tailscaleStatus?.ip && <span className="integration-account-name">This device · {tailscaleStatus.ip}</span>}
            </div>
            <button className="integration-info" type="button" title="Tailscale access exposes the local Symbiote web interface to devices on your private tailnet. The CLI must be installed and signed in on this device." aria-label="About Tailscale access"><Info size={14} /></button>
          </div>
          <p className="tailscale-description">Reach this Symbiote instance from devices on your private tailnet.</p>
          <div className="integration-card-actions">
            <button
              className={`button ${tailscaleStatus?.enabled ? 'button-secondary' : 'button-primary'}`}
              type="button"
              onClick={() => void updateTailscaleAccess(!tailscaleStatus?.enabled)}
              disabled={tailscaleWorking || !tailscaleStatus?.connected}
            >
              {tailscaleWorking ? <ActivityOrb label="Updating Tailscale access" compact loading /> : <ShieldCheck size={14} />}
              {tailscaleStatus?.enabled ? 'Disable tailnet access' : 'Enable tailnet access'}
            </button>
            <button className="button button-secondary" type="button" onClick={() => void refreshTailscaleStatus()} disabled={tailscaleWorking}>
              <RefreshCw size={13} />Refresh
            </button>
            {tailscaleStatus?.accessUrl && <a className="button button-secondary" href={tailscaleStatus.accessUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />Open UI</a>}
          </div>
          {tailscaleStatus?.accessUrl && <p className="tailscale-address"><span>{tailscaleStatus.enabled ? 'Tailnet address' : 'Local network address'}</span><code>{tailscaleStatus.accessUrl}</code></p>}
          {(tailscaleError || tailscaleStatus?.error) && <p className="cloud-provider-error" role="status">{tailscaleError || tailscaleStatus?.error}</p>}
        </article>
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
        <MarketTradingIntegrations request={request} />
        {CLOUD_PROVIDERS.map(provider => (
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

type Mt5Status = { configured: boolean; terminalPath?: string };
type Mt5TestResult = { connected: true; account: number; server: string; latencyMs: number; tick: { symbol: string; bid: number; ask: number; time: number } };
type BinanceStatus = { configured: boolean };
type BinanceTestResult = { connected: true; accountType: string; canTrade: boolean; latencyMs: number; tick: { symbol: string; bid: number; ask: number; time: number } };

function MarketTradingIntegrations({ request }: {
  request: <T,>(endpoint: string, options?: RequestInit) => Promise<T>;
}) {
  const [mt5, setMt5] = useState<Mt5Status | null>(null);
  const [binance, setBinance] = useState<BinanceStatus | null>(null);
  const [mt5Fields, setMt5Fields] = useState({ login: '', password: '', server: '' });
  const [terminalPath, setTerminalPath] = useState('');
  const [binanceFields, setBinanceFields] = useState({ apiKey: '', apiSecret: '' });
  const [mt5Result, setMt5Result] = useState<Mt5TestResult | null>(null);
  const [binanceResult, setBinanceResult] = useState<BinanceTestResult | null>(null);
  const [mt5Error, setMt5Error] = useState('');
  const [binanceError, setBinanceError] = useState('');
  const [mt5Message, setMt5Message] = useState('');
  const [binanceMessage, setBinanceMessage] = useState('');
  const [mt5Busy, setMt5Busy] = useState(false);
  const [binanceBusy, setBinanceBusy] = useState(false);
  const [terminalBusy, setTerminalBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void request<Mt5Status>('/api/integrations/mt5')
      .then(result => {
        if (!active) return;
        setMt5(result);
        setTerminalPath(result.terminalPath ?? '');
      })
      .catch(failure => { if (active) setMt5Error(failure instanceof Error ? failure.message : 'MetaTrader 5 status is unavailable.'); });
    void request<BinanceStatus>('/api/integrations/binance')
      .then(result => { if (active) setBinance(result); })
      .catch(failure => { if (active) setBinanceError(failure instanceof Error ? failure.message : 'Binance status is unavailable.'); });
    return () => { active = false; };
  }, [request]);

  const saveMt5 = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMt5Busy(true);
    setMt5Error('');
    setMt5Message('');
    setMt5Result(null);
    try {
      await request('/api/integrations/mt5', { method: 'POST', body: JSON.stringify(mt5Fields) });
      setMt5(current => ({ configured: true, terminalPath: current?.terminalPath }));
      setMt5Fields({ login: '', password: '', server: '' });
      setMt5Message('Account credentials were saved to the encrypted local vault.');
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : 'MetaTrader 5 credentials could not be saved.');
    } finally {
      setMt5Busy(false);
    }
  };

  const testMt5 = async () => {
    setMt5Busy(true);
    setMt5Error('');
    setMt5Message('');
    try {
      const result = await request<Mt5TestResult>('/api/integrations/mt5/test', {
        method: 'POST',
        body: JSON.stringify({ symbol: 'XAUUSD' }),
      });
      setMt5Result(result);
      setMt5Message('Connection and live tick test succeeded.');
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : 'MetaTrader 5 connection test failed.');
    } finally {
      setMt5Busy(false);
    }
  };

  const saveTerminal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTerminalBusy(true);
    setMt5Error('');
    setMt5Message('');
    try {
      const result = await request<Mt5Status>('/api/integrations/mt5/terminal', {
        method: 'PUT',
        body: JSON.stringify({ terminalPath }),
      });
      setMt5(result);
      setTerminalPath(result.terminalPath ?? '');
      setMt5Message('Terminal path saved to the local environment configuration.');
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : 'MetaTrader 5 terminal path could not be saved.');
    } finally {
      setTerminalBusy(false);
    }
  };

  const launchMt5 = async () => {
    setTerminalBusy(true);
    setMt5Error('');
    setMt5Message('');
    try {
      const result = await request<{ launched: true; pid?: number }>('/api/integrations/mt5/launch', { method: 'POST', body: '{}' });
      setMt5Message(`MetaTrader 5 launched${result.pid ? ` (process ${result.pid})` : ''}.`);
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : 'MetaTrader 5 could not be launched.');
    } finally {
      setTerminalBusy(false);
    }
  };

  const disconnectMt5 = async () => {
    setMt5Busy(true);
    setMt5Error('');
    setMt5Message('');
    try {
      const result = await request<Mt5Status>('/api/integrations/mt5', { method: 'DELETE' });
      setMt5(current => ({ configured: result.configured, terminalPath: result.terminalPath ?? current?.terminalPath }));
      setMt5Result(null);
      setMt5Message('MetaTrader 5 account credentials were removed.');
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : 'MetaTrader 5 credentials could not be removed.');
    } finally {
      setMt5Busy(false);
    }
  };

  const saveBinance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBinanceBusy(true);
    setBinanceError('');
    setBinanceMessage('');
    setBinanceResult(null);
    try {
      await request('/api/integrations/binance', { method: 'POST', body: JSON.stringify(binanceFields) });
      setBinance({ configured: true });
      setBinanceFields({ apiKey: '', apiSecret: '' });
      setBinanceMessage('API credentials were saved to the encrypted local vault.');
    } catch (failure) {
      setBinanceError(failure instanceof Error ? failure.message : 'Binance credentials could not be saved.');
    } finally {
      setBinanceBusy(false);
    }
  };

  const testBinance = async () => {
    setBinanceBusy(true);
    setBinanceError('');
    setBinanceMessage('');
    try {
      const result = await request<BinanceTestResult>('/api/integrations/binance/test', { method: 'POST', body: '{}' });
      setBinanceResult(result);
      setBinanceMessage('Authenticated account and live BTC/USDT tick test succeeded.');
    } catch (failure) {
      setBinanceError(failure instanceof Error ? failure.message : 'Binance connection test failed.');
    } finally {
      setBinanceBusy(false);
    }
  };

  const disconnectBinance = async () => {
    setBinanceBusy(true);
    setBinanceError('');
    setBinanceMessage('');
    try {
      const result = await request<BinanceStatus>('/api/integrations/binance', { method: 'DELETE' });
      setBinance(result);
      setBinanceResult(null);
      setBinanceMessage('Binance API credentials were removed.');
    } catch (failure) {
      setBinanceError(failure instanceof Error ? failure.message : 'Binance credentials could not be removed.');
    } finally {
      setBinanceBusy(false);
    }
  };

  return <>
    <article className="surface-card cloud-provider-card integration-provider-card market-integration-card">
      <div className="integration-card-header">
        <span className={`cloud-provider-icon${mt5?.configured ? ' cloud-provider-icon-online' : ''}`}><ChartCandlestick size={20} /></span>
        <div className="integration-card-title">
          <h2>MetaTrader 5</h2>
          <span className={`cloud-provider-status${mt5?.configured ? ' cloud-provider-status-online' : ''}`}>{mt5?.configured ? 'Account configured' : 'Not connected'}</span>
          {mt5Result && <span className="integration-account-name">Account {mt5Result.account} · {mt5Result.server}</span>}
        </div>
        <span className="integration-info" title="The account credentials are stored in the encrypted local credential vault. The connection test reads a live XAUUSD tick and does not place an order."><ShieldCheck size={14} /></span>
      </div>
      <form className="market-integration-form" onSubmit={event => void saveMt5(event)}>
        <label>Account<input inputMode="numeric" autoComplete="username" value={mt5Fields.login} onChange={event => setMt5Fields(current => ({ ...current, login: event.target.value }))} placeholder={mt5?.configured ? 'Saved · leave blank to keep' : 'MT5 account number'} required={!mt5?.configured} /></label>
        <label>Password<input type="password" autoComplete="new-password" value={mt5Fields.password} onChange={event => setMt5Fields(current => ({ ...current, password: event.target.value }))} placeholder={mt5?.configured ? 'Saved · leave blank to keep' : 'MT5 account password'} required={!mt5?.configured} /></label>
        <label>Server<input autoComplete="off" value={mt5Fields.server} onChange={event => setMt5Fields(current => ({ ...current, server: event.target.value }))} placeholder={mt5?.configured ? 'Saved · leave blank to keep' : 'Broker server name'} required={!mt5?.configured} /></label>
        <div className="market-integration-actions">
          <button className="button button-primary" type="submit" disabled={mt5Busy}><KeyRound size={13} />Save account</button>
          <button className="button button-secondary" type="button" onClick={() => void testMt5()} disabled={mt5Busy || !mt5?.configured}><Activity size={13} />Test tick</button>
          {mt5?.configured && <button className="button button-secondary" type="button" onClick={() => void disconnectMt5()} disabled={mt5Busy}>Disconnect</button>}
        </div>
      </form>
      {mt5Result && <p className="market-integration-result"><CheckCircle2 size={13} />{mt5Result.tick.symbol} bid {mt5Result.tick.bid} · ask {mt5Result.tick.ask} · {mt5Result.latencyMs} ms</p>}
      {mt5Message && <p className="cloud-provider-message" role="status">{mt5Message}</p>}
      {mt5Error && <p className="cloud-provider-error" role="alert">{mt5Error}</p>}
      <form className="market-terminal-form" onSubmit={event => void saveTerminal(event)}>
        <label><Terminal size={13} />Terminal executable path<input value={terminalPath} onChange={event => setTerminalPath(event.target.value)} placeholder="C:\Program Files\MetaTrader 5\terminal64.exe" required /></label>
        <div className="market-integration-actions">
          <button className="button button-secondary" type="submit" disabled={terminalBusy || !terminalPath.trim()}><Server size={13} />Save path</button>
          <button className="button button-secondary" type="button" onClick={() => void launchMt5()} disabled={terminalBusy || !mt5?.terminalPath}><Activity size={13} />Launch terminal</button>
        </div>
      </form>
    </article>

    <article className="surface-card cloud-provider-card integration-provider-card market-integration-card">
      <div className="integration-card-header">
        <span className={`cloud-provider-icon${binance?.configured ? ' cloud-provider-icon-online' : ''}`}><KeyRound size={19} /></span>
        <div className="integration-card-title">
          <h2>Binance</h2>
          <span className={`cloud-provider-status${binance?.configured ? ' cloud-provider-status-online' : ''}`}>{binance?.configured ? 'API configured' : 'Not connected'}</span>
          {binanceResult && <span className="integration-account-name">{binanceResult.accountType} · trading {binanceResult.canTrade ? 'enabled' : 'disabled'}</span>}
        </div>
        <span className="integration-info" title="Store an API key with read and trading permissions only. Withdrawal permissions are not required. The test checks authenticated account access and a public BTC/USDT tick."><ShieldCheck size={14} /></span>
      </div>
      <form className="market-integration-form" onSubmit={event => void saveBinance(event)}>
        <label>API key<input autoComplete="off" value={binanceFields.apiKey} onChange={event => setBinanceFields(current => ({ ...current, apiKey: event.target.value }))} placeholder={binance?.configured ? 'Saved · leave blank to keep' : 'Binance API key'} required={!binance?.configured} /></label>
        <label>API secret<input type="password" autoComplete="new-password" value={binanceFields.apiSecret} onChange={event => setBinanceFields(current => ({ ...current, apiSecret: event.target.value }))} placeholder={binance?.configured ? 'Saved · leave blank to keep' : 'Binance API secret'} required={!binance?.configured} /></label>
        <div className="market-integration-actions">
          <button className="button button-primary" type="submit" disabled={binanceBusy}><KeyRound size={13} />Save API credentials</button>
          <button className="button button-secondary" type="button" onClick={() => void testBinance()} disabled={binanceBusy || !binance?.configured}><RefreshCw size={13} />Test connection</button>
          {binance?.configured && <button className="button button-secondary" type="button" onClick={() => void disconnectBinance()} disabled={binanceBusy}>Disconnect</button>}
        </div>
      </form>
      {binanceResult && <p className="market-integration-result"><CheckCircle2 size={13} />{binanceResult.tick.symbol} bid {binanceResult.tick.bid} · ask {binanceResult.tick.ask} · {binanceResult.latencyMs} ms</p>}
      {binanceMessage && <p className="cloud-provider-message" role="status">{binanceMessage}</p>}
      {binanceError && <p className="cloud-provider-error" role="alert">{binanceError}</p>}
      <small className="integration-account-name">Credentials remain local and are never shown again after saving. Trading orders still require an explicit action from Markets.</small>
    </article>
  </>;
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
