let authToken = localStorage.getItem('authToken');
let oauthPort = null;
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs'
].join(' ');

function showToast(message, type = 'info', title = '') {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const titles = { success: '成功', error: '错误', warning: '警告', info: '提示' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div class="toast-icon">${icons[type]}</div>
        <div class="toast-content">
            <div class="toast-title">${title || titles[type]}</div>
            <div class="toast-message">${message}</div>
        </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showConfirm(message, title = '确认操作') {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-title">${title}</div>
                <div class="modal-message">${message}</div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove(); window.modalResolve(false)">取消</button>
                    <button class="btn btn-danger" onclick="this.closest('.modal').remove(); window.modalResolve(true)">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) { modal.remove(); resolve(false); } };
        window.modalResolve = resolve;
    });
}

function showLoading(text = '处理中...') {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'loadingOverlay';
    overlay.innerHTML = `<div class="spinner"></div><div class="loading-text">${text}</div>`;
    document.body.appendChild(overlay);
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.remove();
}

if (authToken) {
    showMainContent();
    loadTokens();
    loadConfig();
}

document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn.disabled) return;
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    btn.disabled = true;
    btn.classList.add('loading');
    const originalText = btn.textContent;
    btn.textContent = '登录中';
    
    try {
        const response = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (data.success) {
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
            showToast('登录成功，欢迎回来！', 'success');
            showMainContent();
            loadTokens();
        } else {
            showToast(data.message || '用户名或密码错误', 'error');
        }
    } catch (error) {
        showToast('登录失败: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = originalText;
    }
});

function showOAuthModal() {
    showToast('点击后请在新窗口完成授权', 'info', '提示');
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">🔐 OAuth授权登录</div>
            <div class="oauth-steps">
                <p><strong>📝 授权流程：</strong></p>
                <p>1️⃣ 点击下方按钮打开Google授权页面</p>
                <p>2️⃣ 完成授权后，复制浏览器地址栏的完整URL</p>
                <p>3️⃣ 粘贴URL到下方输入框并提交</p>
            </div>
            <button type="button" onclick="openOAuthWindow()" class="btn btn-success" style="width: 100%; margin-bottom: 16px;">🔐 打开授权页面</button>
            <input type="text" id="modalCallbackUrl" placeholder="粘贴完整的回调URL (http://localhost:xxxxx/oauth-callback?code=...)">
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="processOAuthCallbackModal()">✅ 提交</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

function showManualModal() {
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">✏️ 手动填入Token</div>
            <div class="form-row">
                <input type="text" id="modalAccessToken" placeholder="Access Token (必填)">
                <input type="text" id="modalRefreshToken" placeholder="Refresh Token (必填)">
                <input type="number" id="modalExpiresIn" placeholder="过期时间(秒)" value="3599">
            </div>
            <p style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 16px;">💡 提示：过期时间默认3599秒(约1小时)</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="addTokenFromModal()">✅ 添加</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

function openOAuthWindow() {
    oauthPort = Math.floor(Math.random() * 10000) + 50000;
    const redirectUri = `http://localhost:${oauthPort}/oauth-callback`;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `access_type=offline&client_id=${CLIENT_ID}&prompt=consent&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&` +
        `scope=${encodeURIComponent(SCOPES)}&state=${Date.now()}`;
    window.open(authUrl, '_blank');
}

async function processOAuthCallbackModal() {
    const modal = document.querySelector('.form-modal');
    const callbackUrl = document.getElementById('modalCallbackUrl').value.trim();
    if (!callbackUrl) {
        showToast('请输入回调URL', 'warning');
        return;
    }
    
    showLoading('正在处理授权...');
    
    try {
        const url = new URL(callbackUrl);
        const code = url.searchParams.get('code');
        const port = new URL(url.origin).port || (url.protocol === 'https:' ? 443 : 80);
        
        if (!code) {
            hideLoading();
            showToast('URL中未找到授权码，请检查URL是否完整', 'error');
            return;
        }
        
        const response = await fetch('/admin/oauth/exchange', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ code, port })
        });
        
        const result = await response.json();
        if (result.success) {
            const account = result.data;
            const addResponse = await fetch('/admin/tokens', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify(account)
            });
            
            const addResult = await addResponse.json();
            hideLoading();
            if (addResult.success) {
                modal.remove();
                showToast('Token添加成功！', 'success');
                loadTokens();
            } else {
                showToast('Token添加失败: ' + addResult.message, 'error');
            }
        } else {
            hideLoading();
            showToast('Token交换失败: ' + result.message, 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('处理失败: ' + error.message, 'error');
    }
}

