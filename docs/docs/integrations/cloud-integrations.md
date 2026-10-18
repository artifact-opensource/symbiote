# Cloud and Automation Integrations

The **Integrations** page stores Azure, Oracle Cloud Infrastructure (OCI), n8n Cloud, and Kaggle credentials for use by the gateway's built-in tools:

- `azure_cloud` — Azure Resource Manager requests limited to the configured subscription.
- `oci_cloud` — signed regional OCI requests to Compute, Identity, Object Storage, Resource Manager, and other OCI service endpoints.
- `n8n_cloud` — requests limited to the configured HTTPS `/api/v1` root.
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

### n8n Cloud

Create an API key in n8n and enter it with the instance API root ending in `/api/v1`, such as `https://example.app.n8n.cloud/api/v1`. The client enforces HTTPS and confines requests to that API root.

### Kaggle

Create an API token in Kaggle account settings and enter it. Leave the username blank for a current bearer token; enter the account username as well when using a legacy API key. Kaggle access, notebook accelerators, internet access, datasets, and runtime are controlled by the Kaggle account, account verification, current quotas, and Kaggle's policies. `kaggle_kernel_push` uploads a Python notebook archive; it defaults to a private kernel and can consume GPU quota when `enableGpu` is enabled. Do not include secrets in notebook source or output.

## Validation and limitations

Use **Test** on an individual provider card to run a small read-only request. A configured indicator means credentials are stored; it is not a continuously refreshed health check. Connection tests require valid account credentials, network access, and enabled provider APIs. Tests do not provision resources or run Kaggle GPU jobs.

Generic API requests currently accept JSON request bodies up to 1 MB. Kaggle notebook uploads are limited to 1 MB of notebook source. The integrations are local to the gateway machine and are not isolated per remote Control Room user; anyone authorized to use the agent can invoke its provider tools.
