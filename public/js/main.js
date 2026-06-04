// 主入口：初始化和事件绑定

// 页面加载时初始化
initFontSize();
initSensitiveInfo();
initFilterState(); // 恢复筛选状态

// 检查登录状态并初始化
(async function initApp() {
    try {
        // 检查是否已登录（通过 Cookie）
        const loggedIn = await checkLoginStatus();
        
        // 验证完成，切换到 auth-ready 状态
        document.documentElement.classList.remove('auth-checking');
        document.documentElement.classList.add('auth-ready');
        
        if (loggedIn) {
            showMainContent();
            // 恢复Tab状态，switchTab 内部会根据 tab 类型加载对应数据
            const savedTab = localStorage.getItem('currentTab');
            if (savedTab === 'settings') {
                switchTab('settings', false);
            } else if (savedTab === 'logs') {
                switchTab('logs', false);
            } else if (savedTab === 'geminicli') {
                switchTab('geminicli', false);
            } else if (savedTab === 'monitor') {
                switchTab('monitor', false);
            } else {
                // 默认显示 tokens 页面
                switchTab('tokens', false);
            }
        }
    } catch (e) {
        // 验证失败也要切换状态，显示登录框
        document.documentElement.classList.remove('auth-checking');
        document.documentElement.classList.add('auth-ready');
    }
})();

// 登录表单提交
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
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (data.success) {
            // 不再存储 token 到 localStorage，使用 HttpOnly Cookie
            showToast('登录成功', 'success');
            showMainContent();
            loadTokens();
            loadConfig();
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

// 配置表单提交
document.getElementById('configForm').addEventListener('submit', saveConfig);