async function addTokenFromModal() {
    const modal = document.querySelector('.form-modal');
    const accessToken = document.getElementById('modalAccessToken').value.trim();
    const refreshToken = document.getElementById('modalRefreshToken').value.trim();
    const expiresIn = parseInt(document.getElementById('modalExpiresIn').value);
    
    if (!accessToken || !refreshToken) {
        showToast('请填写完整的Token信息', 'warning');
        return;
    }
    
    showLoading('正在添加Token...');
    try {
        const response = await fetch('/admin/tokens', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn })
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            modal.remove();
            showToast('Token添加成功！', 'success');
            loadTokens();
        } else {
            showToast(data.message || '添加失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('添加失败: ' + error.message, 'error');
    }
}

function showMainContent() {
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('mainContent').classList.remove('hidden');
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    if (tab === 'tokens') {
        document.getElementById('tokensPage').classList.remove('hidden');
        document.getElementById('settingsPage').classList.add('hidden');
    } else if (tab === 'settings') {
        document.getElementById('tokensPage').classList.add('hidden');
        document.getElementById('settingsPage').classList.remove('hidden');
        loadConfig();
    }
}

async function logout() {
    const confirmed = await showConfirm('确定要退出登录吗？', '退出确认');
    if (!confirmed) return;
    
    localStorage.removeItem('authToken');
    authToken = null;
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('mainContent').classList.add('hidden');
    showToast('已退出登录', 'info');
}

