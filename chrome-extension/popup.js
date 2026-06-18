const STORAGE_KEY = 'chatgpt_accounts';

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
        </div>` : ''}
      </article>
    `;
  }).join('');
}

async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const accounts = loadAccounts(stored[STORAGE_KEY]);
  render(accounts);
  document.getElementById('search').addEventListener('input', () => render(accounts));
}

init();
