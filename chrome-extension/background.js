const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';

const oauthSessions = new Map();

async function getOAuthSession(state) {
  const memorySession = oauthSessions.get(state);
  if (memorySession) return memorySession;

  const stored = await chrome.storage.local.get('codex_oauth_session');
  if (!stored.codex_oauth_session) return null;

  try {
    const session = JSON.parse(stored.codex_oauth_session);
    if (session?.state !== state) return null;
    oauthSessions.set(state, session);
    return session;
  } catch {
    return null;
  }
}

function closeTab(tabId) {
  chrome.tabs.remove(tabId).catch(() => {});
}

function parseJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const payload = parts[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch (error) {
    console.error('[GPTeam OAuth] JWT parse failed:', error);
    return null;
  }
}

async function exchangeToken(code, codeVerifier, email) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseText}`);
  }

  const tokens = JSON.parse(responseText);
  const idTokenPayload = parseJWT(tokens.id_token);
  const tokenEmail = idTokenPayload?.email;

  if (tokenEmail && tokenEmail.toLowerCase() !== email.toLowerCase()) {
    throw new Error(`邮箱不匹配！\n期望: ${email}\n实际: ${tokenEmail}`);
  }

  return {
    email,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      authorized_at: new Date().toISOString()
    }
  };
}

async function proxyHttpRequest(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), request.timeout || 30000);

  try {
    const response = await fetch(request.url, {
      method: request.method || 'GET',
      headers: request.headers || {},
      body: request.data || undefined,
      signal: controller.signal
    });
    const responseText = await response.text();
    return {
      ok: true,
      status: response.status,
      responseText,
      responseHeaders: ''
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function notifyOAuthResult(session, payload) {
  if (!session.sourceTabId) return;
  chrome.tabs.sendMessage(session.sourceTabId, {
    type: 'gpteam_oauth_result',
    state: session.state,
    ...payload
  }).catch((error) => {
    console.warn('[GPTeam OAuth] failed to notify content tab:', error);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'gpteam_http_request') {
    proxyHttpRequest(message.request)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });
    return true;
  }

  if (message?.type === 'gpteam_start_oauth') {
    const session = {
      ...message.session,
      sourceTabId: sender.tab?.id || null,
      createdAt: Date.now()
    };
    oauthSessions.set(session.state, session);
    chrome.storage.local.set({
      codex_oauth_session: JSON.stringify(session)
    });
    chrome.windows.create({
      url: message.authUrl,
      type: 'popup',
      width: 500,
      height: 700,
      focused: true
    }, (win) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      const tab = win?.tabs?.[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: '授权窗口创建失败' });
        return;
      }
      session.authTabId = tab.id;
      oauthSessions.set(session.state, session);
      chrome.storage.local.set({
        codex_oauth_session: JSON.stringify(session)
      });
      sendResponse({ ok: true, tabId: tab.id });
    });
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url || !changeInfo.url.startsWith(REDIRECT_URI)) return;

  let url;
  try {
    url = new URL(changeInfo.url);
  } catch {
    return;
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return;

  const session = await getOAuthSession(state);
  if (!session) {
    console.warn('[GPTeam OAuth] callback session not found:', state);
    closeTab(tabId);
    return;
  }

  try {
    const result = await exchangeToken(code, session.codeVerifier, session.email);
    notifyOAuthResult(session, { ok: true, result });
  } catch (error) {
    notifyOAuthResult(session, {
      ok: false,
      error: error?.message || String(error)
    });
  } finally {
    oauthSessions.delete(state);
    chrome.storage.local.remove('codex_oauth_session');
    closeTab(tabId);
  }
});
