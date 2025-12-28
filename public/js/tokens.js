// Token管理：增删改查、启用禁用

let cachedTokens = [];
let currentFilter = localStorage.getItem('tokenFilter') || 'all'; // 'all', 'enabled', 'disabled'
let skipAnimation = false; // 是否跳过动画

// 初始化筛选状态
function initFilterState() {
    const savedFilter = localStorage.getItem('tokenFilter') || 'all';
    currentFilter = savedFilter;
    updateFilterButtonState(savedFilter);
}

// 更新筛选按钮状态
function updateFilterButtonState(filter) {
    document.querySelectorAll('.stat-item').forEach(item => {
        item.classList.remove('active');
    });
    const filterMap = { 'all': 'totalTokens', 'enabled': 'enabledTokens', 'disabled': 'disabledTokens' };
    const activeElement = document.getElementById(filterMap[filter]);
    if (activeElement) {
        activeElement.closest('.stat-item').classList.add('active');
    }
}

// 筛选 Token
function filterTokens(filter) {
    currentFilter = filter;
    localStorage.setItem('tokenFilter', filter); // 持久化筛选状态
    
    updateFilterButtonState(filter);
    
    // 重新渲染
    renderTokens(cachedTokens);
}

async function loadTokens() {
    try {
        const response = await authFetch('/admin/tokens', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
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

// 正在刷新的 Token 集合
const refreshingTokens = new Set();

function renderTokens(tokens) {
    // 只在首次加载时更新缓存
    if (tokens !== cachedTokens) {
        cachedTokens = tokens;
    }
    
    document.getElementById('totalTokens').textContent = tokens.length;
    document.getElementById('enabledTokens').textContent = tokens.filter(t => t.enable).length;
    document.getElementById('disabledTokens').textContent = tokens.filter(t => !t.enable).length;
    
    // 根据筛选条件过滤
    let filteredTokens = tokens;
    if (currentFilter === 'enabled') {
        filteredTokens = tokens.filter(t => t.enable);
    } else if (currentFilter === 'disabled') {
        filteredTokens = tokens.filter(t => !t.enable);
    }
    
    const tokenList = document.getElementById('tokenList');
    if (filteredTokens.length === 0) {
        const emptyText = currentFilter === 'all' ? '暂无Token' :
                          currentFilter === 'enabled' ? '暂无启用的Token' : '暂无禁用的Token';
        const emptyHint = currentFilter === 'all' ? '点击上方OAuth按钮添加Token' : '点击上方"总数"查看全部';
        tokenList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">${emptyText}</div>
                <div class="empty-state-hint">${emptyHint}</div>
            </div>
        `;
        return;
    }
    
    // 收集需要自动刷新的过期 Token
    const expiredTokensToRefresh = [];
    
    tokenList.innerHTML = filteredTokens.map((token, index) => {
        const expireTime = new Date(token.timestamp + token.expires_in * 1000);
        const isExpired = expireTime < new Date();
        const isRefreshing = refreshingTokens.has(token.refresh_token);
        const expireStr = expireTime.toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
        const cardId = token.refresh_token.substring(0, 8);
        
        // 计算在原始列表中的序号（基于添加顺序）
        const originalIndex = cachedTokens.findIndex(t => t.refresh_token === token.refresh_token);
        const tokenNumber = originalIndex + 1;
        
        // 如果已过期且启用状态，加入待刷新列表
        if (isExpired && token.enable && !isRefreshing) {
            expiredTokensToRefresh.push(token.refresh_token);
        }
        
        // 转义所有用户数据防止 XSS
        const safeRefreshToken = escapeJs(token.refresh_token);
        const safeAccessTokenSuffix = escapeHtml(token.access_token_suffix || '');
        const safeProjectId = escapeHtml(token.projectId || '');
        const safeEmail = escapeHtml(token.email || '');
        const safeProjectIdJs = escapeJs(token.projectId || '');
        const safeEmailJs = escapeJs(token.email || '');
        
        return `
        <div class="token-card ${!token.enable ? 'disabled' : ''} ${isExpired ? 'expired' : ''} ${isRefreshing ? 'refreshing' : ''} ${skipAnimation ? 'no-animation' : ''}" id="card-${escapeHtml(cardId)}">
            <div class="token-header">
                <span class="status ${token.enable ? 'enabled' : 'disabled'}" ${!token.enable && token.disableReason ? `title="禁用原因: ${escapeHtml(token.disableReason)}"` : ''}>
                    ${token.enable ? '✅ 启用' : `❌ ${escapeHtml(token.disableReason) || '已禁用'}`}
                </span>
                <div class="token-header-right">
                    <button class="btn-icon" onclick="showTokenDetail('${safeRefreshToken}')" title="编辑全部">✏️</button>
                    <span class="token-id">#${tokenNumber}</span>
                </div>
            </div>
            <div class="token-info">
                <div class="info-row sensitive-row">
                    <span class="info-label">🎫</span>
                    <span class="info-value sensitive-info" title="${safeAccessTokenSuffix}">${safeAccessTokenSuffix}</span>
                </div>
                <div class="info-row editable sensitive-row" onclick="editField(event, '${safeRefreshToken}', 'projectId', '${safeProjectIdJs}')" title="点击编辑">
                    <span class="info-label">📦</span>
                    <span class="info-value sensitive-info">${safeProjectId || '点击设置'}</span>
                    <span class="info-edit-icon">✏️</span>
                </div>
                <div class="info-row editable sensitive-row" onclick="editField(event, '${safeRefreshToken}', 'email', '${safeEmailJs}')" title="点击编辑">
                    <span class="info-label">📧</span>
                    <span class="info-value sensitive-info">${safeEmail || '点击设置'}</span>
                    <span class="info-edit-icon">✏️</span>
                </div>
                <div class="info-row ${isExpired ? 'expired-text' : ''}" id="expire-row-${escapeHtml(cardId)}">
                    <span class="info-label">⏰</span>
                    <span class="info-value">${isRefreshing ? '🔄 刷新中...' : escapeHtml(expireStr)}${isExpired && !isRefreshing ? ' (已过期)' : ''}</span>
                    <button class="btn-icon btn-refresh" onclick="manualRefreshToken('${safeRefreshToken}')" title="刷新Token" ${isRefreshing ? 'disabled' : ''}>🔄</button>
                </div>
            </div>
            <div class="token-quota-inline" id="quota-inline-${escapeHtml(cardId)}">
                <div class="quota-inline-header" onclick="toggleQuotaExpand('${escapeJs(cardId)}', '${safeRefreshToken}')">
                    <span class="quota-inline-summary" id="quota-summary-${escapeHtml(cardId)}">📊 加载中...</span>
                    <span class="quota-inline-toggle" id="quota-toggle-${escapeHtml(cardId)}">▼</span>
                </div>
                <div class="quota-inline-detail hidden" id="quota-detail-${escapeHtml(cardId)}"></div>
            </div>
            <div class="token-actions">
                <button class="btn btn-info btn-xs" onclick="showQuotaModal('${safeRefreshToken}')" title="查看额度">📊 详情</button>
                <button class="btn ${token.enable ? 'btn-warning' : 'btn-success'} btn-xs" onclick="toggleToken('${safeRefreshToken}', ${!token.enable})" title="${token.enable ? '禁用' : '启用'}">
                    ${token.enable ? '⏸️ 禁用' : '▶️ 启用'}
                </button>
                <button class="btn btn-danger btn-xs" onclick="deleteToken('${safeRefreshToken}')" title="删除">🗑️ 删除</button>
            </div>
        </div>
    `}).join('');
    
    filteredTokens.forEach(token => {
        loadTokenQuotaSummary(token.refresh_token);
    });
    
    updateSensitiveInfoDisplay();
    
    // 重置动画跳过标志
    skipAnimation = false;
    
    // 自动刷新过期的 Token
    if (expiredTokensToRefresh.length > 0) {
        expiredTokensToRefresh.forEach(refreshToken => {
            autoRefreshToken(refreshToken);
        });
    }
}

// 手动刷新 Token
async function manualRefreshToken(refreshToken) {
    if (refreshingTokens.has(refreshToken)) {
        showToast('该 Token 正在刷新中', 'warning');
        return;
    }
    await autoRefreshToken(refreshToken);
}

// 自动刷新过期 Token
async function autoRefreshToken(refreshToken) {
    if (refreshingTokens.has(refreshToken)) return;
    
    refreshingTokens.add(refreshToken);
    const cardId = refreshToken.substring(0, 8);
    
    // 更新 UI 显示刷新中状态
    const card = document.getElementById(`card-${cardId}`);
    const expireRow = document.getElementById(`expire-row-${cardId}`);
    if (card) card.classList.add('refreshing');
    if (expireRow) {
        const valueSpan = expireRow.querySelector('.info-value');
        if (valueSpan) valueSpan.textContent = '🔄 刷新中...';
    }
    
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(refreshToken)}/refresh`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        if (data.success) {
            showToast('Token 已自动刷新', 'success');
            // 刷新成功后重新加载列表
            refreshingTokens.delete(refreshToken);
            loadTokens();
        } else {
            showToast(`Token 刷新失败: ${data.message || '未知错误'}`, 'error');
            refreshingTokens.delete(refreshToken);
            // 更新 UI 显示刷新失败
            if (expireRow) {
                const valueSpan = expireRow.querySelector('.info-value');
                if (valueSpan) valueSpan.textContent = '❌ 刷新失败';
            }
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            showToast(`Token 刷新失败: ${error.message}`, 'error');
        }
        refreshingTokens.delete(refreshToken);
        // 更新 UI 显示刷新失败
        if (expireRow) {
            const valueSpan = expireRow.querySelector('.info-value');
            if (valueSpan) valueSpan.textContent = '❌ 刷新失败';
        }
    }
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
            <p style="font-size: 0.8rem; color: var(--text-light); margin-bottom: 12px;">💡 过期时间默认3599秒(约1小时)</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="addTokenFromModal()">✅ 添加</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
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
        const response = await authFetch('/admin/tokens', {
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
            showToast('Token添加成功', 'success');
            loadTokens();
        } else {
            showToast(data.message || '添加失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('添加失败: ' + error.message, 'error');
    }
}

function editField(event, refreshToken, field, currentValue) {
    event.stopPropagation();
    const row = event.currentTarget;
    const valueSpan = row.querySelector('.info-value');
    
    if (row.querySelector('input')) return;
    
    const fieldLabels = { projectId: 'Project ID', email: '邮箱' };
    
    const input = document.createElement('input');
    input.type = field === 'email' ? 'email' : 'text';
    input.value = currentValue;
    input.className = 'inline-edit-input';
    input.placeholder = `输入${fieldLabels[field]}`;
    
    valueSpan.style.display = 'none';
    row.insertBefore(input, valueSpan.nextSibling);
    input.focus();
    input.select();
    
    const save = async () => {
        const newValue = input.value.trim();
        input.disabled = true;
        
        try {
            const response = await authFetch(`/admin/tokens/${encodeURIComponent(refreshToken)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({ [field]: newValue })
            });
            
            const data = await response.json();
            if (data.success) {
                showToast('已保存', 'success');
                loadTokens();
            } else {
                showToast(data.message || '保存失败', 'error');
                cancel();
            }
        } catch (error) {
            showToast('保存失败', 'error');
            cancel();
        }
    };
    
    const cancel = () => {
        input.remove();
        valueSpan.style.display = '';
    };
    
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (document.activeElement !== input) {
                if (input.value.trim() !== currentValue) {
                    save();
                } else {
                    cancel();
                }
            }
        }, 100);
    });
    
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            save();
        } else if (e.key === 'Escape') {
            cancel();
        }
    });
}

function showTokenDetail(refreshToken) {
    const token = cachedTokens.find(t => t.refresh_token === refreshToken);
    if (!token) {
        showToast('Token不存在', 'error');
        return;
    }
    
    // 转义所有用户数据防止 XSS
    const safeAccessToken = escapeHtml(token.access_token || '');
    const safeRefreshToken = escapeHtml(token.refresh_token);
    const safeRefreshTokenJs = escapeJs(refreshToken);
    const safeProjectId = escapeHtml(token.projectId || '');
    const safeEmail = escapeHtml(token.email || '');
    const expireTimeStr = escapeHtml(new Date(token.timestamp + token.expires_in * 1000).toLocaleString('zh-CN'));
    
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">📝 Token详情</div>
            <div class="form-group compact">
                <label>🎫 Access Token (只读)</label>
                <div class="token-display">${safeAccessToken}</div>
            </div>
            <div class="form-group compact">
                <label>🔄 Refresh Token (只读)</label>
                <div class="token-display">${safeRefreshToken}</div>
            </div>
            <div class="form-group compact">
                <label>📦 Project ID</label>
                <input type="text" id="editProjectId" value="${safeProjectId}" placeholder="项目ID">
            </div>
            <div class="form-group compact">
                <label>📧 邮箱</label>
                <input type="email" id="editEmail" value="${safeEmail}" placeholder="账号邮箱">
            </div>
            <div class="form-group compact">
                <label>⏰ 过期时间</label>
                <input type="text" value="${expireTimeStr}" readonly style="background: var(--bg); cursor: not-allowed;">
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="saveTokenDetail('${safeRefreshTokenJs}')">💾 保存</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

async function saveTokenDetail(refreshToken) {
    const projectId = document.getElementById('editProjectId').value.trim();
    const email = document.getElementById('editEmail').value.trim();
    
    showLoading('保存中...');
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(refreshToken)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ projectId, email })
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            document.querySelector('.form-modal').remove();
            showToast('保存成功', 'success');
            loadTokens();
        } else {
            showToast(data.message || '保存失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('保存失败: ' + error.message, 'error');
    }
}

async function toggleToken(refreshToken, enable) {
    const action = enable ? '启用' : '禁用';
    const confirmed = await showConfirm(`确定要${action}这个Token吗？`, `${action}确认`);
    if (!confirmed) return;
    
    showLoading(`正在${action}...`);
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(refreshToken)}`, {
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
            showToast(`已${action}`, 'success');
            skipAnimation = true; // 跳过动画
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
    const confirmed = await showConfirm('删除后无法恢复，确定删除？', '⚠️ 删除确认');
    if (!confirmed) return;
    
    showLoading('正在删除...');
    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(refreshToken)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        hideLoading();
        if (data.success) {
            showToast('已删除', 'success');
            loadTokens();
        } else {
            showToast(data.message || '删除失败', 'error');
        }
    } catch (error) {
        hideLoading();
        showToast('删除失败: ' + error.message, 'error');
    }
}