async function loadTokens() {
    try {
        const response = await fetch('/admin/tokens', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.status === 401) {
            logout();
            return;
        }
        
        const data = await response.json();
        if (data.success) {
            renderTokens(data.data);
        } else {
            showToast('加载失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('加载Token失败: ' + error.message, 'error');
    }
}

function renderTokens(tokens) {
    document.getElementById('totalTokens').textContent = tokens.length;
    document.getElementById('enabledTokens').textContent = tokens.filter(t => t.enable).length;
    document.getElementById('disabledTokens').textContent = tokens.filter(t => !t.enable).length;
    
    const tokenList = document.getElementById('tokenList');
    if (tokens.length === 0) {
        tokenList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">暂无Token</div>
                <div class="empty-state-hint">点击上方按钮添加您的第一个Token</div>
            </div>
        `;
        return;
    }
    
    tokenList.innerHTML = tokens.map(token => `
        <div class="token-card">
            <div class="token-header">
                <span class="status ${token.enable ? 'enabled' : 'disabled'}">
                    ${token.enable ? '✅ 启用' : '❌ 禁用'}
                </span>
                <span class="token-id">#${token.refresh_token.substring(0, 8)}</span>
            </div>
            <div class="token-info">
                <div class="info-row">
                    <span class="info-label">🎫 Access</span>
                    <span class="info-value">${token.access_token_suffix}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">📦 Project</span>
                    <span class="info-value">${token.projectId || 'N/A'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">📧 邮箱</span>
                    <span class="info-value">${token.email || 'N/A'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">⏰ 过期</span>
                    <span class="info-value">${new Date(token.timestamp + token.expires_in * 1000).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})}</span>
                </div>
            </div>
            <div class="token-actions">
                <button class="btn btn-info" onclick="showQuotaModal('${token.refresh_token}')">📊 查看额度</button>
                <button class="btn ${token.enable ? 'btn-warning' : 'btn-success'}" onclick="toggleToken('${token.refresh_token}', ${!token.enable})">
                    ${token.enable ? '⏸️ 禁用' : '▶️ 启用'}
                </button>
                <button class="btn btn-danger" onclick="deleteToken('${token.refresh_token}')">🗑️ 删除</button>
            </div>
        </div>
    `).join('');
}

async function toggleToken(refreshToken, enable) {
    const action = enable ? '启用' : '禁用';
    const confirmed = await showConfirm(`确定要${action}这个Token吗？`, `${action}确认`);
    if (!confirmed) return;
    
    showLoading(`正在${action}Token...`);
    try {
        const response = await fetch(`/admin/tokens/${encodeURIComponent(refreshToken)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ enable })
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast(`Token已${enable ? '启用' : '禁用'}`, 'success');
            loadTokens();
        } else {
            showToast(data.message || '操作失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('操作失败: ' + error.message, 'error');
    }
}

async function deleteToken(refreshToken) {
    const confirmed = await showConfirm('删除后无法恢复，确定要删除这个Token吗？', '⚠️ 删除确认');
    if (!confirmed) return;
    
    showLoading('正在删除Token...');
    try {
        const response = await fetch(`/admin/tokens/${encodeURIComponent(refreshToken)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast('Token已删除', 'success');
            loadTokens();
        } else {
            showToast(data.message || '删除失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('删除失败: ' + error.message, 'error');
    }
}

async function showQuotaModal(refreshToken) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-title">📊 模型额度信息</div>
            <div id="quotaContent" style="max-height: 60vh; overflow-y: auto;">
                <div class="quota-loading">加载中...</div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-info" onclick="refreshQuotaData('${refreshToken}')">🔄 立即刷新</button>
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    await loadQuotaData(refreshToken);
}

async function loadQuotaData(refreshToken, forceRefresh = false) {
    const quotaContent = document.getElementById('quotaContent');
    if (!quotaContent) return;
    
    const refreshBtn = document.querySelector('.modal-content .btn-info');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ 加载中...';
    }
    
    quotaContent.innerHTML = '<div class="quota-loading">加载中...</div>';
    
    try {
        const url = `/admin/tokens/${encodeURIComponent(refreshToken)}/quotas${forceRefresh ? '?refresh=true' : ''}`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        
        if (data.success) {
            const quotaData = data.data;
            const models = quotaData.models;
            
            if (Object.keys(models).length === 0) {
                quotaContent.innerHTML = '<div class="quota-empty">暂无额度信息</div>';
                return;
            }
            
            const lastUpdated = new Date(quotaData.lastUpdated).toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
            
            // 按模型类型分组
            const grouped = { claude: [], gemini: [], other: [] };
            Object.entries(models).forEach(([modelId, quota]) => {
                const item = { modelId, quota };
                if (modelId.toLowerCase().includes('claude')) grouped.claude.push(item);
                else if (modelId.toLowerCase().includes('gemini')) grouped.gemini.push(item);
                else grouped.other.push(item);
            });
            
            let html = `<div class="quota-header">更新于 ${lastUpdated}</div>`;
            
            // 渲染各组
            if (grouped.claude.length > 0) {
                html += '<div class="quota-group-title">🤖 Claude 模型</div>';
                grouped.claude.forEach(({ modelId, quota }) => {
                    const percentage = (quota.remaining * 100).toFixed(1);
                    const barColor = percentage > 50 ? '#10b981' : percentage > 20 ? '#f59e0b' : '#ef4444';
                    html += `
                        <div class="quota-item">
                            <div class="quota-model-name">${modelId}</div>
                            <div class="quota-bar-container">
                                <div class="quota-bar" style="width: ${percentage}%; background: ${barColor};"></div>
                                <span class="quota-percentage">${percentage}%</span>
                            </div>
                            <div class="quota-reset">🔄 重置: ${quota.resetTime}</div>
                        </div>
                    `;
                });
            }
            
            if (grouped.gemini.length > 0) {
                html += '<div class="quota-group-title">💎 Gemini 模型</div>';
                grouped.gemini.forEach(({ modelId, quota }) => {
                    const percentage = (quota.remaining * 100).toFixed(1);
                    const barColor = percentage > 50 ? '#10b981' : percentage > 20 ? '#f59e0b' : '#ef4444';
                    html += `
                        <div class="quota-item">
                            <div class="quota-model-name">${modelId}</div>
                            <div class="quota-bar-container">
                                <div class="quota-bar" style="width: ${percentage}%; background: ${barColor};"></div>
                                <span class="quota-percentage">${percentage}%</span>
                            </div>
                            <div class="quota-reset">🔄 重置: ${quota.resetTime}</div>
                        </div>
                    `;
                });
            }
            
            if (grouped.other.length > 0) {
                html += '<div class="quota-group-title">🔧 其他模型</div>';
                grouped.other.forEach(({ modelId, quota }) => {
                    const percentage = (quota.remaining * 100).toFixed(1);
                    const barColor = percentage > 50 ? '#10b981' : percentage > 20 ? '#f59e0b' : '#ef4444';
                    html += `
                        <div class="quota-item">
                            <div class="quota-model-name">${modelId}</div>
                            <div class="quota-bar-container">
                                <div class="quota-bar" style="width: ${percentage}%; background: ${barColor};"></div>
                                <span class="quota-percentage">${percentage}%</span>
                            </div>
                            <div class="quota-reset">🔄 重置: ${quota.resetTime}</div>
                        </div>
                    `;
                });
            }
            
            quotaContent.innerHTML = html;
        } else {
            quotaContent.innerHTML = `<div class="quota-error">加载失败: ${data.message}</div>`;
        }
    } catch (error) {
        if (quotaContent) {
            quotaContent.innerHTML = `<div class="quota-error">加载失败: ${error.message}</div>`;
        }
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 立即刷新';
        }
    }
}

async function refreshQuotaData(refreshToken) {
    await loadQuotaData(refreshToken, true);
}

async function loadConfig() {
    try {
        const response = await fetch('/admin/config', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await response.json();
        if (data.success) {
            const form = document.getElementById('configForm');
            const { env, json } = data.data;
            
            // 加载 .env 配置
            Object.entries(env).forEach(([key, value]) => {
                const input = form.elements[key];
                if (input) input.value = value || '';
            });
            
            // 加载 config.json 配置
            if (json.server) {
                if (form.elements['PORT']) form.elements['PORT'].value = json.server.port || '';
                if (form.elements['HOST']) form.elements['HOST'].value = json.server.host || '';
                if (form.elements['MAX_REQUEST_SIZE']) form.elements['MAX_REQUEST_SIZE'].value = json.server.maxRequestSize || '';
            }
            if (json.defaults) {
                if (form.elements['DEFAULT_TEMPERATURE']) form.elements['DEFAULT_TEMPERATURE'].value = json.defaults.temperature ?? '';
                if (form.elements['DEFAULT_TOP_P']) form.elements['DEFAULT_TOP_P'].value = json.defaults.topP ?? '';
                if (form.elements['DEFAULT_TOP_K']) form.elements['DEFAULT_TOP_K'].value = json.defaults.topK ?? '';
                if (form.elements['DEFAULT_MAX_TOKENS']) form.elements['DEFAULT_MAX_TOKENS'].value = json.defaults.maxTokens ?? '';
            }
            if (json.other) {
                if (form.elements['TIMEOUT']) form.elements['TIMEOUT'].value = json.other.timeout ?? '';
                if (form.elements['MAX_IMAGES']) form.elements['MAX_IMAGES'].value = json.other.maxImages ?? '';
                if (form.elements['USE_NATIVE_AXIOS']) form.elements['USE_NATIVE_AXIOS'].value = json.other.useNativeAxios ? 'true' : 'false';
                if (form.elements['SKIP_PROJECT_ID_FETCH']) form.elements['SKIP_PROJECT_ID_FETCH'].value = json.other.skipProjectIdFetch ? 'true' : 'false';
            }
        }
    } catch (error) {
        showToast('加载配置失败: ' + error.message, 'error');
    }
}

document.getElementById('configForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const allConfig = Object.fromEntries(formData);
    
    // 分离敏感和非敏感配置
    const sensitiveKeys = ['API_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'JWT_SECRET', 'PROXY', 'SYSTEM_INSTRUCTION', 'IMAGE_BASE_URL'];
    const envConfig = {};
    const jsonConfig = {
        server: {},
        api: {},
        defaults: {},
        other: {}
    };
    
    Object.entries(allConfig).forEach(([key, value]) => {
        if (sensitiveKeys.includes(key)) {
            envConfig[key] = value;
        } else {
            // 映射到 config.json 结构
            if (key === 'PORT') jsonConfig.server.port = parseInt(value);
            else if (key === 'HOST') jsonConfig.server.host = value;
            else if (key === 'MAX_REQUEST_SIZE') jsonConfig.server.maxRequestSize = value;
            else if (key === 'API_URL') jsonConfig.api.url = value;
            else if (key === 'API_MODELS_URL') jsonConfig.api.modelsUrl = value;
            else if (key === 'API_NO_STREAM_URL') jsonConfig.api.noStreamUrl = value;
            else if (key === 'API_HOST') jsonConfig.api.host = value;
            else if (key === 'API_USER_AGENT') jsonConfig.api.userAgent = value;
            else if (key === 'DEFAULT_TEMPERATURE') jsonConfig.defaults.temperature = parseFloat(value);
            else if (key === 'DEFAULT_TOP_P') jsonConfig.defaults.topP = parseFloat(value);
            else if (key === 'DEFAULT_TOP_K') jsonConfig.defaults.topK = parseInt(value);
            else if (key === 'DEFAULT_MAX_TOKENS') jsonConfig.defaults.maxTokens = parseInt(value);
            else if (key === 'USE_NATIVE_AXIOS') jsonConfig.other.useNativeAxios = value !== 'false';
            else if (key === 'TIMEOUT') jsonConfig.other.timeout = parseInt(value);
            else if (key === 'MAX_IMAGES') jsonConfig.other.maxImages = parseInt(value);
            else if (key === 'SKIP_PROJECT_ID_FETCH') jsonConfig.other.skipProjectIdFetch = value === 'true';
            else envConfig[key] = value;
        }
    });
    
    showLoading('正在保存配置...');
    try {
        const response = await fetch('/admin/config', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ env: envConfig, json: jsonConfig })
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast(data.message, 'success');
        } else {
            showToast(data.message || '保存失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('保存失败: ' + error.message, 'error');
    }
});
