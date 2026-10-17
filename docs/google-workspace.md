# Integrations: Google Workspace

The Control Room's **Integrations** page uses Firebase Authentication for Google sign-in. One explicit consent requests access for Drive, Gmail, Calendar, Contacts, Docs, Sheets, Slides, Tasks, Chat, and Google Forms editing and response reading. Forms responses are read-only; Google's OAuth endpoint rejects the broader `forms.responses` scope, so the integration requests `forms.responses.readonly` instead. After consent, the page probes each app and shows its live reachability; no separate per-app authorization is needed.

The runtime registers the `google_workspace` agent tool. While a valid browser grant is available, web chat, workspace tasks, and their subagents can call the Google APIs directly, including creating, editing, deleting, and sending data. The short-lived access token is kept in browser memory and included only with the active chat/task request; it is not written to configuration, session history, or logs. It expires automatically, and the user must renew it after expiry or a page reload. Other channels do not receive the browser credential.

This is user-account OAuth, not Google Cloud organization administration. The token cannot access resources the signed-in user cannot access. OAuth verification, Workspace administrator policy, account type, and enabled APIs can further restrict individual services.

The Electron shell loads the same gateway-served Control Room, so the Integrations page and dashboard status icon ship through the normal webapp build without a separate Electron UI. The desktop URL uses loopback; sign-in still depends on Google allowing OAuth in the embedded Electron browser. Validate OAuth in the packaged Electron app before promising desktop Workspace access; if Google blocks the embedded user agent, the desktop needs a system-browser OAuth flow.

## Google Cloud and Firebase setup

The web client reads Firebase's public web-app settings from `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID` at build time. Copy `webapp/.env.example` to `webapp/.env.local`, fill in the settings for your Firebase web app, and rebuild. The integration stays unavailable with an actionable message when the settings are omitted; the rest of the app still builds and runs. These values are public client configuration, not server credentials, and are embedded in the built JavaScript. Restrict the Firebase API key to the deployed web origins and the Firebase Authentication APIs used by the client. Never put private service-account keys or other server credentials in Vite variables. A distributed app can use one publisher-owned Firebase/Google OAuth project so each installer signs into their own Google account; users do not need to supply Firebase or Google developer keys. This requires the publisher to configure and maintain the Firebase project, OAuth consent/verification, enabled APIs, and quotas. The signed-in user's account permissions and Workspace administrator policies still apply. For browser access from other devices, use a stable authorized HTTPS hostname; arbitrary LAN IPs must be added as authorized domains and are not suitable as a universal production callback.

Install the independently locked webapp dependencies before building from a fresh checkout:

```powershell
npm ci --prefix webapp
npm run build
```

Before connecting accounts:

1. Enable Google as a sign-in provider in Firebase Authentication.
2. Add the Control Room's host to Firebase Authentication's authorized domains. Include both `localhost` and `127.0.0.1` for local access, plus the deployed LAN/domain hostname for other devices. A host must be authorized by Firebase before Google popup sign-in can work.
3. Configure the Google OAuth consent screen and publish/verify it as required for the requested full-access scopes. Gmail, Chat, and other Workspace scopes can be sensitive or restricted and may be unavailable until Google approves the OAuth application. Admin policy may also block access. Do not add `https://www.googleapis.com/auth/forms.responses`; Forms responses are requested with the read-only `https://www.googleapis.com/auth/forms.responses.readonly` scope.
4. Enable the corresponding APIs in the same Google Cloud project: Drive, Gmail, Calendar, People, Tasks, Google Chat, Docs, Sheets, Slides, and Forms.
5. Rebuild the webapp after changing Firebase client configuration.

The app probes all ten Workspace services after a successful grant using small, read-only requests. Drive, Gmail, Calendar, Contacts, Tasks, and Chat use service-specific list endpoints. Docs, Sheets, Slides, and Forms first locate one matching file through Drive, then request only that file's ID and title from its own API; document contents are not fetched. If no matching file is available, the app is shown as unavailable with an explanation instead of being silently marked online. The probes do not bulk-import account contents. The agent can use `google_workspace` for additional API operations. Google API errors are reported per service rather than treating a granted scope as proof that an API is enabled.

Google may reject a connection when an API is disabled, the consent screen is unverified, an account lacks access, or a requested scope is not approved. The app marks unavailable services and displays their API errors; local chat and the gateway continue to work.
