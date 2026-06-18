const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const STORAGE_ACCOUNTS_KEY = 'chatgpt_accounts';
const QUOTA_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const QUOTA_STALE_MS = 2 * 60 * 1000;
const QUOTA_ALARM_NAME = 'gpteam_refresh_quotas';

const oauthSessions = new Map();
let quotaRefreshInFlight = false;

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

function loadAccounts(raw) {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

async function saveAccounts(accounts) {
  await chrome.storage.local.set({
    [STORAGE_ACCOUNTS_KEY]: JSON.stringify(accounts)
  });
}

function parseQuotaResponse(data) {
  const rateLimit = data.rate_limit || {};
  const primaryWindow = rateLimit.primary_window || {};
  const secondaryWindow = rateLimit.secondary_window || {};

  const hourlyUsedPct = primaryWindow.used_percent || 0;
  const weeklyUsedPct = secondaryWindow.used_percent || 0;

  return {
    hourly_percentage: Math.max(0, 100 - hourlyUsedPct),
    hourly_reset_time: primaryWindow.reset_at || null,
    weekly_percentage: Math.max(0, 100 - weeklyUsedPct),
    weekly_reset_time: secondaryWindow.reset_at || null,
    raw_data: data
  };
}

async function fetchQuota(accessToken) {
  const response = await fetch(QUOTA_ENDPOINT, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  const responseText = await response.text();
  if (response.status === 401 || response.status === 403) {
    const error = new Error('token_expired');
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${responseText}`);
    error.status = response.status;
    throw error;
  }

  return parseQuotaResponse(JSON.parse(responseText));
}

function shouldRefreshAccount(account, options) {
  if (!account.codexTokens?.access_token) return false;
  if (account.codexTokens.status === 'expired') return false;
  if (options.email && account.email !== options.email) return false;
  if (options.force || options.email) return true;

  const lastUpdate = account.codexTokens.quota_updated_at
    ? new Date(account.codexTokens.quota_updated_at).getTime()
    : 0;
  return Date.now() - lastUpdate > QUOTA_STALE_MS;
}

async function refreshQuotas(options = {}) {
  if (quotaRefreshInFlight && !options.force) {
    return { ok: true, skipped: true, reason: 'in_flight' };
  }

  quotaRefreshInFlight = true;
  const result = { ok: true, refreshed: 0, expired: 0, failed: 0 };

  try {
    const stored = await chrome.storage.local.get(STORAGE_ACCOUNTS_KEY);
    const accounts = loadAccounts(stored[STORAGE_ACCOUNTS_KEY]);
    let changed = false;

    for (const account of accounts) {
      if (!shouldRefreshAccount(account, options)) continue;

      try {
        const quota = await fetchQuota(account.codexTokens.access_token);
        account.codexTokens = {
          ...account.codexTokens,
          quota,
          quota_updated_at: new Date().toISOString(),
          status: 'authorized'
        };
        result.refreshed += 1;
        changed = true;
      } catch (error) {
        console.error('[GPTeam Quota] refresh failed:', account.email, error);
        if (error.status === 401 || error.status === 403 || error.message === 'token_expired') {
          account.codexTokens = {
            ...account.codexTokens,
            status: 'expired',
            quota_updated_at: new Date().toISOString()
          };
          result.expired += 1;
          changed = true;
        } else {
          result.failed += 1;
        }
      }
    }

    if (changed) {
      await saveAccounts(accounts);
    }

    return result;
  } finally {
    quotaRefreshInFlight = false;
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

  if (message?.type === 'gpteam_refresh_quotas') {
    refreshQuotas({
      force: Boolean(message.force),
      email: message.email || null
    })
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(QUOTA_ALARM_NAME, {
    periodInMinutes: 2
  });
  refreshQuotas({ force: false }).catch((error) => {
    console.warn('[GPTeam Quota] initial refresh failed:', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(QUOTA_ALARM_NAME, {
    periodInMinutes: 2
  });
  refreshQuotas({ force: false }).catch((error) => {
    console.warn('[GPTeam Quota] startup refresh failed:', error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== QUOTA_ALARM_NAME) return;
  refreshQuotas({ force: false }).catch((error) => {
    console.warn('[GPTeam Quota] alarm refresh failed:', error);
  });
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
