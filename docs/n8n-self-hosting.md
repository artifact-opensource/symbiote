# Self-hosting n8n for Symbiote

Symbiote's n8n tool connects to one configured instance at a time. By default it uses the n8n process on the same host; saving an endpoint and key in **Integrations** explicitly selects a different instance. The tool manages workflows through n8n's API. n8n itself owns workflow execution, schedules, retries, and webhook triggers.

## Native install and runtime

Use a dedicated, always-on host for production schedules. The same native n8n install can run on Windows or Linux. Keep the editor/API bound to loopback and let Symbiote connect to `http://127.0.0.1:5678/api/v1`; do not expose the n8n editor or API publicly.

The current n8n npm installation guide specifies Node.js 20.19 through 24.x and warns that npm installs are deprecated starting with n8n 3.0. Check the current official [npm installation guide](https://docs.n8n.io/deploy/host-n8n/install-options/install-with-npm/) and supported Node range before deploying. Keep n8n's dependencies in a separate directory under `C:\workspace`; do not install them into Symbiote's project or change Symbiote's Node runtime. The pinned n8n package version used in this workspace declares its own Node engine requirement; still smoke-test the exact Node release and n8n version before production use.

For a local test instance, install a reviewed, fixed n8n version in its own directory:

```powershell
npm install --prefix C:\workspace\n8n-local n8n@<reviewed-version>
node C:\workspace\n8n-local\node_modules\n8n\bin\n8n start
```

Use the equivalent commands in a Linux shell. Do not use an unpinned `latest` version for production. Before upgrading, back up the database and n8n data, read the migration notes, and verify the rollback procedure.

For production, configure a persistent PostgreSQL database rather than relying on SQLite for a busy or critical automation service. Persist n8n's user data directory and set a stable, high-entropy `N8N_ENCRYPTION_KEY` in n8n's service environment. Back up the key separately from encrypted credentials and the database: losing or changing it can make stored credentials unrecoverable. Configure timezone explicitly, and configure n8n's URL/proxy variables to match the actual deployment.

Run n8n as a dedicated, unprivileged OS account and an automatically restarted service:

- **Linux:** use a `systemd` unit with an explicit Node/n8n executable path, a restricted service user, an external `EnvironmentFile` with owner-only permissions, persistent storage, and restart-on-failure. Use a database service dependency/health check.
- **Windows:** use a supported Windows service wrapper or a carefully managed Scheduled Task with “run whether user is logged on or not,” startup delay, restart-on-failure, a dedicated service account, and a protected environment file/data directory. Do not run the service as an interactive administrator.

Keep port 5678 bound to loopback. For inbound webhooks, put a TLS reverse proxy in front and allow only the specific active webhook routes that must receive external requests; block the editor, login, and `/api/` routes from public ingress. Set `WEBHOOK_URL`, proxy hops, and n8n's public host/protocol settings to the externally reachable HTTPS webhook URL. Never enable n8n's development tunnel for production.

### Current Windows workspace instance

The local workspace install is pinned to n8n `2.44.5` under `C:\workspace\n8n-local` and uses the existing Node.js 26 runtime. Start it with `C:\workspace\n8n-local\start-n8n.ps1`; it binds only to `127.0.0.1:5678`, stores persistent state under `C:\workspace\n8n-data`, and sets the workflow timezone to `Asia/Karachi` to match this host. The `Symbiote Local n8n` Scheduled Task is configured for user logon and restart-on-failure. Its observed run found the already-running healthy process, so a cold-start or reboot recovery has not yet been verified. Confirm the task launches n8n from a stopped state before relying on it for production schedules. The machine must remain powered on and the task's user must be signed in.

The SQLite database passes an integrity check and is appropriate for this single-user, low-volume local setup, but it is not the recommended backend for a busy or critical production service. The JavaScript Code-node runner starts in internal mode; the native Python runner is not provisioned, so Python Code nodes are not operational. n8n warns that internal runners are deprecated and that future releases may require the official Docker image. Do not upgrade this no-Docker deployment without checking n8n's current support requirements and testing the upgrade and rollback.

The npm install allows the `sqlite3` native binding script only; other dependency install scripts remain blocked unless individually approved. Some optional integrations may therefore need package-specific validation. Unverified community packages are explicitly enabled to preserve n8n's current default behavior. Such packages execute code with the n8n Windows account's permissions; review each package before installing it.

## Connect Symbiote

1. In n8n, finish initial owner setup and create a REST API key with an appropriate expiry.
2. Put the REST key in Symbiote's ignored `.env` as `N8N_API_KEY=...`. The optional `N8N_BASE_URL` defaults to `http://127.0.0.1:5678/api/v1`.
3. Restart the Symbiote gateway so it reads the new environment.
4. Open **Control Room → Integrations → n8n (local by default)** and run **Test connection**. The test performs a read-only request to list at most one workflow.
5. Use the built-in `n8n_workflow` agent tool for normal workflow and execution operations: list/read/create/update workflows, publish/unpublish, archive/unarchive, and list/read/stop/retry executions. Create/update operations require a complete workflow object. Creating a workflow does not publish it.
6. The local editor can be embedded on demand from Integrations; it is not loaded until requested. A remote override is opened in a separate tab instead. If browser or n8n framing policy prevents embedding, use **Open editor**.

An endpoint/API key saved in the Integrations page is encrypted in Symbiote's local credential vault and explicitly overrides the local `.env` connection. The API key is never shown back in the UI. Removing the saved override returns to local `.env` configuration if `N8N_API_KEY` is set. The lower-level `n8n_cloud` tool is available for advanced public API resources; REST and MCP n8n tools are restricted to admin-tier sessions.

The Symbiote Gateway does not require the n8n REST API to start. If the REST endpoint is unavailable, the connection test and `n8n_workflow` call return an explicit failure while the rest of Symbiote remains available. n8n's published schedules run in n8n itself and do not require Symbiote to stay open; they do require the n8n process and its database to remain healthy. Remote instance-level MCP tools are discovered at Gateway startup; if that remote MCP endpoint is down then, the Gateway logs a warning and those MCP tools are unavailable until the Gateway is restarted. The native REST integration remains separately usable when its configured instance is online.

The remote instance-level MCP connection is separate from REST:

1. In n8n, enable the workflows that should be exposed through **Settings → Instance-level MCP**, then generate its MCP access key.
2. Set `N8N_MCP_URL=https://<instance>/mcp-server/http` and `N8N_MCP_KEY=...` in Symbiote's ignored `.env`. `INSTANCE_URL` and `N8N_MCP_TOKEN` are accepted aliases.
3. Restart Symbiote. It discovers remote MCP tools at gateway startup and registers them as `n8n_mcp_*`.

The MCP key is not a REST API key; configure each connection independently. Both keys are sensitive administrator credentials. Symbiote keeps `.env` out of source control, but the host account, process environment, backups, and logs must also be protected. REST and MCP n8n tools are restricted to admin-tier sessions.

## Workflow ownership

Use n8n's Schedule Trigger for recurring workflow automation. It continues to operate independently of Symbiote conversation state and is visible in the n8n workflow editor. Publish the workflow to activate its schedule; this instance uses the `Asia/Karachi` timezone. Use Symbiote's `cron_manage` for scheduled agent tasks, reminders, and follow-ups—not as a duplicate scheduler for the same workflow.

The public n8n REST API does not provide a general endpoint for manually running an arbitrary workflow. For on-demand execution, configure a Webhook Trigger and call its webhook URL, or run/test the workflow in the editor. Inspect execution details before retrying: a retry can repeat messages, writes, purchases, or other external side effects. Prefer archiving to permanent deletion.

Self-hosting avoids n8n Cloud hosting charges; it does not remove quotas or charges for the APIs and services that workflows use. The free Community edition has most core features, but some features are paid. Confirm current edition and licensing requirements from n8n's [plans guide](https://docs.n8n.io/choose-how-to-use-n8n/) and [license](https://github.com/n8n-io/n8n/blob/master/LICENSE.md).
