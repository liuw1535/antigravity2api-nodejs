// 主入口：初始化和事件绑定

// 页面加载时初始化
initFontSize();
initSensitiveInfo();

// 如果已登录，显示主内容
if (authToken) {
    showMainContent();
    loadTokens();
    loadConfig();
}

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
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (data.success) {
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
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
