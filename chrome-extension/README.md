# GPTeam Chrome Extension

Chrome MV3 version of the GPTeam Tampermonkey script.

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this `chrome-extension` directory.
5. Open `https://chatgpt.com/admin/members`.

## Behavior

- The members page injects the full GPTeam operation panel.
- OAuth authorization opens in a new tab.
- When the OAuth flow redirects to `http://localhost:1455/auth/callback`, the background service worker captures the callback URL, exchanges the code for tokens, closes the callback tab, and notifies the members page.
- The extension popup is read-only. It shows stored accounts, status, notes, and quota data, but hides operational buttons because those actions require the live members page DOM.

## Storage

Data is stored in `chrome.storage.local` using the same logical keys as the Tampermonkey version:

- `chatgpt_accounts`
- `last_copied_email`
- `codex_oauth_session`

## Permissions

The extension needs:

- `storage` for local account/token data.
- `tabs` to open OAuth tabs and detect the `localhost:1455` callback URL.
- host permissions for ChatGPT, OpenAI auth, and local callback/upload URLs.
