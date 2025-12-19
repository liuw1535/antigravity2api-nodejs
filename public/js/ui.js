// UI组件：Toast、Modal、Loading

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

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    document.getElementById('tokensPage').classList.add('hidden');
    document.getElementById('settingsPage').classList.add('hidden');
    
    if (tab === 'tokens') {
        document.getElementById('tokensPage').classList.remove('hidden');
    } else if (tab === 'settings') {
        document.getElementById('settingsPage').classList.remove('hidden');
        loadConfig();
    }
}
