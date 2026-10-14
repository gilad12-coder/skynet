# Slack app setup

Skynet sends notifications to Slack through its own Slack app. Each user
clicks **Add to Slack** in Settings → Notifications, installs the app into
their workspace, and picks where messages go: a direct message from the app
(the default) or a channel.

One Slack app can serve every environment. Register each backend's callback
URL on it.

## 1. Create the app

1. Go to <https://api.slack.com/apps> and click **Create New App** →
   **From a manifest**.
2. Pick a development workspace. This only owns the app; users can install
   it into other workspaces once distribution is on (step 3).
3. Choose **YAML**, paste the manifest below, and click **Next** → **Create**.

```yaml
display_information:
  name: Skynet
  description: Optimization run updates from Skynet.
  background_color: "#111111"
features:
  bot_user:
    display_name: Skynet
    always_online: false
oauth_config:
  redirect_urls:
    - http://localhost:8004/notifications/slack/oauth/callback
    - https://backend-staging-6295.up.railway.app/notifications/slack/oauth/callback
  scopes:
    bot:
      - chat:write
      - im:write
      - channels:read
      - groups:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Keep `token_rotation_enabled: false`. Skynet stores one long-lived bot token
per install and does not refresh tokens.

The callback path is `/notifications/slack/oauth/callback` on the **backend**
host. The API router has no prefix. Every redirect URL must match
`SLACK_REDIRECT_URL` (or the derived URL) exactly, including scheme and port.

## 2. Copy the credentials

On the app page, open **Basic Information** → **App Credentials**:

- **Client ID** goes into `SLACK_CLIENT_ID`.
- **Client Secret** (click **Show**) goes into `SLACK_CLIENT_SECRET`.

You don't need the signing secret or verification token. Skynet doesn't
receive Slack events.

## 3. Let other workspaces install it

By default, only the development workspace can install the app. To let users
install it into their own workspaces, open **Manage Distribution**, complete
the checklist (it requires HTTPS redirect URLs only), and click **Activate
Public Distribution**. You don't need to submit it to the Slack Marketplace.

## 4. Set the environment

| Variable | Local (`backend/.env`) | Staging (Railway backend service) |
| --- | --- | --- |
| `SLACK_CLIENT_ID` | the Client ID | the Client ID |
| `SLACK_CLIENT_SECRET` | the Client Secret | the Client Secret |
| `SLACK_REDIRECT_URL` | `http://localhost:8004/notifications/slack/oauth/callback` | `https://backend-staging-6295.up.railway.app/notifications/slack/oauth/callback` |
| `BYOK_VAULT_KEY` | already set if connectors work; otherwise generate one (below) | already set; don't rotate it |
| `APP_PUBLIC_URL` | the frontend, e.g. `http://localhost:3000` | the staging frontend URL |

- Bot tokens are encrypted with `BYOK_VAULT_KEY`, the same Fernet key that
  protects connector tokens. If the key changes, every stored Slack install
  becomes unreadable, shows as broken, and users must reconnect. To generate
  a key:
  `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
- Set `SLACK_REDIRECT_URL` explicitly on staging. Behind Railway's proxy, the
  URL derived from the request can come out as `http://`, which Slack rejects
  as a mismatch.
- After the install, the backend sends the browser to
  `APP_PUBLIC_URL/?settings=notifications&slack=connected` (or
  `slack=error`).
- Restart the backend after you change any of these.

Without `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, the Slack column in the
notification settings stays disabled with "Slack isn't set up on this server
yet".

## 5. Use it

1. Open Settings → Notifications and click **Add to Slack**. Slack asks
   which workspace to install into and shows the requested permissions.
2. After you approve, Skynet sends you back to the Notifications tab, and
   messages go to a DM from the app.
3. To use a channel, pick it in **Where Slack messages go**. The app can only
   post to channels it's a member of. In Slack, type `/invite @Skynet` in the
   channel, then pick it again. This always applies to private channels,
   which the app can't join on its own.
4. If Slack revokes the token, the app is uninstalled, or the channel is
   archived or the app is removed from it, Skynet stops posting and shows the
   connection as broken. To fix it, click **Reconnect Slack** or pick another
   destination.
5. **Disconnect** revokes the token in Slack and removes the connection.
