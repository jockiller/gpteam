(async function() {
    'use strict';

    const gpteamStorageCache = await chrome.storage.local.get(null);

    function GM_addStyle(css) {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
        return style;
    }

    function GM_getValue(key, defaultValue) {
        return Object.prototype.hasOwnProperty.call(gpteamStorageCache, key)
            ? gpteamStorageCache[key]
            : defaultValue;
    }

    function GM_setValue(key, value) {
        gpteamStorageCache[key] = value;
        chrome.storage.local.set({ [key]: value });
    }

    function GM_xmlhttpRequest(options) {
        chrome.runtime.sendMessage({
            type: 'gpteam_http_request',
            request: {
                method: options.method || 'GET',
                url: options.url,
                headers: options.headers || {},
                data: options.data || null,
                timeout: options.timeout || 30000
            }
        }).then((response) => {
            if (!response || !response.ok) {
                options.onerror?.(response?.error || new Error('Request failed'));
                return;
            }
            options.onload?.({
                status: response.status,
                responseText: response.responseText,
                responseHeaders: response.responseHeaders || ''
            });
        }).catch((error) => {
            options.onerror?.(error);
        });
    }

    const unsafeWindow = window;

    // 是否启用上传到 Cockpit 功能（控制上传按钮显示及 OAuth 授权后自动上传）
    const ENABLE_UPLOAD = false;

    // 检测当前页面
    const isAuthPage = window.location.hostname === 'auth.openai.com';
    const isChatGPTSite = window.location.hostname === 'chatgpt.com';

    console.log('[脚本初始化] 当前页面检测:', {
        hostname: window.location.hostname,
        pathname: window.location.pathname,
        href: window.location.href,
        isAuthPage,
        isChatGPTSite
    });

    // auth.openai.com 页面：只标记邮箱行
    if (isAuthPage) {
        initAuthPageMarker();
        return;
    }

    // chatgpt.com 其他页面：不处理
    if (!isChatGPTSite) {
        return;
    }

    // ==================== Codex OAuth 管理器 ====================
    class CodexOAuthManager {
        constructor() {
            this.CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
            this.AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
            this.TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
            this.REDIRECT_URI = 'http://localhost:1455/auth/callback';
            this.SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
        }

        // 生成随机 Base64URL 字符串
        generateRandomString() {
            const array = new Uint8Array(32);
            crypto.getRandomValues(array);
            return this.base64UrlEncode(array);
        }

        // Base64URL 编码
        base64UrlEncode(buffer) {
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary)
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=/g, '');
        }

        // 生成 code_challenge
        async generateCodeChallenge(verifier) {
            const encoder = new TextEncoder();
            const data = encoder.encode(verifier);
            const hash = await crypto.subtle.digest('SHA-256', data);
            return this.base64UrlEncode(hash);
        }

        // 解析 JWT Token
        parseJWT(token) {
            try {
                const parts = token.split('.');
                if (parts.length !== 3) throw new Error('Invalid JWT');

                const payload = parts[1];
                const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
                const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
                return JSON.parse(decoded);
            } catch (error) {
                console.error('解析 JWT 失败:', error);
                return null;
            }
        }

        // 交换 Token
        exchangeToken(code, codeVerifier, email) {
            return new Promise((resolve, reject) => {
                const params = new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: this.REDIRECT_URI,
                    client_id: this.CLIENT_ID,
                    code_verifier: codeVerifier
                });

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: this.TOKEN_ENDPOINT,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    data: params.toString(),
                    onload: (response) => {
                        try {
                            if (response.status !== 200) {
                                console.error('[OAuth] HTTP 错误:', response.status);
                                throw new Error(`HTTP ${response.status}: ${response.responseText}`);
                            }

                            const tokens = JSON.parse(response.responseText);

                            // 验证邮箱是否匹配
                            const idTokenPayload = this.parseJWT(tokens.id_token);
                            const tokenEmail = idTokenPayload?.email;

                            if (tokenEmail && tokenEmail.toLowerCase() !== email.toLowerCase()) {
                                console.error('[OAuth] 邮箱不匹配');
                                reject(new Error(`邮箱不匹配！\n期望: ${email}\n实际: ${tokenEmail}`));
                                return;
                            }

                            const result = {
                                email: email,
                                tokens: {
                                    id_token: tokens.id_token,
                                    access_token: tokens.access_token,
                                    refresh_token: tokens.refresh_token,
                                    authorized_at: new Date().toISOString()
                                }
                            };

                            resolve(result);

                        } catch (error) {
                            console.error('[OAuth] 处理响应失败:', error);
                            reject(error);
                        }
                    },
                    onerror: (error) => {
                        console.error('[OAuth] 网络请求失败:', error);
                        reject(new Error(`网络请求失败: ${error.error || error}`));
                    }
                });
            });
        }

        // 查询账户额度
        fetchQuota(accessToken) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://chatgpt.com/backend-api/wham/usage',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json'
                    },
                    onload: (response) => {
                        if (response.status === 401 || response.status === 403) {
                            reject({ error: 'token_expired', status: response.status });
                            return;
                        }

                        if (response.status !== 200) {
                            reject({ error: 'http_error', status: response.status, message: response.responseText });
                            return;
                        }

                        try {
                            const data = JSON.parse(response.responseText);

                            // 解析额度信息
                            const rateLimit = data.rate_limit || {};
                            const primaryWindow = rateLimit.primary_window || {};
                            const secondaryWindow = rateLimit.secondary_window || {};

                            // Primary window = 5小时配额
                            const hourlyUsedPct = primaryWindow.used_percent || 0;
                            const hourlyRemaining = Math.max(0, 100 - hourlyUsedPct);
                            const hourlyResetAt = primaryWindow.reset_at || null;

                            // Secondary window = 周配额
                            const weeklyUsedPct = secondaryWindow.used_percent || 0;
                            const weeklyRemaining = Math.max(0, 100 - weeklyUsedPct);
                            const weeklyResetAt = secondaryWindow.reset_at || null;

                            const quota = {
                                hourly_percentage: hourlyRemaining,
                                hourly_reset_time: hourlyResetAt,
                                weekly_percentage: weeklyRemaining,
                                weekly_reset_time: weeklyResetAt,
                                raw_data: data
                            };

                            resolve(quota);

                        } catch (error) {
                            console.error('[Quota] 解析响应失败:', error);
                            reject({ error: 'parse_error', message: error.message });
                        }
                    },
                    onerror: (error) => {
                        console.error('[Quota] 网络请求失败:', error);
                        reject({ error: 'network_error', message: String(error) });
                    }
                });
            });
        }
    }

    // ==================== Auth 页面标记功能 ====================
    function initAuthPageMarker() {
        // 添加标记样式
        GM_addStyle(`
            .last-copied-email-row {
                border: 3px solid #ffc107 !important;
                border-radius: 4px;
            }
        `);

        let isMarked = false;
        let intervalId = null;

        // 定时检测并标记
        function markLastCopiedEmail() {
            if (isMarked) {
                if (intervalId) {
                    clearInterval(intervalId);
                }
                return;
            }

            const lastCopiedEmail = GM_getValue('last_copied_email', '');
            if (!lastCopiedEmail) {
                return;
            }

            // 移除之前的标记
            document.querySelectorAll('.last-copied-email-row').forEach(el => {
                el.classList.remove('last-copied-email-row');
            });

            // 查找包含该邮箱的元素
            const emailRegex = new RegExp(lastCopiedEmail.replace(/[.*+?^$()|[\]\\]/g, '\\$&'), 'i');
            let found = false;

            document.querySelectorAll('*').forEach(el => {
                if (el.children.length === 0 && el.textContent.includes('@')) {
                    if (emailRegex.test(el.textContent)) {
                        const row = el.closest('tr, div[role="row"], li, [class*="row"], [class*="item"]');
                        if (row && !row.classList.contains('last-copied-email-row')) {
                            row.classList.add('last-copied-email-row');
                            found = true;
                            isMarked = true;
                        }
                    }
                }
            });
        }

        // 初始标记
        setTimeout(markLastCopiedEmail, 1000);

        // 每 1 秒检测一次，找到后自动停止
        intervalId = setInterval(markLastCopiedEmail, 1000);
    }

    // ==================== Members 页面管理面板 ====================

    // 工具函数：根据百分比获取颜色
    function getQuotaColor(percentage) {
        return percentage > 70 ? '#10b981' : percentage > 30 ? '#f59e0b' : '#ef4444';
    }

    // 工具函数：计算重置倒计时文本
    function getResetText(resetTime) {
        const now = Math.floor(Date.now() / 1000);
        if (resetTime > now) {
            const diffSeconds = resetTime - now;
            const hours = Math.floor(diffSeconds / 3600);
            const minutes = Math.floor((diffSeconds % 3600) / 60);
            return ` (${hours}h${minutes}m)`;
        } else if (resetTime > 0) {
            return ' (已重置)';
        }
        return '';
    }

    // 样式定义
    GM_addStyle(`
        #account-panel {
            position: fixed;
            right: 20px;
            top: 80px;
            width: 380px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 16px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden;
        }

        #account-panel.collapsed {
            width: 180px;
        }

        #account-panel.collapsed .panel-body {
            display: none;
        }

        .panel-header {
            padding: 10px 16px;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
            color: white;
        }

        .panel-title {
            font-size: 14px;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .panel-toggle {
            background: rgba(255, 255, 255, 0.2);
            border: none;
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            transition: all 0.2s;
        }

        .panel-toggle:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .panel-body {
            padding: 14px;
            background: white;
            max-height: calc(85vh - 70px);
            overflow-y: auto;
        }

        .panel-body::-webkit-scrollbar {
            width: 8px;
        }

        .panel-body::-webkit-scrollbar-track {
            background: #f1f1f1;
        }

        .panel-body::-webkit-scrollbar-thumb {
            background: #888;
            border-radius: 4px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 6px;
            margin-bottom: 10px;
        }

        .stat-card {
            background: rgba(255, 255, 255, 0.95);
            padding: 6px 8px;
            border-radius: 8px;
            text-align: center;
            border: 1px solid rgba(102, 126, 234, 0.2);
        }

        .stat-value {
            font-size: 18px;
            font-weight: 700;
            color: #667eea;
            margin-bottom: 2px;
            line-height: 1;
        }

        .stat-label {
            font-size: 9px;
            color: #666;
            font-weight: 500;
        }

        .section {
            margin-bottom: 10px;
        }

        .section-title {
            font-size: 12px;
            font-weight: 600;
            color: #333;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .search-box {
            margin-bottom: 10px;
        }

        .search-input {
            width: 100%;
            padding: 6px 10px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 12px;
            outline: none;
            transition: all 0.2s;
            background: white;
            color: #333;
        }

        .search-input:focus {
            border-color: #667eea;
        }

        .batch-actions {
            display: flex;
            gap: 6px;
            margin-bottom: 10px;
        }

        .btn-batch {
            flex: 1;
            padding: 4px 8px;
            background: #ef4444;
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            height: 28px;
        }

        .btn-batch:hover {
            background: #dc2626;
        }

        .btn-batch.disabled {
            background: #ccc;
            cursor: not-allowed;
        }

        .input-group {
            display: flex;
            gap: 8px;
            margin-bottom: 10px;
        }

        .email-input {
            flex: 1;
            padding: 8px 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 13px;
            outline: none;
            transition: all 0.2s;
            background: white;
            color: #333;
            resize: vertical;
            min-height: 34px;
            max-height: 100px;
            font-family: inherit;
        }

        .email-input:focus {
            border-color: #667eea;
        }

        .email-input::placeholder {
            color: #999;
        }

        .btn-add {
            padding: 8px 16px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border: none;
            border-radius: 8px;
            color: white;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-add:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .email-list {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .email-item {
            background: #f9f9f9;
            padding: 6px 8px;
            border-radius: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border: 1px solid #e0e0e0;
            transition: all 0.2s;
        }

        .email-item:hover {
            border-color: #667eea;
        }

        .email-item.joined {
            background: #d1fae5;
            border-color: #6ee7b7;
        }

        .email-item.selected {
            border-color: #667eea;
            background: #e0e7ff;
        }

        .email-item.selected.joined {
            background: #a7f3d0;
        }

        .email-checkbox {
            margin-right: 8px;
            cursor: pointer;
            width: 16px;
            height: 16px;
        }

        .email-info {
            flex: 1;
            min-width: 0;
        }

        .email-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            margin-bottom: 2px;
        }

        .email-text {
            font-size: 12px;
            color: #333;
            word-break: break-all;
            cursor: pointer;
            user-select: text;
            flex: 1;
            min-width: 0;
        }

        .email-text:hover {
            color: #667eea;
        }

        .email-text:active {
            color: #059669;
        }

        .email-header-actions {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }

        .email-update-time {
            font-size: 9px;
            color: #9ca3af;
            white-space: nowrap;
            flex-shrink: 0;
        }

        .email-content-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            margin-top: 6px;
        }

        .email-content-left {
            flex: 1;
            min-width: 0;
        }

        .email-time-status {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 3px;
            flex-shrink: 0;
            font-size: 9px;
        }

        .email-meta-line {
            font-size: 10px;
            color: #666;
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: wrap;
        }

        .email-meta-line span {
            padding: 2px 6px;
            border-radius: 4px;
            background: #f3f4f6;
            white-space: nowrap;
        }

        .email-quota-line {
            font-size: 10px;
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: wrap;
            margin-top: 3px;
        }

        .email-quota-line span {
            padding: 2px 6px;
            border-radius: 4px;
            background: #f3f4f6;
            white-space: nowrap;
            font-weight: 600;
        }

        /* 保留旧的email-meta类以防万一 */
        .email-meta {
            font-size: 10px;
            color: #666;
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: wrap;
            margin-top: 4px;
        }

        .email-meta span {
            padding: 2px 6px;
            border-radius: 4px;
            background: #f3f4f6;
            white-space: nowrap;
        }

        .email-note {
            font-size: 10px;
            color: #888;
            font-style: italic;
            margin-top: 2px;
        }

        .btn-note {
            padding: 3px 6px;
            background: #8b5cf6;
            border: none;
            border-radius: 4px;
            color: white;
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            height: 24px;
        }

        .btn-note:hover {
            background: #7c3aed;
        }

        .badge {
            display: inline-flex;
            align-items: center;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
        }

        .badge-joined {
            background: #10b981;
            color: white;
        }

        .badge-pending {
            background: #fbbf24;
            color: white;
        }

        .btn-invite {
            padding: 3px 8px;
            background: #3b82f6;
            border: none;
            border-radius: 4px;
            color: white;
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            height: 24px;
        }

        .btn-invite:hover {
            background: #2563eb;
        }

        .btn-invite.disabled {
            background: #ccc;
            cursor: not-allowed;
        }

        .btn-remove {
            padding: 3px 8px;
            background: #f59e0b;
            border: none;
            border-radius: 4px;
            color: white;
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            height: 24px;
        }

        .btn-remove:hover {
            background: #d97706;
        }

        .btn-remove.disabled {
            background: #ccc;
            cursor: not-allowed;
        }

        .btn-oauth {
            padding: 3px 8px;
            background: #8b5cf6;
            border: none;
            border-radius: 4px;
            color: white;
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            height: 24px;
        }

        .btn-oauth:hover {
            background: #7c3aed;
        }

        .btn-delete {
            padding: 4px 10px;
            background: #ef4444;
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-delete:hover {
            background: #dc2626;
        }

        .btn-copy {
            padding: 6px 12px;
            background: #10b981;
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-right: 4px;
        }

        .btn-copy:hover {
            background: #059669;
        }

        .email-actions {
            display: flex;
            gap: 4px;
        }

        .btn-sync {
            width: 100%;
            padding: 8px;
            background: #667eea;
            border: none;
            border-radius: 8px;
            color: white;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-sync:hover {
            background: #5568d3;
        }

        .btn-fill {
            width: 100%;
            padding: 10px;
            background: #10b981;
            border: none;
            border-radius: 8px;
            color: white;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-bottom: 12px;
        }

        .btn-fill:hover {
            background: #059669;
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: #999;
        }

        .empty-icon {
            font-size: 48px;
            margin-bottom: 12px;
        }

        .loading-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(255, 255, 255, 0.9);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 10;
            border-radius: 8px;
        }

        .loading-spinner {
            width: 40px;
            height: 40px;
            border: 4px solid #e0e0e0;
            border-top-color: #667eea;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .loading-text {
            margin-top: 12px;
            color: #666;
            font-size: 14px;
        }

        /* 自定义弹框 */
        .custom-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000000;
            animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .modal-content {
            background: white;
            border-radius: 16px;
            padding: 24px;
            min-width: 320px;
            max-width: 400px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            animation: slideUp 0.3s ease;
        }

        @keyframes slideUp {
            from {
                transform: translateY(20px);
                opacity: 0;
            }
            to {
                transform: translateY(0);
                opacity: 1;
            }
        }

        .modal-title {
            font-size: 18px;
            font-weight: 700;
            color: #333;
            margin-bottom: 12px;
        }

        .modal-message {
            font-size: 14px;
            color: #666;
            line-height: 1.6;
            margin-bottom: 20px;
            white-space: pre-wrap;
        }

        .modal-buttons {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }

        .modal-btn {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .modal-btn-cancel {
            background: #e0e0e0;
            color: #666;
        }

        .modal-btn-cancel:hover {
            background: #d0d0d0;
        }

        .modal-btn-confirm {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .modal-btn-confirm:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .modal-btn-ok {
            background: #10b981;
            color: white;
        }

        .modal-btn-ok:hover {
            background: #059669;
        }

        .modal-btn-warning {
            background: #ffc107;
            color: #000;
        }

        .modal-btn-warning:hover {
            background: #ffb300;
        }
    `);

    // 自定义弹框组件
    class CustomModal {
        // 确认对话框
        static confirm(title, message) {
            return new Promise((resolve) => {
                const modal = document.createElement('div');
                modal.className = 'custom-modal';
                modal.innerHTML = `
                    <div class="modal-content">
                        <div class="modal-title">${title}</div>
                        <div class="modal-message">${message}</div>
                        <div class="modal-buttons">
                            <button class="modal-btn modal-btn-cancel" id="modal-cancel">取消</button>
                            <button class="modal-btn modal-btn-confirm" id="modal-confirm">确定</button>
                        </div>
                    </div>
                `;

                document.body.appendChild(modal);

                const handleConfirm = () => {
                    modal.remove();
                    resolve(true);
                };

                const handleCancel = () => {
                    modal.remove();
                    resolve(false);
                };

                modal.querySelector('#modal-confirm').addEventListener('click', handleConfirm);
                modal.querySelector('#modal-cancel').addEventListener('click', handleCancel);
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) handleCancel();
                });
            });
        }

        // 警告对话框
        static alert(title, message, type = 'warning') {
            return new Promise((resolve) => {
                const modal = document.createElement('div');
                modal.className = 'custom-modal';
                const btnClass = type === 'warning' ? 'modal-btn-warning' : 'modal-btn-ok';
                modal.innerHTML = `
                    <div class="modal-content">
                        <div class="modal-title">${title}</div>
                        <div class="modal-message">${message}</div>
                        <div class="modal-buttons">
                            <button class="modal-btn ${btnClass}" id="modal-ok">确定</button>
                        </div>
                    </div>
                `;

                document.body.appendChild(modal);

                const handleOk = () => {
                    modal.remove();
                    resolve();
                };

                modal.querySelector('#modal-ok').addEventListener('click', handleOk);
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) handleOk();
                });
            });
        }
    }

    // 数据管理
    class AccountManager {
        constructor() {
            this.storageKey = 'chatgpt_accounts';
            this.accounts = this.load();
        }

        load() {
            try {
                return JSON.parse(GM_getValue(this.storageKey, '[]'));
            } catch (e) {
                return [];
            }
        }

        save() {
            GM_setValue(this.storageKey, JSON.stringify(this.accounts));
        }

        // 获取今日日期字符串 YYYY-MM-DD
        getTodayKey() {
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        }

        // 获取今日已使用的 ChatGPT 席位数（基于 lastGptSeatAt）
        getTodayChatGPTUsage() {
            try {
                const todayKey = this.getTodayKey();
                return this.accounts.filter(account => {
                    if (!account.lastGptSeatAt) return false;
                    const lastDate = new Date(account.lastGptSeatAt);
                    const dateKey = `${lastDate.getFullYear()}-${String(lastDate.getMonth() + 1).padStart(2, '0')}-${String(lastDate.getDate()).padStart(2, '0')}`;
                    return dateKey === todayKey;
                }).length;
            } catch (e) {
                return 0;
            }
        }

        add(email) {
            email = email.trim().toLowerCase();
            if (!this.validate(email)) {
                return { success: false, message: '邮箱格式不正确' };
            }
            if (this.accounts.some(a => a.email === email)) {
                return { success: false, message: '邮箱已存在' };
            }
            this.accounts.push({
                email: email,
                addedAt: new Date().toISOString(),
                joinedAt: null,
                status: 'pending',
                seatType: null,
                lastGptSeatAt: null,
                role: null,
                note: '',
                codexTokens: null  // { access_token, refresh_token, id_token, authorized_at, status: 'authorized'|'expired', quota: { hourly_percentage, weekly_percentage, hourly_reset_time, weekly_reset_time }, quota_updated_at }
            });
            this.save();
            return { success: true };
        }

        // 批量添加邮箱
        addBatch(emailsText) {
            const emails = emailsText
                .split(/[\n,;，；]+/)  // 支持换行、逗号、分号分隔
                .map(e => e.trim().toLowerCase())
                .filter(e => e);  // 过滤空字符串

            const results = {
                success: [],
                failed: [],
                duplicate: []
            };

            emails.forEach(email => {
                if (!this.validate(email)) {
                    results.failed.push(email);
                } else if (this.accounts.some(a => a.email === email)) {
                    results.duplicate.push(email);
                } else {
                    this.accounts.push({
                        email: email,
                        addedAt: new Date().toISOString(),
                        joinedAt: null,
                        status: 'pending',
                        seatType: null,
                        lastGptSeatAt: null,
                        role: null,
                        note: ''
                    });
                    results.success.push(email);
                }
            });

            this.save();
            return results;
        }

        remove(email) {
            this.accounts = this.accounts.filter(a => a.email !== email);
            this.save();
        }

        // 批量删除
        removeBatch(emails) {
            this.accounts = this.accounts.filter(a => !emails.includes(a.email));
            this.save();
        }

        update(email, updates) {
            const account = this.accounts.find(a => a.email === email);
            if (account) {
                Object.assign(account, updates);
                this.save();
            }
        }

        // 更新备注
        updateNote(email, note) {
            this.update(email, { note: note });
        }

        validate(email) {
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        }

        getAll() {
            return this.accounts;
        }

        getStats() {
            const total = this.accounts.length;
            const joined = this.accounts.filter(a => a.status === 'joined').length;
            // 修复：检查席位类型是否包含 ChatGPT
            const chatgptSeats = this.accounts.filter(a =>
                    a.seatType && (
                        a.seatType === 'ChatGPT' ||
                        a.seatType.includes('ChatGPT') ||
                        a.seatType === 'chatgpt'
                    )
            ).length;
            const todayUsed = this.getTodayChatGPTUsage();
            return { total, joined, pending: total - joined, chatgptSeats, todayUsed };
        }
    }

    // 页面扫描
    class PageScanner {
        scanMembers() {
            const members = new Map();
            const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

            // 扫描所有 title 属性
            document.querySelectorAll('[title*="@"]').forEach(el => {
                const title = el.getAttribute('title');
                const matches = title?.match(emailRegex);
                if (matches) {
                    matches.forEach(email => {
                        const row = el.closest('tr');
                        if (row) {
                            // 查找席位类型
                            let seatType = null;
                            let role = null;

                            const cells = row.querySelectorAll('td');
                            cells.forEach((cell, index) => {
                                const text = cell.textContent.trim();

                                // 查找角色列（通常包含 "所有者"/"Owner"/"成员"/"Member"）
                                if (text === '所有者' || text === 'Owner') {
                                    role = '所有者';
                                } else if (text === '成员' || text === 'Member') {
                                    role = '成员';
                                }

                                // 查找席位类型
                                if (text === 'ChatGPT' || text === 'ChatGPT Plus' ||
                                    text.includes('ChatGPT') || text === 'API' ||
                                    text === 'chatgpt' || text.toLowerCase().includes('chatgpt')) {
                                    seatType = text;
                                }
                            });

                            // 如果没找到席位，尝试从按钮查找
                            if (!seatType) {
                                const buttons = row.querySelectorAll('button');
                                buttons.forEach(btn => {
                                    const text = btn.textContent.trim();
                                    if (text === 'ChatGPT' || text === 'ChatGPT Plus' ||
                                        text.includes('ChatGPT') || text === 'API' ||
                                        text === 'chatgpt' || text.toLowerCase().includes('chatgpt')) {
                                        seatType = text;
                                    }
                                });
                            }

                            members.set(email.toLowerCase(), { seatType, role });
                        }
                    });
                }
            });

            return members;
        }
    }

    function decodeJwtPayloadStandalone(token) {
        if (!token) return null;
        const parts = token.split('.');
        if (parts.length < 2) return null;
        try {
            const payload = parts[1];
            const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
            const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
            return JSON.parse(decoded);
        } catch {
            return null;
        }
    }

    function resolveAuthPayloadFromTokens(tokens) {
        const p = decodeJwtPayloadStandalone(tokens.id_token);
        return (p && typeof p['https://api.openai.com/auth'] === 'object')
            ? p['https://api.openai.com/auth']
            : null;
    }

    function resolveAccountIdFromAccount(account) {
        const auth = resolveAuthPayloadFromTokens(account.codexTokens);
        return (auth && (auth.chatgpt_account_id || auth.account_id)) || null;
    }

    function resolveUserIdFromAccount(account) {
        const idPayload = decodeJwtPayloadStandalone(account.codexTokens.id_token);
        const auth = resolveAuthPayloadFromTokens(account.codexTokens);
        return (auth && (auth.chatgpt_user_id || auth.user_id)) || (idPayload && idPayload.sub) || null;
    }

    function resolveOrganizationIdFromAccount(account) {
        const auth = resolveAuthPayloadFromTokens(account.codexTokens);
        return (auth && auth.organization_id) || null;
    }

    function resolvePlanTypeFromAccount(account) {
        const auth = resolveAuthPayloadFromTokens(account.codexTokens);
        return (auth && auth.chatgpt_plan_type) || null;
    }

    function resolveAccessTokenExpiryFromAccount(account) {
        const accessPayload = decodeJwtPayloadStandalone(account.codexTokens.access_token);
        const idPayload = decodeJwtPayloadStandalone(account.codexTokens.id_token);
        const exp = (accessPayload && accessPayload.exp) || (idPayload && idPayload.exp);
        if (!exp) return '';
        return new Date(exp * 1000).toISOString();
    }

    function resolveSubscriptionExpiresAtFromAccount(account) {
        const auth = resolveAuthPayloadFromTokens(account.codexTokens);
        if (!auth) return undefined;
        const raw = auth.chatgpt_subscription_active_until;
        if (raw == null || !isFinite(raw)) return undefined;
        const millis = raw > 1e12 ? raw : raw * 1000;
        const d = new Date(millis);
        if (isNaN(d.getTime())) return undefined;
        return d.toISOString();
    }

    function toPortableTokenStorage(account) {
        return {
            id_token: account.codexTokens.id_token || '',
            access_token: account.codexTokens.access_token || '',
            refresh_token: account.codexTokens.refresh_token || '',
            account_id: resolveAccountIdFromAccount(account) || '',
            last_refresh: account.codexTokens.authorized_at || new Date().toISOString(),
            email: account.email || '',
            type: 'codex',
            expired: resolveAccessTokenExpiryFromAccount(account) || '',
        };
    }

    function formatExportData(accounts, format) {
        if (format === 'cockpit_tools') {
            return JSON.stringify(accounts.map(toPortableTokenStorage), null, 2);
        }

        if (format === 'sub2api') {
            const payload = {
                exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                proxies: [],
                accounts: accounts.map(account => {
                    const credentials = { access_token: account.codexTokens.access_token };
                    const expiresAt = resolveAccessTokenExpiryFromAccount(account);
                    if (expiresAt) credentials.expires_at = expiresAt;
                    if (account.codexTokens.refresh_token) credentials.refresh_token = account.codexTokens.refresh_token;
                    if (account.codexTokens.id_token) credentials.id_token = account.codexTokens.id_token;
                    if (account.email) credentials.email = account.email;
                    const accountId = resolveAccountIdFromAccount(account);
                    if (accountId) credentials.chatgpt_account_id = accountId;
                    const userId = resolveUserIdFromAccount(account);
                    if (userId) credentials.chatgpt_user_id = userId;
                    const orgId = resolveOrganizationIdFromAccount(account);
                    if (orgId) credentials.organization_id = orgId;
                    const planType = resolvePlanTypeFromAccount(account);
                    if (planType) credentials.plan_type = planType;
                    const subExpires = resolveSubscriptionExpiresAtFromAccount(account);
                    if (subExpires) credentials.subscription_expires_at = subExpires;
                    return {
                        name: account.email,
                        platform: 'openai',
                        type: 'oauth',
                        credentials,
                        concurrency: 0,
                        priority: 0,
                    };
                }),
                type: 'sub2api-data',
                version: 1,
            };
            return JSON.stringify(payload, null, 2);
        }

        // cpa format
        const result = accounts.map(toPortableTokenStorage);
        return JSON.stringify(result.length === 1 ? result[0] : result, null, 2);
    }

    function getExportFileName(format) {
        const date = new Date().toISOString().slice(0, 10);
        const base = `codex-tokens-${date}`;
        if (format === 'cockpit_tools') return `${base}.json`;
        return `${base}_${format}.json`;
    }

    // UI 管理
    class PanelUI {
        constructor(manager, scanner) {
            this.manager = manager;
            this.scanner = scanner;
            this.panel = null;
            this.isCollapsed = false;
            this.dragState = { isDragging: false, startX: 0, startY: 0, initialX: 0, initialY: 0 };
            this.copiedEmails = new Set(); // 记录已复制的邮箱
            this.hasSynced = false; // 是否已同步过
            this.searchKeyword = ''; // 搜索关键词
            this.selectedEmails = new Set(); // 批量选中的邮箱
            this.lastSyncTime = 0; // 上次同步时间
            this.lastQuotaCheckTime = 0; // 上次额度检查时间
            this.init();
        }

        init() {
            this.createPanel();
            this.bindEvents();
            this.render();
            this.startAutoSync();
            this.watchUrlChange(); // 监听 URL 变化
        }

        watchUrlChange() {
            // 监听 URL 变化（SPA 应用）
            let lastPath = window.location.pathname;
            setInterval(() => {
                const currentPath = window.location.pathname;
                if (currentPath !== lastPath) {
                    lastPath = currentPath;
                    const isMembersPage = currentPath.includes('/admin/members');
                    if (this.panel) {
                        this.panel.style.display = isMembersPage ? 'block' : 'none';
                    }
                }
            }, 500);
        }

        createPanel() {
            this.panel = document.createElement('div');
            this.panel.id = 'account-panel';

            // 根据当前页面决定是否显示
            const isMembersPage = window.location.pathname.includes('/admin/members');
            this.panel.style.display = isMembersPage ? 'block' : 'none';

            this.panel.innerHTML = `
                <div class="panel-header">
                    <div class="panel-title">GPTeam v5.3.1</div>
                    <button class="panel-toggle" id="toggle-btn">−</button>
                </div>
                <div class="panel-body">
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-value" id="stat-total">0</div>
                            <div class="stat-label">总邮箱</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value" id="stat-chatgpt">0</div>
                            <div class="stat-label">ChatGPT 席位</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value" id="stat-today">0</div>
                            <div class="stat-label">今日已用</div>
                        </div>
                    </div>

                    <div class="search-box">
                        <input type="text" class="search-input" id="search-input" placeholder="🔍 搜索邮箱或备注...">
                    </div>
                    <div class="batch-actions">
                        <button class="btn-batch" id="add-btn" style="background: #10b981;">添加</button>
                        <button class="btn-batch" id="refresh-quota-btn">刷新额度</button>
                        <button class="btn-batch" id="export-tokens-btn">导出Token</button>
                        <button class="btn-batch" id="batch-delete-btn">删除选中</button>
                    </div>
                    <div style="position: relative;">
                        <div class="email-list" id="email-list"></div>
                        <div class="loading-overlay" id="loading-overlay" style="display: none;">
                            <div class="loading-spinner"></div>
                            <div class="loading-text">正在同步...</div>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(this.panel);
        }

        bindEvents() {
            // 折叠
            document.getElementById('toggle-btn').addEventListener('click', () => {
                this.isCollapsed = !this.isCollapsed;
                this.panel.classList.toggle('collapsed');
                document.getElementById('toggle-btn').textContent = this.isCollapsed ? '+' : '−';
            });

            // 添加邮箱（弹出自定义对话框）
            document.getElementById('add-btn').addEventListener('click', () => this.showAddEmailDialog());

            // 搜索
            document.getElementById('search-input').addEventListener('input', (e) => {
                this.searchKeyword = e.target.value.toLowerCase();
                this.render();
            });

            // 刷新额度
            document.getElementById('refresh-quota-btn').addEventListener('click', () => {
                this.refreshAllQuotas();
            });

            // 导出Token
            document.getElementById('export-tokens-btn').addEventListener('click', () => {
                this.exportTokens();
            });

            // 批量删除
            document.getElementById('batch-delete-btn').addEventListener('click', () => this.handleBatchDelete());

            // 拖拽
            const header = this.panel.querySelector('.panel-header');
            header.addEventListener('mousedown', (e) => this.startDrag(e));
            document.addEventListener('mousemove', (e) => this.onDrag(e));
            document.addEventListener('mouseup', () => this.endDrag());
        }

        // 显示添加邮箱对话框
        async showAddEmailDialog() {
            const emailsText = await this.showCustomPrompt(
                '➕ 添加邮箱',
                '输入一个或多个邮箱地址\n支持多行或逗号分隔',
                '',
                true  // 使用多行textarea
            );

            if (!emailsText || !emailsText.trim()) {
                return;
            }

            // 检测是否为批量添加
            if (emailsText.includes('\n') || emailsText.includes(',') || emailsText.includes('，') || emailsText.includes(';') || emailsText.includes('；')) {
                // 批量添加
                const results = this.manager.addBatch(emailsText);

                let message = '';
                if (results.success.length > 0) {
                    message += `✓ 成功添加 ${results.success.length} 个邮箱\n`;
                }
                if (results.duplicate.length > 0) {
                    message += `⚠ ${results.duplicate.length} 个邮箱已存在\n`;
                }
                if (results.failed.length > 0) {
                    message += `✗ ${results.failed.length} 个邮箱格式错误\n`;
                }

                if (results.success.length > 0) {
                    this.render();
                }

                if (message) {
                    this.showCustomAlert('批量添加结果', message.trim(), results.failed.length > 0 ? 'warning' : 'success');
                }
            } else {
                // 单个添加
                const result = this.manager.add(emailsText.trim());
                if (result.success) {
                    this.render();
                    this.showCustomAlert('添加成功', `已添加邮箱：${emailsText.trim()}`, 'success');
                } else {
                    this.showCustomAlert('添加失败', result.message, 'warning');
                }
            }
        }

        handleBatchDelete() {
            if (this.selectedEmails.size === 0) {
                CustomModal.alert('批量删除', '请先选择要删除的邮箱', 'warning');
                return;
            }

            // 检查选中的账户中是否有已授权的
            const selectedAccounts = this.manager.getAll().filter(a => this.selectedEmails.has(a.email));
            const authorizedAccounts = selectedAccounts.filter(a =>
                a.codexTokens &&
                a.codexTokens.access_token &&
                a.codexTokens.status === 'authorized'
            );

            let message = `确定要删除选中的 ${this.selectedEmails.size} 个邮箱吗？`;

            if (authorizedAccounts.length > 0) {
                message = `⚠️ 警告：选中的账户中有 ${authorizedAccounts.length} 个已授权账户！\n\n删除后将丢失以下已授权的 Token：\n${authorizedAccounts.map(a => `  • ${a.email}`).join('\n')}\n\n确定要删除选中的 ${this.selectedEmails.size} 个邮箱吗？`;
            }

            CustomModal.confirm('批量删除', message).then(confirmed => {
                if (confirmed) {
                    this.manager.removeBatch([...this.selectedEmails]);
                    this.selectedEmails.clear();
                    this.render();
                }
            });
        }

        handleNote(email, currentNote) {
            const note = prompt('输入备注：', currentNote || '');
            if (note !== null) {
                this.manager.updateNote(email, note.trim());
                this.render();
            }
        }

        handleRemove(email) {
            CustomModal.confirm('移出成员', `确定要从团队移出 ${email} 吗？`).then(confirmed => {
                if (confirmed) {
                    this.clickMenuAndRemoveByEmail(email);
                }
            });
        }

        handleInvite(email) {
            // 检查 ChatGPT 席位数
            const stats = this.manager.getStats();
            if (stats.chatgptSeats >= 2) {
                // 席位数 >= 2，弹窗警告并确认
                CustomModal.confirm('⚠️ 席位警告', `当前已有 ${stats.chatgptSeats} 个 ChatGPT 席位，确定要邀请 ${email} 吗？`).then(confirmed => {
                    if (confirmed) {
                        // 先复制邮箱
                        this.handleCopy(email).then(() => {
                            this.clickInviteButton(email);
                        });
                    }
                });
            } else {
                // 席位数 < 2，直接邀请，不需要确认
                // 先复制邮箱
                this.handleCopy(email).then(() => {
                    this.clickInviteButton(email);
                });
            }
        }

        async clickInviteButton(email) {
            const inviteBtn = await this.waitForElement(() =>
                Array.from(document.querySelectorAll('button'))
                    .find(btn => {
                        const text = btn.textContent.trim();
                        return text === '邀请成员' || text === 'Invite member';
                    })
            );

            if (!inviteBtn) {
                CustomModal.alert('邀请失败', '页面上未找到"邀请成员"按钮', 'warning');
                return;
            }

            inviteBtn.click();

            const emailInput = await this.waitForElement(() =>
                document.querySelector('input#email[type="email"]')
            );

            if (!emailInput) {
                CustomModal.alert('邀请失败', '未找到邮箱输入框', 'warning');
                return;
            }

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(emailInput, email);
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            emailInput.dispatchEvent(new Event('change', { bubbles: true }));

            const sendBtn = await this.waitForElement(() =>
                Array.from(document.querySelectorAll('button'))
                    .filter(btn => !btn.closest('#account-panel'))
                    .find(btn => {
                        const text = btn.textContent.trim();
                        return text === '发送邀请' || text === 'Send invite' || text.includes('发送') || text.includes('Send');
                    })
            );

            if (sendBtn) {
                sendBtn.click();

                const dialogGone = await this.waitUntilGone(() =>
                        document.querySelector('input#email[type="email"]')
                    , 20, 1000);

                if (!dialogGone) {
                    CustomModal.alert('邀请超时', '邀请弹窗未关闭，请手动确认邀请结果后再授权', 'warning');
                    return;
                }

                this.syncStatus();
                await this.sleep(1000);
                this.handleOAuth(email);
            }
        }

        async clickMenuAndRemoveByEmail(email) {
            const emailCell = await this.waitForElement(() =>
                Array.from(document.querySelectorAll('*'))
                    .find(el => el.textContent.trim() === email)
            );

            if (!emailCell) {
                CustomModal.alert('移除失败', '页面上未找到该邮箱，请确保在用户tab', 'warning');
                return;
            }

            const row = emailCell.closest('tr') || emailCell.closest('.member-row');
            if (!row) {
                CustomModal.alert('移除失败', '未找到邮箱所在行', 'warning');
                return;
            }

            const button = await this.waitForElement(() => {
                let btn = row.querySelector('button[aria-haspopup="menu"]');
                if (!btn) btn = row.querySelector('.ellipsis, .more-options, button');
                return btn;
            });

            if (!button) {
                CustomModal.alert('移除失败', '未找到菜单按钮', 'warning');
                return;
            }

            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            ['pointerdown','mousedown','mouseup','click'].forEach(type => {
                button.dispatchEvent(new MouseEvent(type, {
                    bubbles: true, cancelable: true, view: win
                }));
            });

            const removeBtn = await this.waitForElement(() => {
                const menu = document.querySelector('div[role="menu"], div[aria-expanded="true"], body > div:nth-of-type(6) div');
                if (!menu) return null;
                const item = Array.from(menu.querySelectorAll('div[role="menuitem"], button, div'))
                    .find(el => {
                        const text = el.textContent.trim();
                        return text === '移除成员' || text === 'Remove member';
                    });
                if (!item) return null;
                if (item.getAttribute('role') === 'group') {
                    return item.querySelector('div[role="menuitem"]') || item;
                }
                return item;
            }, 4, 500);

            if (!removeBtn) {
                CustomModal.alert('移除失败', '未能找到移除按钮，操作超时', 'warning');
                return;
            }

            removeBtn.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, view: win
            }));

            const confirmBtn = await this.waitForElement(() =>
                Array.from(document.querySelectorAll('button.btn-danger, button'))
                    .filter(btn => !btn.closest('#account-panel'))
                    .find(btn => {
                        const text = btn.textContent.trim();
                        return text === '删除' || text === 'Delete' || text === '移除' || text === 'Remove';
                    })
            );

            if (confirmBtn) {
                confirmBtn.click();
                await this.sleep(1000);
                this.syncStatus();
            }
        }

        async handleCopy(email) {
            // 先同步状态
            this.syncStatus();
            await this.sleep(500);

            // 复制邮箱到剪贴板
            try {
                await navigator.clipboard.writeText(email);

                // 保存最后复制的邮箱（跨页面共享）
                GM_setValue('last_copied_email', email);

                // 标记为已复制
                this.copiedEmails.add(email);

                // 立即更新按钮显示
                this.render();

            } catch (err) {
                // 备用方案：使用旧方法
                const textarea = document.createElement('textarea');
                textarea.value = email;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);

                // 保存最后复制的邮箱
                GM_setValue('last_copied_email', email);

                // 标记为已复制
                this.copiedEmails.add(email);

                // 立即更新按钮显示
                this.render();
            }
        }

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        async waitForElement(finder, retries = 2, interval = 800) {
            for (let i = 0; i <= retries; i++) {
                const el = finder();
                if (el) return el;
                if (i < retries) await this.sleep(interval);
            }
            return null;
        }

        async waitUntilGone(finder, retries = 10, interval = 1000) {
            for (let i = 0; i < retries; i++) {
                await this.sleep(interval);
                const el = finder();
                if (!el) return true;
            }
            return false;
        }

        fillInviteInput() {
            const pending = this.manager.getAll().filter(a => a.status === 'pending');
            if (pending.length === 0) {
                alert('没有待加入的邮箱');
                return;
            }

            // 查找邀请输入框
            const inviteInput = document.querySelector('input#email[type="email"]') ||
                document.querySelector('input[aria-label="电子邮件"]') ||
                document.querySelector('input[placeholder*="电子邮件"]') ||
                document.querySelector('input[placeholder*="email" i]');

            if (!inviteInput) {
                alert('未找到邀请输入框\n\n请先打开"邀请成员"弹框');
                return;
            }

            // 填充第一个待加入的邮箱
            const email = pending[0].email;
            inviteInput.value = email;
            inviteInput.focus();

            // 触发 input 事件
            inviteInput.dispatchEvent(new Event('input', { bubbles: true }));
            inviteInput.dispatchEvent(new Event('change', { bubbles: true }));

            alert(`已填充邮箱：${email}\n\n请点击"发送邀请"按钮`);
        }

        async handleOAuth(email) {
            try {
                console.log('开始为邮箱授权:', email);

                // 显示自定义确认弹窗
                const confirmed = await this.showCustomConfirm(
                    '即将为以下邮箱进行 OAuth 授权',
                    `邮箱：${email}\n\n` +
                    `授权完成后，插件会自动监听 localhost:1455 回调并交换 Token。\n` +
                    `无需手动复制粘贴回调 URL。`
                );

                if (!confirmed) {
                    return;
                }

                // 保持油猴版体验：授权前复制邮箱，并让 auth.openai.com 页面标记对应账号行。
                await this.handleCopy(email);

                const codexOAuth = new CodexOAuthManager();

                // 生成PKCE参数
                const codeVerifier = codexOAuth.generateRandomString();
                const state = codexOAuth.generateRandomString();
                const codeChallenge = await codexOAuth.generateCodeChallenge(codeVerifier);

                // 保存会话
                GM_setValue('codex_oauth_session', JSON.stringify({
                    email: email,
                    codeVerifier: codeVerifier,
                    state: state,
                    timestamp: Date.now()
                }));

                // 构建授权URL
                const params = new URLSearchParams({
                    response_type: 'code',
                    client_id: codexOAuth.CLIENT_ID,
                    redirect_uri: codexOAuth.REDIRECT_URI,
                    scope: codexOAuth.SCOPES,
                    code_challenge: codeChallenge,
                    code_challenge_method: 'S256',
                    state: state,
                    id_token_add_organizations: 'true',
                    codex_cli_simplified_flow: 'true',
                    originator: 'codex_vscode'
                });

                const authUrl = `${codexOAuth.AUTH_ENDPOINT}?${params.toString()}`;

                const loadingOverlay = this.showLoading('等待授权完成...');
                let result;
                try {
                    result = await new Promise((resolve, reject) => {
                        const timeoutId = setTimeout(() => {
                            chrome.runtime.onMessage.removeListener(listener);
                            reject(new Error('授权等待超时，请重新授权'));
                        }, 5 * 60 * 1000);

                        const listener = (message) => {
                            if (!message || message.type !== 'gpteam_oauth_result') return;
                            if (message.state !== state) return;

                            clearTimeout(timeoutId);
                            chrome.runtime.onMessage.removeListener(listener);

                            if (!message.ok) {
                                reject(new Error(message.error || '授权失败'));
                                return;
                            }
                            resolve(message.result);
                        };

                        chrome.runtime.onMessage.addListener(listener);
                        chrome.runtime.sendMessage({
                            type: 'gpteam_start_oauth',
                            session: { email, codeVerifier, state, timestamp: Date.now() },
                            authUrl
                        }).catch((error) => {
                            clearTimeout(timeoutId);
                            chrome.runtime.onMessage.removeListener(listener);
                            reject(error);
                        });
                    });
                } finally {
                    if (loadingOverlay && loadingOverlay.parentNode) {
                        document.body.removeChild(loadingOverlay);
                    }
                }

                this.manager.update(email, {
                    codexTokens: {
                        access_token: result.tokens.access_token,
                        refresh_token: result.tokens.refresh_token,
                        id_token: result.tokens.id_token,
                        authorized_at: result.tokens.authorized_at,
                        status: 'authorized',
                        quota: null,
                        quota_updated_at: null
                    }
                });

                console.log('授权成功:', email);

                const exportFormat = [{
                    email: email,
                    account_id: null,
                    user_id: null,
                    organization_id: null,
                    tokens: {
                        id_token: result.tokens.id_token,
                        access_token: result.tokens.access_token,
                        refresh_token: result.tokens.refresh_token
                    },
                    authorized_at: result.tokens.authorized_at,
                    status: 'authorized',
                    quota: null,
                    quota_updated_at: null,
                    note: '',
                    exported_at: new Date().toISOString()
                }];

                if (ENABLE_UPLOAD) {
                    this.uploadTokenToCockpit(exportFormat)
                        .then(() => {
                            console.log('[Cockpit] Token已上传到Cockpit');
                        })
                        .catch(err => {
                            console.warn('[Cockpit] 上传Token到Cockpit失败，但不影响授权:', err.message);
                        });
                }

                this.showCustomAlert('授权成功', `邮箱：${email}\n\n点击确定后将刷新页面以识别新成员`, 'success', () => {
                    window.location.reload();
                });
                this.render();
                this.refreshSingleQuota(email);

            } catch (error) {
                console.error('OAuth 错误:', error);
                this.showCustomAlert(`OAuth 错误：\n\n${error.message}`, 'error');
            }
        }

        // 自定义确认弹窗
        showCustomConfirm(title, message) {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; z-index: 9999999;';

                const dialog = document.createElement('div');
                dialog.style.cssText = 'background: white; padding: 30px; border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); max-width: 500px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;';

                dialog.innerHTML = `
                    <div style="font-size: 20px; font-weight: 600; margin-bottom: 15px; color: #1f2937;">${title}</div>
                    <div style="font-size: 14px; color: #6b7280; line-height: 1.6; white-space: pre-wrap; margin-bottom: 25px;">${message}</div>
                    <div style="display: flex; gap: 10px; justify-content: flex-end;">
                        <button id="cancel-btn" style="padding: 10px 20px; border: 1px solid #d1d5db; background: white; color: #6b7280; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer;">取消</button>
                        <button id="confirm-btn" style="padding: 10px 20px; border: none; background: #8b5cf6; color: white; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer;">确定</button>
                    </div>
                `;

                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                const confirmBtn = dialog.querySelector('#confirm-btn');
                const cancelBtn = dialog.querySelector('#cancel-btn');

                confirmBtn.onclick = () => {
                    document.body.removeChild(overlay);
                    resolve(true);
                };

                cancelBtn.onclick = () => {
                    document.body.removeChild(overlay);
                    resolve(false);
                };
            });
        }

        // 自定义输入框（支持单行或多行）
        showCustomPrompt(title, message, defaultValue = '', multiline = false) {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; z-index: 9999999;';

                const dialog = document.createElement('div');
                dialog.style.cssText = 'background: white; padding: 30px; border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); max-width: 600px; width: 90%; font-family: -apple-system, BlinkMacSystemFont, sans-serif;';

                // 根据multiline决定使用input还是textarea
                const inputHtml = multiline
                    ? `<textarea id="prompt-input" rows="8" style="width: 100%; padding: 12px; border: 2px solid #e5e7eb; border-radius: 8px; font-size: 14px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin-bottom: 20px; box-sizing: border-box; color: #1f2937; background: #f9fafb; resize: vertical;" placeholder="输入邮箱地址，支持多行或逗号分隔">${defaultValue}</textarea>`
                    : `<input type="text" id="prompt-input" value="${defaultValue}" style="width: 100%; padding: 12px; border: 2px solid #e5e7eb; border-radius: 8px; font-size: 14px; font-family: monospace; margin-bottom: 20px; box-sizing: border-box; color: #1f2937; background: #f9fafb;" placeholder="http://localhost:1455/auth/callback?code=..." />`;

                dialog.innerHTML = `
                    <div style="font-size: 20px; font-weight: 600; margin-bottom: 15px; color: #1f2937;">${title}</div>
                    <div style="font-size: 14px; color: #6b7280; line-height: 1.6; white-space: pre-wrap; margin-bottom: 20px;">${message}</div>
                    ${inputHtml}
                    <div style="display: flex; gap: 10px; justify-content: flex-end;">
                        <button id="cancel-btn" style="padding: 10px 20px; border: 1px solid #d1d5db; background: white; color: #6b7280; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer;">取消</button>
                        <button id="ok-btn" style="padding: 10px 20px; border: none; background: #8b5cf6; color: white; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer;">确定</button>
                    </div>
                `;

                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                const input = dialog.querySelector('#prompt-input');
                const okBtn = dialog.querySelector('#ok-btn');
                const cancelBtn = dialog.querySelector('#cancel-btn');

                input.focus();
                if (!multiline) {
                    input.select();
                }

                const submit = () => {
                    const value = input.value.trim();
                    document.body.removeChild(overlay);
                    resolve(value || null);
                };

                okBtn.onclick = submit;
                cancelBtn.onclick = () => {
                    document.body.removeChild(overlay);
                    resolve(null);
                };

                // 只对单行input绑定Enter提交
                if (!multiline) {
                    input.onkeydown = (e) => {
                        if (e.key === 'Enter') {
                            submit();
                        } else if (e.key === 'Escape') {
                            document.body.removeChild(overlay);
                            resolve(null);
                        }
                    };
                } else {
                    input.onkeydown = (e) => {
                        if (e.key === 'Escape') {
                            document.body.removeChild(overlay);
                            resolve(null);
                        }
                    };
                }
            });
        }

        // 自定义提示框（支持标题）
        showCustomAlert(title, message, type = 'info', onClose = null) {
            // 兼容旧调用方式：如果title包含换行或长度较长，且message是type类型，则交换参数
            if (typeof message === 'string' && ['success', 'error', 'info', 'warning'].includes(message) && title.length > 50) {
                [title, message, type] = ['提示', title, message];
            }

            const colors = {
                success: { bg: '#10b981', icon: '✅' },
                error: { bg: '#ef4444', icon: '❌' },
                warning: { bg: '#f59e0b', icon: '⚠️' },
                info: { bg: '#3b82f6', icon: 'ℹ️' }
            };

            const config = colors[type] || colors.info;

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; z-index: 9999999;';

            const dialog = document.createElement('div');
            dialog.style.cssText = 'background: white; padding: 30px; border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); max-width: 600px; text-align: center; font-family: -apple-system, BlinkMacSystemFont, sans-serif;';

            dialog.innerHTML = `
                <div style="font-size: 64px; margin-bottom: 20px;">${config.icon}</div>
                <div style="font-size: 20px; font-weight: 600; color: #1f2937; margin-bottom: 15px;">${title}</div>
                <div style="font-size: 14px; color: #4b5563; line-height: 1.8; white-space: pre-wrap; margin-bottom: 25px; text-align: left; max-height: 400px; overflow-y: auto;">${message}</div>
                <button id="close-btn" style="padding: 10px 30px; border: none; background: ${config.bg}; color: white; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer;">确定</button>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const closeBtn = dialog.querySelector('#close-btn');
            closeBtn.onclick = () => {
                document.body.removeChild(overlay);
                if (onClose) onClose();
            };
        }

        // 显示加载遮罩
        showLoading(message) {
            const overlay = document.createElement('div');
            overlay.id = 'oauth-loading';
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 9999999;';

            overlay.innerHTML = `
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 60px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); text-align: center; color: white; font-family: -apple-system, BlinkMacSystemFont, sans-serif;">
                    <div style="font-size: 64px; margin-bottom: 20px; animation: spin 2s linear infinite;">🔐</div>
                    <div style="font-size: 24px; font-weight: 600;">${message}</div>
                </div>
                <style>
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                </style>
            `;

            document.body.appendChild(overlay);
            return overlay;
        }

        // 上传 Token 到 Cockpit API
        uploadTokenToCockpit(tokenData) {
            return new Promise((resolve, reject) => {
                const cockpitApiUrl = 'http://localhost:19315/v1/cockpit/import-token';

                // tokenData 应该是导出的完整JSON格式数组
                const dataToSend = Array.isArray(tokenData) ? tokenData : [tokenData];

                console.log('[Cockpit] 开始上传 Token，数据量:', dataToSend.length);

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: cockpitApiUrl,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    data: JSON.stringify(dataToSend),
                    timeout: 30000,  // 30秒超时
                    onload: (response) => {
                        if (response.status === 200 || response.status === 201) {
                            console.log('[Cockpit] Token上传成功:', response.responseText);
                            resolve(response.responseText);
                        } else {
                            console.error('[Cockpit] Token上传失败:', response.status, response.responseText);
                            reject(new Error(`HTTP ${response.status}: ${response.responseText}`));
                        }
                    },
                    onerror: (error) => {
                        console.error('[Cockpit] Token上传网络错误:', error);
                        reject(new Error(`网络请求失败: ${error.error || 'Unknown error'}`));
                    },
                    ontimeout: () => {
                        console.error('[Cockpit] Token上传超时');
                        reject(new Error('请求超时，请检查 Cockpit 服务是否正常运行'));
                    }
                });
            });
        }

        syncStatus() {
            // 检查当前 URL 是否是 members 页面
            if (!window.location.pathname.includes('/admin/members')) {
                return;
            }

            const pageMembers = this.scanner.scanMembers();

            // 检查是否在"用户"tab：获取到列表 且 列表中包含所有者
            const hasOwner = Array.from(pageMembers.values()).some(info => info.role === '所有者');
            const isUserTab = pageMembers.size > 0 && hasOwner;

            if (!isUserTab) {
                return;
            }

            // 记录本次同步时间
            this.lastSyncTime = Date.now();

            const accounts = this.manager.getAll();
            let hasChanges = false;

            // 1. 先将页面上的成员自动添加到列表
            pageMembers.forEach((memberInfo, email) => {
                const exists = accounts.find(a => a.email === email);
                if (!exists) {
                    // 自动添加页面上的成员
                    const isChatGPTSeat = memberInfo.seatType && (
                        memberInfo.seatType === 'ChatGPT' ||
                        memberInfo.seatType.includes('ChatGPT') ||
                        memberInfo.seatType === 'chatgpt'
                    );
                    this.manager.accounts.push({
                        email: email,
                        addedAt: new Date().toISOString(),
                        joinedAt: new Date().toISOString(),
                        status: 'joined',
                        seatType: memberInfo.seatType,
                        lastGptSeatAt: isChatGPTSeat ? new Date().toISOString() : null,
                        role: memberInfo.role,
                        note: '',
                        codexTokens: null
                    });
                    hasChanges = true;
                }
            });

            // 保存一次
            this.manager.save();

            // 2. 更新现有账户的状态
            const updatedAccounts = this.manager.getAll();
            updatedAccounts.forEach(account => {
                const pageMember = pageMembers.get(account.email);
                if (pageMember) {
                    // 已在团队中
                    const isChatGPTSeat = pageMember.seatType && (
                        pageMember.seatType === 'ChatGPT' ||
                        pageMember.seatType.includes('ChatGPT') ||
                        pageMember.seatType === 'chatgpt'
                    );

                    if (account.status !== 'joined') {
                        this.manager.update(account.email, {
                            status: 'joined',
                            joinedAt: new Date().toISOString(),
                            seatType: pageMember.seatType,
                            role: pageMember.role,
                            lastGptSeatAt: isChatGPTSeat ? new Date().toISOString() : account.lastGptSeatAt
                        });
                        hasChanges = true;
                    } else {
                        // 更新席位类型和角色
                        const updates = {};
                        if (account.seatType !== pageMember.seatType) {
                            updates.seatType = pageMember.seatType;
                            hasChanges = true;
                        }
                        if (account.role !== pageMember.role) {
                            updates.role = pageMember.role;
                            hasChanges = true;
                        }
                        // 如果是 ChatGPT 席位，更新最后时间
                        if (isChatGPTSeat) {
                            updates.lastGptSeatAt = new Date().toISOString();
                        }
                        if (Object.keys(updates).length > 0) {
                            this.manager.update(account.email, updates);
                        }
                    }
                } else {
                    // 不在团队中（已移除）
                    if (account.status === 'joined') {
                        this.manager.update(account.email, {
                            status: 'pending',
                            joinedAt: null,
                            seatType: null
                        });
                        hasChanges = true;
                    }
                }
            });

            // 3. 清空已复制标记
            this.copiedEmails.clear();

            // 4. 只有获取到至少一个账户才标记为已同步
            const finalAccounts = this.manager.getAll();
            if (finalAccounts.length > 0) {
                this.hasSynced = true;
                const loadingOverlay = document.getElementById('loading-overlay');
                if (loadingOverlay) {
                    loadingOverlay.style.display = 'none';
                }
            }

            // 5. 如果有变化，完全重新渲染；否则只更新现有元素
            if (hasChanges) {
                this.render();
            } else {
                this.updateExistingElements();
            }
        }

        // 增量更新：只更新现有元素的内容，不重建DOM
        updateExistingElements() {
            const accounts = this.manager.getAll();
            const stats = this.manager.getStats();
            const listEl = document.getElementById('email-list');

            // 更新统计
            document.getElementById('stat-total').textContent = stats.total;
            document.getElementById('stat-chatgpt').textContent = stats.chatgptSeats;
            document.getElementById('stat-today').textContent = stats.todayUsed;

            // 过滤搜索
            let filteredAccounts = accounts;
            if (this.searchKeyword) {
                filteredAccounts = accounts.filter(a =>
                    a.email.includes(this.searchKeyword) ||
                    (a.note && a.note.toLowerCase().includes(this.searchKeyword))
                );
            }

            // 排序
            const sortedAccounts = [...filteredAccounts].sort((a, b) => {
                if (a.status === 'joined' && b.status !== 'joined') return -1;
                if (a.status !== 'joined' && b.status === 'joined') return 1;
                return 0;
            });

            // 获取当前DOM中的邮箱列表
            const existingItems = listEl.querySelectorAll('.email-item');
            const existingEmails = new Set();
            existingItems.forEach(item => {
                const email = item.getAttribute('data-email');
                if (email) existingEmails.add(email);
            });

            // 获取新账户列表的邮箱
            const newEmails = new Set(sortedAccounts.map(a => a.email));

            // 如果邮箱列表发生变化，完全重新渲染
            if (existingEmails.size !== newEmails.size ||
                ![...existingEmails].every(email => newEmails.has(email))) {
                this.render();
                return;
            }

            // 否则，只更新每个元素的内容
            sortedAccounts.forEach(account => {
                const item = listEl.querySelector(`.email-item[data-email="${account.email}"]`);
                if (!item) return;

                const quotaDisplay = this.getQuotaDisplayForAccount(account);
                const hasToken = account.codexTokens && account.codexTokens.access_token;
                const tokenStatus = hasToken ? account.codexTokens.status : null;
                const isSelected = this.selectedEmails.has(account.email);

                // 更新选中状态
                const checkbox = item.querySelector('.email-checkbox');
                if (checkbox) {
                    checkbox.checked = isSelected;
                }
                item.classList.toggle('selected', isSelected);

                // 更新额度显示
                const quotaLine = item.querySelector('.email-quota-line');
                if (quotaLine) {
                    if (quotaDisplay) {
                        quotaLine.innerHTML = `
                            ${quotaDisplay.hourly ? `<span style="color: ${quotaDisplay.hourly.color};">${quotaDisplay.hourly.text}${quotaDisplay.hourly.resetText}</span>` : ''}
                            ${quotaDisplay.weekly ? `<span style="color: ${quotaDisplay.weekly.color};">${quotaDisplay.weekly.text}${quotaDisplay.weekly.resetText}</span>` : ''}
                        `;
                    } else {
                        quotaLine.innerHTML = '';
                    }
                }

                // 更新token状态
                const metaLine = item.querySelector('.email-meta-line');
                if (metaLine) {
                    const statusSpans = [];
                    if (account.seatType) {
                        statusSpans.push(`<span>席位: ${account.seatType}</span>`);
                    }
                    if (hasToken && tokenStatus === 'authorized') {
                        statusSpans.push(`<span style="color: #10b981;">✓ 已授权</span>`);
                    }
                    if (hasToken && tokenStatus === 'expired') {
                        statusSpans.push(`<span style="color: #ef4444;">✗ 已失效</span>`);
                    }
                    const isRecentlyRemoved = account.status !== 'joined' && account.lastGptSeatAt &&
                        (Date.now() - new Date(account.lastGptSeatAt).getTime()) < 10 * 60 * 1000;
                    if (isRecentlyRemoved) {
                        statusSpans.push(`<span style="color: #f59e0b; background: #fef3c7;">刚移出</span>`);
                    }
                    metaLine.innerHTML = statusSpans.join('');
                }
            });
        }

        // 提取获取额度显示的逻辑为独立方法
        getQuotaDisplayForAccount(account) {
            if (!account.codexTokens || !account.codexTokens.access_token) {
                return null;
            }

            const tokens = account.codexTokens;
            const now = Math.floor(Date.now() / 1000);

            // 如果已失效，对每个窗口独立判断是否已过重置时间
            if (tokens.status === 'expired' && tokens.quota) {
                const hourlyReset = tokens.quota.hourly_reset_time || 0;
                const weeklyReset = tokens.quota.weekly_reset_time || 0;

                const hourlyHasReset = now > hourlyReset;
                const weeklyHasReset = now > weeklyReset;

                const hourlyPct = hourlyHasReset ? 100 : (tokens.quota.hourly_percentage || 0);
                const weeklyPct = weeklyHasReset ? 100 : (tokens.quota.weekly_percentage || 0);

                return {
                    hourly: {
                        text: `5h: ${Math.round(hourlyPct)}%`,
                        color: getQuotaColor(hourlyPct),
                        resetText: hourlyHasReset ? ' (已重置)' : getResetText(hourlyReset)
                    },
                    weekly: {
                        text: `周: ${Math.round(weeklyPct)}%`,
                        color: getQuotaColor(weeklyPct),
                        resetText: weeklyHasReset ? ' (已重置)' : getResetText(weeklyReset)
                    },
                    status: 'expired'
                };
            }

            // 显示实际额度（已授权）
            if (tokens.quota) {
                const hourlyPct = tokens.quota.hourly_percentage || 0;
                const weeklyPct = tokens.quota.weekly_percentage || 0;
                const hourlyReset = tokens.quota.hourly_reset_time || 0;
                const weeklyReset = tokens.quota.weekly_reset_time || 0;

                return {
                    hourly: {
                        text: `5h: ${Math.round(hourlyPct)}%`,
                        color: getQuotaColor(hourlyPct),
                        resetText: getResetText(hourlyReset)
                    },
                    weekly: {
                        text: `周: ${Math.round(weeklyPct)}%`,
                        color: getQuotaColor(weeklyPct),
                        resetText: getResetText(weeklyReset)
                    },
                    status: tokens.status
                };
            }

            return null;
        }

        // 刷新单个账户的额度
        async refreshSingleQuota(email) {
            const account = this.manager.getAll().find(a => a.email === email);
            if (!account || !account.codexTokens || !account.codexTokens.access_token) {
                console.log('[Quota] 账户无Token，跳过:', email);
                return;
            }

            // 如果已过期，不刷新
            if (account.codexTokens.status === 'expired') {
                console.log('[Quota] Token已过期，跳过刷新:', email);
                return;
            }

            console.log('[Quota] 刷新额度:', email);
            const codexOAuth = new CodexOAuthManager();

            try {
                const quota = await codexOAuth.fetchQuota(account.codexTokens.access_token);

                // 更新额度信息
                this.manager.update(email, {
                    codexTokens: {
                        ...account.codexTokens,
                        quota: quota,
                        quota_updated_at: new Date().toISOString(),
                        status: 'authorized'
                    }
                });

                this.updateExistingElements();

            } catch (error) {
                console.error('[Quota] 额度刷新失败:', email, error);

                // 如果是401/403，标记为过期
                if (error.status === 401 || error.status === 403 || error.error === 'token_expired') {
                    this.manager.update(email, {
                        codexTokens: {
                            ...account.codexTokens,
                            status: 'expired',
                            quota_updated_at: new Date().toISOString()
                        }
                    });
                    this.updateExistingElements();
                }
            }
        }

        // 刷新所有有Token的账户额度
        async refreshAllQuotas() {
            const accounts = this.manager.getAll().filter(a =>
                a.codexTokens &&
                a.codexTokens.access_token
            );

            if (accounts.length === 0) {
                return;
            }

            // 显示刷新中状态
            const refreshBtn = document.getElementById('refresh-quota-btn');
            if (refreshBtn) {
                refreshBtn.textContent = '刷新中...';
                refreshBtn.disabled = true;
            }

            // 并发刷新所有账户
            const promises = accounts.map(account => this.refreshSingleQuota(account.email));
            await Promise.all(promises);

            // 恢复按钮状态
            if (refreshBtn) {
                refreshBtn.textContent = '刷新额度';
                refreshBtn.disabled = false;
            }
        }

        // 导出Token（支持三种格式：cockpit_tools / sub2api / cpa）
        async exportTokens() {
            const accounts = this.manager.getAll().filter(a =>
                this.selectedEmails.has(a.email) &&
                a.codexTokens &&
                a.codexTokens.access_token
            );

            if (accounts.length === 0) {
                this.showCustomAlert('没有选中的账户或选中账户无Token', 'info');
                return;
            }

            const choice = await this.showExportChoiceDialog(accounts.length);

            if (!choice) return;

            if (choice === 'upload') {
                // 上传到 Cockpit
                try {
                    const exportData = accounts.map(a => ({
                        email: a.email,
                        account_id: resolveAccountIdFromAccount(a) || null,
                        user_id: resolveUserIdFromAccount(a) || null,
                        organization_id: resolveOrganizationIdFromAccount(a) || null,
                        tokens: {
                            id_token: a.codexTokens.id_token,
                            access_token: a.codexTokens.access_token,
                            refresh_token: a.codexTokens.refresh_token
                        },
                        authorized_at: a.codexTokens.authorized_at,
                        status: a.codexTokens.status || 'authorized',
                        quota: a.codexTokens.quota || null,
                        quota_updated_at: a.codexTokens.quota_updated_at || null,
                        note: a.note || '',
                        exported_at: new Date().toISOString()
                    }));
                    await this.uploadTokenToCockpit(exportData);
                    this.showCustomAlert('上传成功', `已将 ${accounts.length} 个账户的Token上传到Cockpit！`, 'success');
                } catch (error) {
                    this.showCustomAlert('上传失败', error.message, 'error');
                }
                return;
            }

            const { action, format } = choice;
            const jsonStr = formatExportData(accounts, format);
            const formatLabels = { cockpit_tools: 'Cockpit Tools', sub2api: 'sub2api', cpa: 'cpa' };
            const formatLabel = formatLabels[format] || format;

            if (action === 'copy') {
                try {
                    await navigator.clipboard.writeText(jsonStr);
                    this.showCustomAlert('复制成功', `已将 ${accounts.length} 个账户以 ${formatLabel} 格式复制到剪贴板！`, 'success');
                } catch (err) {
                    const textarea = document.createElement('textarea');
                    textarea.value = jsonStr;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                    this.showCustomAlert('复制成功', `已将 ${accounts.length} 个账户以 ${formatLabel} 格式复制到剪贴板！`, 'success');
                }
            } else if (action === 'download') {
                const blob = new Blob([jsonStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);

                const a = document.createElement('a');
                a.href = url;
                a.download = getExportFileName(format);
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                this.showCustomAlert('下载成功', `已以 ${formatLabel} 格式下载 ${accounts.length} 个账户！`, 'success');
            }
        }

        // 显示导出选择对话框：选择格式 + 导出方式（复制/下载）
        showExportChoiceDialog(count) {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.className = 'custom-modal';

                const dialog = document.createElement('div');
                dialog.className = 'modal-content';

                dialog.innerHTML = `
                    <div class="modal-title">导出 Token</div>
                    <div class="modal-message">已选中 ${count} 个账户</div>
                    <div style="margin-bottom: 16px;">
                        <div style="font-size: 13px; font-weight: 600; color: #333; margin-bottom: 8px;">导出格式</div>
                        <div style="display: flex; gap: 8px;">
                            <label style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 2px solid #667eea; border-radius: 8px; cursor: pointer; background: #eef2ff; font-size: 12px; font-weight: 600; color: #333;">
                                <input type="radio" name="export-format" value="cockpit_tools" checked style="accent-color: #667eea;"> Cockpit
                            </label>
                            <label style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 2px solid #e0e0e0; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 600; color: #333;">
                                <input type="radio" name="export-format" value="sub2api" style="accent-color: #667eea;"> sub2api
                            </label>
                            <label style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 2px solid #e0e0e0; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 600; color: #333;">
                                <input type="radio" name="export-format" value="cpa" style="accent-color: #667eea;"> cpa
                            </label>
                        </div>
                    </div>
                    <div style="font-size: 13px; font-weight: 600; color: #333; margin-bottom: 8px;">导出方式</div>
                    <div class="modal-buttons" style="display: flex; gap: 10px; justify-content: center;">
                        <button class="modal-btn" id="copy-btn" style="background: #10b981; color: white; flex: 1;">复制</button>
                        <button class="modal-btn" id="download-btn" style="background: #3b82f6; color: white; flex: 1;">下载</button>
                        ${ENABLE_UPLOAD ? '<button class="modal-btn" id="upload-btn" style="background: #8b5cf6; color: white; flex: 1;">上传</button>' : ''}
                    </div>
                    <div class="modal-buttons" style="margin-top: 10px;">
                        <button class="modal-btn modal-btn-cancel" id="cancel-btn" style="width: 100%;">取消</button>
                    </div>
                `;

                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                const radios = dialog.querySelectorAll('input[name="export-format"]');
                const labels = dialog.querySelectorAll('label');

                radios.forEach(radio => {
                    radio.addEventListener('change', () => {
                        labels.forEach(label => {
                            const r = label.querySelector('input[type="radio"]');
                            label.style.borderColor = r.checked ? '#667eea' : '#e0e0e0';
                            label.style.background = r.checked ? '#eef2ff' : 'transparent';
                        });
                    });
                });

                const getSelectedFormat = () => {
                    const checked = dialog.querySelector('input[name="export-format"]:checked');
                    return checked ? checked.value : 'cockpit_tools';
                };

                const copyBtn = dialog.querySelector('#copy-btn');
                const downloadBtn = dialog.querySelector('#download-btn');
                const cancelBtn = dialog.querySelector('#cancel-btn');

                const cleanup = () => {
                    document.body.removeChild(overlay);
                };

                copyBtn.onclick = () => {
                    const format = getSelectedFormat();
                    cleanup();
                    resolve({ action: 'copy', format });
                };

                downloadBtn.onclick = () => {
                    const format = getSelectedFormat();
                    cleanup();
                    resolve({ action: 'download', format });
                };

                if (ENABLE_UPLOAD) {
                    const uploadBtn = dialog.querySelector('#upload-btn');
                    uploadBtn.onclick = () => {
                        cleanup();
                        resolve('upload');
                    };
                }

                cancelBtn.onclick = () => {
                    cleanup();
                    resolve(null);
                };

                overlay.onclick = (e) => {
                    if (e.target === overlay) {
                        cleanup();
                        resolve(null);
                    }
                };
            });
        }

        render() {
            const accounts = this.manager.getAll();
            const stats = this.manager.getStats();
            const listEl = document.getElementById('email-list');
            const loadingOverlay = document.getElementById('loading-overlay');

            // 更新统计
            document.getElementById('stat-total').textContent = stats.total;
            document.getElementById('stat-chatgpt').textContent = stats.chatgptSeats;
            document.getElementById('stat-today').textContent = stats.todayUsed;

            // 如果还没同步过，显示 loading
            if (!this.hasSynced) {
                if (loadingOverlay) {
                    loadingOverlay.style.display = 'flex';
                }
                listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div>等待同步...</div></div>';
                return;
            }

            // 隐藏 loading
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
            }

            // 过滤搜索
            let filteredAccounts = accounts;
            if (this.searchKeyword) {
                filteredAccounts = accounts.filter(a =>
                    a.email.includes(this.searchKeyword) ||
                    (a.note && a.note.toLowerCase().includes(this.searchKeyword))
                );
            }

            // 渲染列表
            if (filteredAccounts.length === 0) {
                listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div>' + (this.searchKeyword ? '无匹配结果' : '暂无邮箱') + '</div></div>';
                return;
            }

            // 排序：已加入的排在前面
            const sortedAccounts = [...filteredAccounts].sort((a, b) => {
                if (a.status === 'joined' && b.status !== 'joined') return -1;
                if (a.status !== 'joined' && b.status === 'joined') return 1;
                return 0;
            });

            // 获取额度显示信息
            const getQuotaDisplay = (account) => {
                if (!account.codexTokens || !account.codexTokens.access_token) {
                    return null;
                }

                const tokens = account.codexTokens;
                const now = Math.floor(Date.now() / 1000);

                // 如果已失效，对每个窗口独立判断是否已过重置时间
                if (tokens.status === 'expired' && tokens.quota) {
                    const hourlyReset = tokens.quota.hourly_reset_time || 0;
                    const weeklyReset = tokens.quota.weekly_reset_time || 0;

                    const hourlyHasReset = now > hourlyReset;
                    const weeklyHasReset = now > weeklyReset;

                    const hourlyPct = hourlyHasReset ? 100 : (tokens.quota.hourly_percentage || 0);
                    const weeklyPct = weeklyHasReset ? 100 : (tokens.quota.weekly_percentage || 0);

                    return {
                        hourly: {
                            text: `5h: ${Math.round(hourlyPct)}%`,
                            color: getQuotaColor(hourlyPct),
                            resetText: hourlyHasReset ? ' (已重置)' : getResetText(hourlyReset)
                        },
                        weekly: {
                            text: `周: ${Math.round(weeklyPct)}%`,
                            color: getQuotaColor(weeklyPct),
                            resetText: weeklyHasReset ? ' (已重置)' : getResetText(weeklyReset)
                        },
                        status: 'expired'
                    };
                }

                // 显示实际额度（已授权）
                if (tokens.quota) {
                    const hourlyPct = tokens.quota.hourly_percentage || 0;
                    const weeklyPct = tokens.quota.weekly_percentage || 0;
                    const hourlyReset = tokens.quota.hourly_reset_time || 0;
                    const weeklyReset = tokens.quota.weekly_reset_time || 0;

                    return {
                        hourly: {
                            text: `5h: ${Math.round(hourlyPct)}%`,
                            color: getQuotaColor(hourlyPct),
                            resetText: getResetText(hourlyReset)
                        },
                        weekly: {
                            text: `周: ${Math.round(weeklyPct)}%`,
                            color: getQuotaColor(weeklyPct),
                            resetText: getResetText(weeklyReset)
                        },
                        status: tokens.status
                    };
                }

                return null;
            };

            listEl.innerHTML = sortedAccounts.map(account => {
                const isJoined = account.status === 'joined';
                const isCopied = this.copiedEmails.has(account.email);
                const isSelected = this.selectedEmails.has(account.email);
                const hasToken = account.codexTokens && account.codexTokens.access_token;
                const tokenStatus = hasToken ? account.codexTokens.status : null;
                const quotaDisplay = getQuotaDisplay(account);
                const isRecentlyRemoved = !isJoined && account.lastGptSeatAt &&
                    (Date.now() - new Date(account.lastGptSeatAt).getTime()) < 10 * 60 * 1000;

                // 检查是否可以移出（只有所有者不能移出）
                const isOwner = account.role === '所有者' || account.role === 'Owner';
                const canRemove = !isOwner;
                return `
                    <div class="email-item ${isJoined ? 'joined' : ''} ${isSelected ? 'selected' : ''}" data-email="${account.email}">
                        <input type="checkbox" class="email-checkbox" data-email="${account.email}" ${isSelected ? 'checked' : ''}>
                        <div class="email-info">
                            <div class="email-header">
                                <div class="email-text" data-email="${account.email}">${account.email}</div>
                                <div class="email-header-actions">
                                    <button class="btn-note" data-email="${account.email}" title="添加备注">📝</button>
                                    <button class="btn-oauth" data-email="${account.email}" style="background: #8b5cf6; color: white; padding: 3px 8px; border: none; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer; height: 24px;">授权</button>
                                    ${isJoined
                    ? (canRemove
                        ? `<button class="btn-remove" data-email="${account.email}">移出</button>`
                        : `<button class="btn-remove disabled" style="opacity: 0.5; cursor: not-allowed;" disabled>移出</button>`)
                    : `<button class="btn-invite" data-email="${account.email}">邀请</button>`}
                                </div>
                            </div>
                            ${account.note ? `<div class="email-note">📝 ${account.note}</div>` : ''}
                            <div class="email-content-row">
                                <div class="email-content-left">
                                    <div class="email-meta-line">
                                        ${account.seatType ? `<span>席位: ${account.seatType}</span>` : ''}
                                        ${hasToken && tokenStatus === 'authorized' ? `<span style="color: #10b981;">✓ 已授权</span>` : ''}
                                        ${hasToken && tokenStatus === 'expired' ? `<span style="color: #ef4444;">✗ 已失效</span>` : ''}
                                        ${isRecentlyRemoved ? `<span style="color: #f59e0b; background: #fef3c7;">刚移出</span>` : ''}
                                    </div>
                                    ${quotaDisplay ? `<div class="email-quota-line">
                                        ${quotaDisplay.hourly ? `<span style="color: ${quotaDisplay.hourly.color};">${quotaDisplay.hourly.text}${quotaDisplay.hourly.resetText}</span>` : ''}
                                        ${quotaDisplay.weekly ? `<span style="color: ${quotaDisplay.weekly.color};">${quotaDisplay.weekly.text}${quotaDisplay.weekly.resetText}</span>` : ''}
                                    </div>` : ''}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // 绑定复选框
            listEl.querySelectorAll('.email-checkbox').forEach(checkbox => {
                checkbox.addEventListener('change', (e) => {
                    const email = e.target.dataset.email;
                    if (e.target.checked) {
                        this.selectedEmails.add(email);
                    } else {
                        this.selectedEmails.delete(email);
                    }
                    this.render();
                });
            });

            // 绑定备注按钮
            listEl.querySelectorAll('.btn-note').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const email = e.target.dataset.email;
                    const account = this.manager.getAll().find(a => a.email === email);
                    this.handleNote(email, account ? account.note : '');
                });
            });

            // 绑定邮箱文本点击复制
            listEl.querySelectorAll('.email-text').forEach(el => {
                el.addEventListener('click', (e) => {
                    const email = e.target.dataset.email;
                    this.handleCopy(email);
                });
            });

            // 绑定移出按钮
            listEl.querySelectorAll('.btn-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const email = e.target.dataset.email;
                    this.handleRemove(email);
                });
            });

            // 绑定邀请按钮
            listEl.querySelectorAll('.btn-invite').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const email = e.target.dataset.email;
                    this.handleInvite(email);
                });
            });

            // 绑定授权按钮
            listEl.querySelectorAll('.btn-oauth').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const email = e.target.dataset.email;
                    this.handleOAuth(email);
                });
            });
        }

        startDrag(e) {
            if (e.target.closest('.panel-toggle')) return;
            this.dragState.isDragging = true;
            this.dragState.startX = e.clientX;
            this.dragState.startY = e.clientY;
            const rect = this.panel.getBoundingClientRect();
            this.dragState.initialX = rect.left;
            this.dragState.initialY = rect.top;
        }

        onDrag(e) {
            if (!this.dragState.isDragging) return;
            e.preventDefault();
            const deltaX = e.clientX - this.dragState.startX;
            const deltaY = e.clientY - this.dragState.startY;
            this.panel.style.left = (this.dragState.initialX + deltaX) + 'px';
            this.panel.style.top = (this.dragState.initialY + deltaY) + 'px';
            this.panel.style.right = 'auto';
        }

        endDrag() {
            this.dragState.isDragging = false;
        }

        startAutoSync() {
            const SYNC_INTERVAL = 5000; // 5秒
            const QUOTA_CHECK_INTERVAL = 30000; // 30秒

            // 初始同步
            setTimeout(() => this.syncStatus(), 2000);

            // 每 5 秒自动同步（仅在窗口可见时）
            setInterval(() => {
                if (!this.isCollapsed &&
                    window.location.pathname.includes('/admin/members') &&
                    !document.hidden) {
                    this.syncStatus();
                }
            }, SYNC_INTERVAL);

            // 每 30 秒检查是否需要刷新额度（仅在窗口可见时）
            setInterval(() => {
                if (!this.isCollapsed &&
                    window.location.pathname.includes('/admin/members') &&
                    !document.hidden) {
                    this.checkAndRefreshQuotas();
                }
            }, QUOTA_CHECK_INTERVAL);

            // 监听窗口可见性变化
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden &&
                    window.location.pathname.includes('/admin/members') &&
                    !this.isCollapsed) {
                    const now = Date.now();

                    // 检查距离上次同步是否超过间隔
                    if (now - this.lastSyncTime >= SYNC_INTERVAL) {
                        this.syncStatus();
                    }

                    // 检查距离上次额度检查是否超过间隔
                    if (now - this.lastQuotaCheckTime >= QUOTA_CHECK_INTERVAL) {
                        this.checkAndRefreshQuotas();
                    }
                }
            });
        }

        // 检查并刷新需要更新的额度
        checkAndRefreshQuotas() {
            this.lastQuotaCheckTime = Date.now();

            const accounts = this.manager.getAll().filter(a =>
                a.codexTokens &&
                a.codexTokens.access_token &&
                a.codexTokens.status === 'authorized'
            );

            accounts.forEach(account => {
                const lastUpdate = account.codexTokens.quota_updated_at
                    ? new Date(account.codexTokens.quota_updated_at).getTime()
                    : 0;
                const timeSinceUpdate = Date.now() - lastUpdate;
                const twoMinutes = 2 * 60 * 1000;

                // 如果距离上次更新超过2分钟，则刷新
                if (timeSinceUpdate > twoMinutes) {
                    this.refreshSingleQuota(account.email);
                }
            });
        }
    }

    // 初始化
    function init() {
        const manager = new AccountManager();
        const scanner = new PageScanner();
        const ui = new PanelUI(manager, scanner);
        console.log('ChatGPT Team 账户管理面板已加载');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 1000);
    }
})();
