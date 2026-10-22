# Cloud and Automation Integrations

The **Integrations** page stores Azure, Oracle Cloud Infrastructure (OCI), n8n, and Kaggle credentials for use by the gateway's built-in tools:

- `azure_cloud` — Azure Resource Manager requests limited to the configured subscription.
- `oci_cloud` — signed regional OCI requests to Compute, Identity, Object Storage, Resource Manager, and other OCI service endpoints.
- `n8n_workflow` — admin-only workflow lifecycle and execution-history operations using the local n8n API by default; a saved endpoint and API key in Integrations explicitly override it.
- `n8n_cloud` — advanced n8n REST API requests limited to the configured `/api/v1` root.
- `kaggle_cloud` — Kaggle API requests using the account's API credentials.
- `kaggle_kernel_push` — uploads and runs a private Python notebook; GPU and internet use are optional notebook settings and remain subject to Kaggle policy and quotas.

The generic provider tools accept provider API paths, methods, JSON query parameters, and JSON bodies. They can perform mutating operations, including resource creation and deletion. Those actions run immediately and may incur charges or cause data loss. No provisioning is performed by the connection test or by saving credentials. Review the provider's API operation and cost before asking the agent to execute it.

## Local encrypted credential vault

Credentials are encrypted with AES-256-GCM in the Symbiote app home directory:

```text
%USERPROFILE%\.symbiote\vault\integrations.enc
```

If `SYMBIOTE_HOME` is set, the vault is under that directory instead. The randomly generated 32-byte `SYMBIOTE_VAULT_KEY` is stored outside the repository in `C:\workspace\.admin\.env` for the default checkout. Set `SYMBIOTE_ADMIN_ENV` to use a different external key-file path. Existing entries in the key file are preserved. Do not commit or share the key file or encrypted vault; losing the key makes the stored credentials unrecoverable. Back up both files securely if a recoverable backup is required.

The browser receives only configured/not-configured status; it cannot read stored secrets. The integration API uses the same loopback/LAN access-token protection as the rest of the Control Room. Secret form fields are write-only: blank values leave the saved field unchanged, and **Disconnect** deletes that provider's local credentials.

## Provider setup

### Microsoft Azure

Create an Entra ID application/service principal and provide its tenant ID, application (client) ID, client secret, and subscription ID. Grant the service principal the Azure role assignments needed for the intended work. Subscription Owner grants broad provisioning and deletion rights; use that scope only when authorized. The tool exchanges the client credentials for a short-lived Resource Manager token and rejects paths outside the configured subscription.

### Oracle Cloud Infrastructure

Provide the tenancy OCID, user OCID, API key fingerprint, private key PEM, and region. Upload the matching public key to the OCI user profile and configure OCI policies for the required resource families. Known service aliases cover common OCI APIs; other endpoint labels are also accepted but requests remain under the selected region's `oraclecloud.com` host. OCI permissions are governed by those policies and the private key; this integration does not broaden them.

### n8n local (default) or optional remote instance

Install n8n directly on the host (see [Self-hosting n8n for Symbiote](n8n-self-hosting.md)). Create an n8n REST API key, then set `N8N_API_KEY` in Symbiote's ignored `.env`. The default API root is `http://127.0.0.1:5678/api/v1`; set `N8N_BASE_URL` only if the local instance uses a different API root. Restart Symbiote after environment changes. Requests are confined to the configured API root and redirects are rejected.

The n8n MCP endpoint is separate from the REST API and uses an instance-level MCP key. Set `N8N_MCP_URL` and `N8N_MCP_KEY` (or `N8N_MCP_TOKEN`); `INSTANCE_URL` is accepted as a legacy URL alias. Discovered tools use the `n8n_mcp_` prefix and are limited to admin sessions.

The local environment connection is the default. If an endpoint and API key are saved in **Integrations**, that explicit connection takes precedence and can point to an HTTPS remote/self-hosted or Cloud instance. Thus a Cloud instance is not selected automatically: it must be explicitly configured with its API key. Treat the key like an administrator credential. The `n8n_workflow` tool handles listing, reading, creating, updating, publishing/unpublishing, archiving/unarchiving workflows, and listing, reading, stopping, or retrying executions. It is hidden from and restricted to admin-tier sessions. The lower-level `n8n_cloud` tool remains available for advanced API resources.

The Integrations card shows the selected connection source and API root without disclosing the key. A saved override is encrypted in the local credential vault; removing it falls back to the local `.env` key when configured. The local n8n editor can be embedded on demand; remote editor instances open in a new tab. The editor is not loaded on page startup.

Create/update requests require a complete workflow object, and creating a workflow does not publish it. Review nodes, credentials, permissions, and external effects before publishing. n8n's Schedule Trigger runs only when the workflow is published and uses the selected n8n instance timezone. The public REST API has no general endpoint to manually run an arbitrary workflow: use a configured Webhook Trigger or the n8n editor. Inspect an execution before retrying because retries can repeat external side effects. Prefer archiving to permanent deletion.

For native production deployments, keep n8n and its database persistent, set and back up a stable `N8N_ENCRYPTION_KEY`, pin a tested n8n version, and restrict the editor/API to trusted access. Keep the editor/API private; publish only webhook endpoints that need external callers, through a TLS reverse proxy with workflow-level authentication. Do not expose port 5678 directly to the public internet.

See [Self-hosting n8n for Symbiote](n8n-self-hosting.md) for native Linux and Windows service deployment guidance and the distinction between n8n workflow schedules and Symbiote cron jobs.

n8n's native Schedule Trigger should own recurring workflow schedules. Symbiote's `cron_manage` remains for scheduled agent prompts and follow-ups; avoid creating duplicate recurring schedules in both systems. Self-hosting removes n8n Cloud hosting charges, not costs or quotas from external APIs and connected services. Community Edition is free with most core features, but some capabilities remain paid; check n8n's current [plan and edition comparison](https://docs.n8n.io/choose-how-to-use-n8n/). The Sustainable Use License allows internal business or personal use, not offering n8n as a paid hosted/white-label service; see the upstream [license](https://github.com/n8n-io/n8n/blob/master/LICENSE.md).

The Symbiote Gateway does not require n8n's REST API to start; an unavailable REST endpoint causes the integration call to fail explicitly without disabling the rest of Symbiote. Published schedules execute within n8n and do not depend on Symbiote staying open. Remote instance-level MCP tools are discovered at Gateway startup; if that endpoint is unavailable, the Gateway logs a warning and those MCP tools require a Gateway restart after recovery.

### Kaggle

Create an API token in Kaggle account settings and enter it. Leave the username blank for a current bearer token; enter the account username as well when using a legacy API key. Kaggle access, notebook accelerators, internet access, datasets, and runtime are controlled by the Kaggle account, account verification, current quotas, and Kaggle's policies. `kaggle_kernel_push` uploads a Python notebook archive; it defaults to a private kernel and can consume GPU quota when `enableGpu` is enabled. Do not include secrets in notebook source or output.

## Validation and limitations

Use **Test** on an individual provider card to run a small read-only request. A configured indicator means credentials are stored; it is not a continuously refreshed health check. Connection tests require valid account credentials, network access, and enabled provider APIs. Tests do not provision resources or run Kaggle GPU jobs.

Generic API requests currently accept JSON request bodies up to 1 MB. Kaggle notebook uploads are limited to 1 MB of notebook source. The integrations are local to the gateway machine and are not isolated per remote Control Room user. Admin-only n8n access is enforced in the tool sandbox; other configured provider tools follow their existing access policy.
