// 监控中心模块

let monitorState = {
    rangeDays: 7,
    loading: false,
    data: null
};

function formatNumber(value, digits = 0) {
    const number = Number(value) || 0;
    return new Intl.NumberFormat('zh-CN', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits
    }).format(number);
}

function formatCompactNumber(value) {
    const number = Number(value) || 0;
    if (number >= 100000000) return `${formatNumber(number / 100000000, 2)}亿`;
    if (number >= 10000) return `${formatNumber(number / 10000, 2)}万`;
    return formatNumber(number);
}

function formatTokenNumber(value) {
    const number = Number(value) || 0;
    const absNumber = Math.abs(number);
    if (absNumber >= 1000000000) return `${formatNumber(number / 1000000000, 2)}B`;
    if (absNumber >= 1000000) return `${formatNumber(number / 1000000, 2)}M`;
    if (absNumber >= 1000) return `${formatNumber(number / 1000, 2)}K`;
    return formatNumber(number);
}

function initMonitorPage() {
    const savedDays = Number(localStorage.getItem('monitorRangeDays')) || 7;
    monitorState.rangeDays = [7, 14, 30].includes(savedDays) ? savedDays : 7;
    updateMonitorRangeButtons();
    loadMonitorUsage();
}

function setMonitorRange(days) {
    monitorState.rangeDays = [7, 14, 30].includes(Number(days)) ? Number(days) : 7;
    localStorage.setItem('monitorRangeDays', String(monitorState.rangeDays));
    updateMonitorRangeButtons();
    loadMonitorUsage();
}

function updateMonitorRangeButtons() {
    document.querySelectorAll('.monitor-range-btn').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.days) === monitorState.rangeDays);
    });
}

async function loadMonitorUsage() {
    if (monitorState.loading) return;
    monitorState.loading = true;
    renderMonitorLoading();

    try {
        const response = await fetch(`/admin/monitor/usage?days=${monitorState.rangeDays}`, {
            credentials: 'include'
        });
        if (!response.ok) {
            throw new Error('获取监控统计失败');
        }
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || '获取监控统计失败');
        }
        monitorState.data = result.data;
        renderMonitorUsage(result.data);
    } catch (error) {
        console.error('加载监控统计失败:', error);
        showToast('加载监控统计失败: ' + error.message, 'error');
        renderMonitorError(error.message);
    } finally {
        monitorState.loading = false;
    }
}

function renderMonitorLoading() {
    const cards = document.getElementById('monitorCards');
    const chart = document.getElementById('modelUsageChart');
    if (cards && !monitorState.data) {
        cards.innerHTML = Array.from({ length: 5 }).map(() => '<div class="monitor-card skeleton"></div>').join('');
    }
    if (chart && !monitorState.data) {
        chart.innerHTML = '<div class="monitor-empty">正在加载监控数据...</div>';
    }
}

function renderMonitorError(message) {
    const cards = document.getElementById('monitorCards');
    const chart = document.getElementById('modelUsageChart');
    if (cards) cards.innerHTML = `<div class="monitor-error">${escapeHtml(message)}</div>`;
    if (chart) chart.innerHTML = '<div class="monitor-empty">暂无可展示数据</div>';
}

function renderMonitorUsage(data) {
    renderMonitorCards(data);
    renderModelUsageChart(data);
}

function renderMonitorCards(data) {
    const cards = document.getElementById('monitorCards');
    if (!cards) return;

    const totals = data.totals || {};
    const averages = data.averages || {};
    cards.innerHTML = `
        <div class="monitor-card requests">
            <div class="monitor-card-title">请求数</div>
            <div class="monitor-card-value">${formatCompactNumber(totals.requests)}</div>
            <div class="monitor-card-sub">
                <span class="success">成功 ${formatCompactNumber(totals.success)}</span>
                <span class="danger">失败 ${formatCompactNumber(totals.failed)}</span>
            </div>
        </div>
        <div class="monitor-card tokens">
            <div class="monitor-card-title">Tokens</div>
            <div class="monitor-card-value">${formatTokenNumber(totals.totalTokens)}</div>
            <div class="monitor-card-sub">
                <span>输入 ${formatTokenNumber(totals.inputTokens)}</span>
                <span>输出 ${formatTokenNumber(totals.outputTokens)}</span>
            </div>
        </div>
        <div class="monitor-card tpm">
            <div class="monitor-card-title">平均 TPM</div>
            <div class="monitor-card-value">${formatNumber(averages.tpm, 2)}</div>
            <div class="monitor-card-sub"><span>每分钟 Token 数</span></div>
        </div>
        <div class="monitor-card rpm">
            <div class="monitor-card-title">平均 RPM</div>
            <div class="monitor-card-value">${formatNumber(averages.rpm, 2)}</div>
            <div class="monitor-card-sub"><span>每分钟请求数</span></div>
        </div>
        <div class="monitor-card rdp">
            <div class="monitor-card-title">日均 RDP</div>
            <div class="monitor-card-value">${formatNumber(averages.rdp, 2)}</div>
            <div class="monitor-card-sub"><span>每日请求数</span></div>
        </div>
    `;
}

function renderModelUsageChart(data) {
    const container = document.getElementById('modelUsageChart');
    if (!container) return;

    const models = (data.models || []).filter(item => item.totalTokens > 0);
    const totalTokens = models.reduce((sum, item) => sum + item.totalTokens, 0);
    if (!models.length || totalTokens <= 0) {
        container.innerHTML = '<div class="monitor-empty">当前时间范围内暂无 Token 用量数据</div>';
        return;
    }

    const colors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#64748b'];
    const topModels = models.slice(0, 7);
    const otherTokens = models.slice(7).reduce((sum, item) => sum + item.totalTokens, 0);
    const chartItems = otherTokens > 0
        ? [...topModels, { model: '其他模型', totalTokens: otherTokens, requests: models.slice(7).reduce((sum, item) => sum + item.requests, 0) }]
        : topModels;

    let cursor = 0;
    const gradientStops = chartItems.map((item, index) => {
        const percent = item.totalTokens / totalTokens * 100;
        const start = cursor;
        const end = cursor + percent;
        cursor = end;
        return `${colors[index % colors.length]} ${start}% ${end}%`;
    }).join(', ');

    const legend = chartItems.map((item, index) => {
        const percent = item.totalTokens / totalTokens * 100;
        return `
            <div class="model-legend-item">
                <span class="model-color" style="background:${colors[index % colors.length]}"></span>
                <span class="model-name" title="${escapeHtml(item.model)}">${escapeHtml(item.model)}</span>
                <span class="model-tokens">${formatTokenNumber(item.totalTokens)}</span>
                <span class="model-percent">${formatNumber(percent, 1)}%</span>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="donut-wrap">
            <div class="donut-chart" style="background: conic-gradient(${gradientStops});">
                <div class="donut-hole">
                    <span>${formatTokenNumber(totalTokens)}</span>
                    <small>Tokens</small>
                </div>
            </div>
        </div>
        <div class="model-legend">${legend}</div>
    `;
}
