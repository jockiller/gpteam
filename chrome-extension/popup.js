const STORAGE_KEY = 'chatgpt_accounts';
const MEMBERS_URL = 'https://chatgpt.com/admin/members';

function loadAccounts(raw) {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function getStats(accounts) {
  const today = todayKey();
  const chatgptSeats = accounts.filter((account) => {
    const seatType = account.seatType || '';
    return seatType === 'ChatGPT' || seatType === 'chatgpt' || seatType.includes('ChatGPT');
  }).length;
  const todayUsed = accounts.filter((account) => {
    if (!account.lastGptSeatAt) return false;
    const d = new Date(account.lastGptSeatAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return key === today;
  }).length;
  return { total: accounts.length, chatgptSeats, todayUsed };
}

function quotaColor(percentage) {
  return percentage > 70 ? '#10b981' : percentage > 30 ? '#f59e0b' : '#ef4444';
}

function resetText(resetTime) {
  const now = Math.floor(Date.now() / 1000);
  if (resetTime > now) {
    const diff = resetTime - now;
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    return ` (${hours}h${minutes}m)`;
  }
  if (resetTime > 0) return ' (已重置)';
  return '';
}

function quotaUpdatedText(updatedAt) {
  if (!updatedAt) return '';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  if (sameDay) {
    return `最后刷新: ${time}`;
  }

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.max(1, Math.floor((todayStart - dateStart) / 86400000));
  return `最后刷新: ${daysAgo}天前`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(accounts) {
  const keyword = document.getElementById('search').value.trim().toLowerCase();
  const stats = getStats(accounts);
  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-chatgpt').textContent = stats.chatgptSeats;
  document.getElementById('stat-today').textContent = stats.todayUsed;

  const list = document.getElementById('list');
  const filtered = accounts
    .filter((account) => {
      if (!keyword) return true;
      return account.email?.includes(keyword) || account.note?.toLowerCase().includes(keyword);
    })
    .sort((a, b) => {
      if (a.status === 'joined' && b.status !== 'joined') return -1;
      if (a.status !== 'joined' && b.status === 'joined') return 1;
      return 0;
    });

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty">${keyword ? '无匹配结果' : '暂无邮箱'}</div>`;
    return;
  }

  list.innerHTML = filtered.map((account) => {
    const hasToken = account.codexTokens?.access_token;
    const tokenStatus = account.codexTokens?.status;
    const quota = account.codexTokens?.quota;
    const hourly = quota ? Math.round(quota.hourly_percentage || 0) : null;
    const weekly = quota ? Math.round(quota.weekly_percentage || 0) : null;
    const updatedText = quotaUpdatedText(account.codexTokens?.quota_updated_at);

    return `
      <article class="item ${account.status === 'joined' ? 'joined' : ''}">
        <div class="email">${escapeHtml(account.email)}</div>
        ${account.note ? `<div class="note">${escapeHtml(account.note)}</div>` : ''}
        <div class="meta">
          ${account.seatType ? `<span class="pill">席位: ${escapeHtml(account.seatType)}</span>` : ''}
          ${account.role ? `<span class="pill">${escapeHtml(account.role)}</span>` : ''}
          ${hasToken && tokenStatus === 'authorized' ? '<span class="pill" style="color:#10b981;">已授权</span>' : ''}
          ${hasToken && tokenStatus === 'expired' ? '<span class="pill" style="color:#ef4444;">已失效</span>' : ''}
        </div>
        ${quota ? `<div class="quota">
          <span class="pill" style="color:${quotaColor(hourly)};">5h: ${hourly}%${resetText(quota.hourly_reset_time || 0)}</span>
          <span class="pill" style="color:${quotaColor(weekly)};">周: ${weekly}%${resetText(quota.weekly_reset_time || 0)}</span>
          ${updatedText ? `<span class="pill quota-updated">${escapeHtml(updatedText)}</span>` : ''}
        </div>` : ''}
      </article>
    `;
  }).join('');
}

async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  let accounts = loadAccounts(stored[STORAGE_KEY]);
  render(accounts);
  document.getElementById('search').addEventListener('input', () => render(accounts));
  document.getElementById('open-members').addEventListener('click', openMembersPage);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
    accounts = loadAccounts(changes[STORAGE_KEY].newValue);
    render(accounts);
  });

  chrome.runtime.sendMessage({
    type: 'gpteam_refresh_quotas',
    force: false
  }).catch(() => {});
}

init();

async function openMembersPage() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/admin/members*' });
  const existing = tabs[0];
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true, url: MEMBERS_URL });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: MEMBERS_URL, active: true });
  }
  window.close();
}
