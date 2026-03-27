// Gemini CLI Token 管理模块

let cachedGeminiCliTokens = [];
let currentGeminiCliFilter =
  localStorage.getItem("geminicliTokenFilter") || "all";
let generatedGeminiCliOAuthUrls = [];

// Gemini CLI OAuth 配置
const GEMINICLI_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINICLI_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/cloud-platform",
].join(" ");

let geminicliOauthPort = null;

// 获取 Gemini CLI OAuth URL
function generateGeminiCliOAuthPorts(count = 1) {
  const ports = new Set();
  while (ports.size < count) {
    ports.add(Math.floor(Math.random() * 10000) + 50000);
  }
  return Array.from(ports);
}

function getGeminiCliOAuthUrls(count = 1) {
  const normalizedCount = Math.max(1, Math.min(100, Number(count) || 1));
  const ports = generateGeminiCliOAuthPorts(normalizedCount);

  if (normalizedCount === 1) {
    geminicliOauthPort = ports[0];
  }

  return ports.map((port) => {
    const redirectUri = `http://localhost:${port}/oauth-callback`;
    return (
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `access_type=offline&client_id=${GEMINICLI_CLIENT_ID}&prompt=consent&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&` +
      `scope=${encodeURIComponent(GEMINICLI_SCOPES)}&state=geminicli_${Date.now()}_${port}`
    );
  });
}

function getGeminiCliOAuthUrl() {
  return getGeminiCliOAuthUrls(1)[0];
}

function getGeminiCliOAuthUrlCount() {
  const countInput = document.getElementById("geminicliOauthUrlCount");
  return Math.max(1, Math.min(100, Number(countInput?.value) || 1));
}

function escapeGeminiCliOAuthHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderGeneratedGeminiCliOAuthUrls(urls) {
  const preview = document.getElementById("geminicliGeneratedOauthUrls");
  if (!preview) return;

  if (!urls.length) {
    preview.innerHTML = `
      <div class="oauth-generated-empty">
        点击“生成授权链接”后，将按条展示在这里，支持单条复制、全部复制和手动框选。
      </div>
    `;
    return;
  }

  preview.innerHTML = `
    <div class="oauth-generated-header">
      <div class="oauth-generated-summary">
        已生成 ${urls.length} 条 Gemini CLI 授权链接，建议逐条打开或按条复制。
      </div>
      <button type="button" class="btn btn-secondary oauth-generated-copy-btn" onclick="copyGeminiCliOAuthUrl()">📋 复制全部</button>
    </div>
    <div class="oauth-generated-list">
      ${urls
        .map(
          (url, index) => `
            <div class="oauth-generated-item">
              <div class="oauth-generated-item-header">
                <span>授权链接 ${index + 1}</span>
                <button type="button" class="btn btn-secondary oauth-generated-copy-btn" onclick="copySingleGeminiCliOAuthUrl(${index})">复制此条</button>
              </div>
              <textarea readonly onclick="this.focus();this.select();" rows="2">${escapeGeminiCliOAuthHtml(url)}</textarea>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function copySingleGeminiCliOAuthUrl(index) {
  const url = generatedGeminiCliOAuthUrls[index];
  if (!url) {
    showToast("未找到要复制的授权链接", "error");
    return;
  }

  navigator.clipboard
    .writeText(url)
    .then(() => {
      showToast(`已复制第 ${index + 1} 条 Gemini CLI 授权链接`, "success");
    })
    .catch(() => {
      showToast("复制失败", "error");
    });
}

function generateGeminiCliOAuthUrlList() {
  generatedGeminiCliOAuthUrls = getGeminiCliOAuthUrls(
    getGeminiCliOAuthUrlCount(),
  );
  renderGeneratedGeminiCliOAuthUrls(generatedGeminiCliOAuthUrls);
  showToast(
    `已生成 ${generatedGeminiCliOAuthUrls.length} 条 Gemini CLI 授权链接`,
    "success",
  );
}

// 打开 Gemini CLI OAuth 窗口
function openGeminiCliOAuthWindow() {
  const urls = generatedGeminiCliOAuthUrls.length
    ? generatedGeminiCliOAuthUrls
    : getGeminiCliOAuthUrls(getGeminiCliOAuthUrlCount());
  urls.forEach((url) => window.open(url, "_blank"));
}

// 复制 Gemini CLI OAuth URL
function copyGeminiCliOAuthUrl() {
  const urls = generatedGeminiCliOAuthUrls.length
    ? generatedGeminiCliOAuthUrls
    : getGeminiCliOAuthUrls(getGeminiCliOAuthUrlCount());
  navigator.clipboard
    .writeText(urls.join("\n"))
    .then(() => {
      showToast(`已复制 ${urls.length} 条 Gemini CLI 授权链接`, "success");
    })
    .catch(() => {
      showToast("复制失败", "error");
    });
}

// 显示 Gemini CLI OAuth 弹窗
function showGeminiCliOAuthModal() {
  showToast("点击后请在新窗口完成授权", "info");
  generatedGeminiCliOAuthUrls = [];
  const modal = document.createElement("div");
  modal.className = "modal form-modal oauth-modal";
  modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">🔐 Gemini CLI OAuth授权</div>
            <div class="oauth-steps">
                <p><strong>📝 授权流程：</strong></p>
                <p>1️⃣ 设置要生成的授权链接数量</p>
                <p>2️⃣ 点击下方按钮打开Google授权页面</p>
                <p>3️⃣ 每完成一次授权后，复制浏览器地址栏的完整URL</p>
                <p>4️⃣ 每行粘贴一个回调URL后提交</p>
            </div>
            <div class="oauth-generator-row">
                <label for="geminicliOauthUrlCount" style="white-space: nowrap;">生成数量</label>
                <input type="number" id="geminicliOauthUrlCount" min="1" max="100" value="1" style="width: 100px;">
                <button type="button" onclick="generateGeminiCliOAuthUrlList()" class="btn btn-secondary" style="flex: 1;">🔗 生成授权链接</button>
            </div>
            <div id="geminicliGeneratedOauthUrls" class="oauth-generated-panel"></div>
            <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                <button type="button" onclick="openGeminiCliOAuthWindow()" class="btn btn-success" style="flex: 1;">🔐 打开授权页面</button>
                <button type="button" onclick="copyGeminiCliOAuthUrl()" class="btn btn-info" style="flex: 1;">📋 复制授权链接</button>
            </div>
            <textarea id="geminicliCallbackUrl" rows="6" placeholder="每行粘贴一个完整的回调URL&#10;http://localhost:xxxxx/oauth-callback?code=..."></textarea>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="processGeminiCliOAuthCallback()">✅ 提交</button>
            </div>
        </div>
    `;
  document.body.appendChild(modal);
  renderGeneratedGeminiCliOAuthUrls([]);
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
}

// 处理 Gemini CLI OAuth 回调
async function processGeminiCliOAuthCallback() {
  const modal = document.querySelector(".form-modal");
  const callbackInput = document
    .getElementById("geminicliCallbackUrl")
    .value.trim();
  if (!callbackInput) {
    showToast("请输入回调URL", "warning");
    return;
  }

  const callbackUrls = callbackInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  showLoading("正在处理授权...");

  try {
    let successCount = 0;
    const errors = [];

    for (let index = 0; index < callbackUrls.length; index++) {
      const callbackUrl = callbackUrls[index];

      try {
        const url = new URL(callbackUrl);
        const code = url.searchParams.get("code");
        const port =
          new URL(url.origin).port || (url.protocol === "https:" ? 443 : 80);

        if (!code) {
          throw new Error("URL中未找到授权码");
        }

        // 使用 geminicli 模式交换 token
        const response = await authFetch("/admin/oauth/exchange", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code, port, mode: "geminicli" }),
        });

        const result = await response.json();
        if (!result.success) {
          throw new Error("交换失败: " + result.message);
        }

        const account = result.data;
        // 添加到 Gemini CLI token 列表
        const addResponse = await authFetch("/admin/geminicli/tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(account),
        });

        const addResult = await addResponse.json();
        if (!addResult.success) {
          throw new Error("添加失败: " + addResult.message);
        }

        successCount += 1;
      } catch (error) {
        errors.push(`第${index + 1}行: ${error.message}`);
      }
    }

    hideLoading();

    if (successCount > 0) {
      modal.remove();
      loadGeminiCliTokens();
      const summary = [`成功添加 ${successCount} 个 Gemini CLI Token`];
      if (errors.length > 0) {
        summary.push(`失败 ${errors.length} 条`);
      }
      showToast(summary.join("，"), errors.length > 0 ? "warning" : "success");
    } else {
      showToast(errors.join("；") || "处理失败", "error");
    }
  } catch (error) {
    hideLoading();
    showToast("处理失败: " + error.message, "error");
  }
}

// 加载 Gemini CLI Token 列表
async function loadGeminiCliTokens() {
  try {
    const response = await authFetch("/admin/geminicli/tokens");
    const data = await response.json();
    if (data.success) {
      renderGeminiCliTokens(data.data);
    } else {
      showToast("加载失败: " + (data.message || "未知错误"), "error");
    }
  } catch (error) {
    if (error.message !== "Unauthorized") {
      showToast("加载Gemini CLI Token失败: " + error.message, "error");
    }
  }
}

// 渲染 Gemini CLI Token 列表
function renderGeminiCliTokens(tokens) {
  cachedGeminiCliTokens = tokens;

  document.getElementById("geminicliTotalTokens").textContent = tokens.length;
  document.getElementById("geminicliEnabledTokens").textContent = tokens.filter(
    (t) => t.enable,
  ).length;
  document.getElementById("geminicliDisabledTokens").textContent =
    tokens.filter((t) => !t.enable).length;

  // 根据筛选条件过滤
  let filteredTokens = tokens;
  if (currentGeminiCliFilter === "enabled") {
    filteredTokens = tokens.filter((t) => t.enable);
  } else if (currentGeminiCliFilter === "disabled") {
    filteredTokens = tokens.filter((t) => !t.enable);
  }

  const tokenList = document.getElementById("geminicliTokenList");
  if (filteredTokens.length === 0) {
    const emptyText =
      currentGeminiCliFilter === "all"
        ? "暂无Token"
        : currentGeminiCliFilter === "enabled"
          ? "暂无启用的Token"
          : "暂无禁用的Token";
    const emptyHint =
      currentGeminiCliFilter === "all"
        ? "点击上方OAuth按钮添加Token"
        : '点击上方"总数"查看全部';
    tokenList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">${emptyText}</div>
                <div class="empty-state-hint">${emptyHint}</div>
            </div>
        `;
    return;
  }

  tokenList.innerHTML = filteredTokens
    .map((token, index) => {
      const tokenId = token.id;
      const cardId = tokenId.substring(0, 8);
      const originalIndex = cachedGeminiCliTokens.findIndex(
        (t) => t.id === token.id,
      );
      const tokenNumber = originalIndex + 1;

      const safeTokenId = escapeJs(tokenId);
      const safeEmail = escapeHtml(token.email || "");
      const safeEmailJs = escapeJs(token.email || "");
      const safeProjectId = escapeHtml(token.projectId || "");
      const hasProjectId = !!token.projectId;

      return `
        <div class="token-card ${!token.enable ? "disabled" : ""}" id="geminicli-card-${escapeHtml(cardId)}">
            <div class="token-header">
                <div class="token-header-left">
                    <span class="status ${token.enable ? "enabled" : "disabled"}">
                        ${token.enable ? "✅ 启用" : "❌ 禁用"}
                    </span>
                    <button class="btn-icon token-refresh-btn" onclick="refreshGeminiCliToken('${safeTokenId}')" title="刷新Token">🔄</button>
                </div>
                <div class="token-header-right">
                    <span class="token-id">#${tokenNumber}</span>
                </div>
            </div>
            <div class="token-info">
                <div class="info-row editable sensitive-row" onclick="editGeminiCliField(event, '${safeTokenId}', 'email', '${safeEmailJs}')" title="点击编辑">
                    <span class="info-label">📧</span>
                    <span class="info-value sensitive-info">${safeEmail || "点击设置"}</span>
                    <span class="info-edit-icon">✏️</span>
                </div>
                <div class="info-row ${hasProjectId ? "" : "warning"}" title="${hasProjectId ? "Project ID" : "缺少 Project ID，点击获取"}">
                    <span class="info-label">📁</span>
                    <span class="info-value ${hasProjectId ? "" : "text-warning"}">${safeProjectId || "未获取"}</span>
                    ${!hasProjectId ? `<button class="btn btn-info btn-xs" onclick="fetchGeminiCliProjectId('${safeTokenId}')" style="margin-left: auto;">获取</button>` : ""}
                </div>
            </div>
            <div class="token-id-row" title="Token ID: ${escapeHtml(tokenId)}">
                <span class="token-id-label">🔑</span>
                <span class="token-id-value">${escapeHtml(tokenId.length > 24 ? tokenId.substring(0, 12) + "..." + tokenId.substring(tokenId.length - 8) : tokenId)}</span>
            </div>
            <div class="token-actions">
                <button class="btn ${token.enable ? "btn-warning" : "btn-success"} btn-xs" onclick="toggleGeminiCliToken('${safeTokenId}', ${!token.enable})" title="${token.enable ? "禁用" : "启用"}">
                    ${token.enable ? "⏸️ 禁用" : "▶️ 启用"}
                </button>
                <button class="btn btn-danger btn-xs" onclick="deleteGeminiCliToken('${safeTokenId}')" title="删除">🗑️ 删除</button>
            </div>
        </div>
    `;
    })
    .join("");

  updateSensitiveInfoDisplay();
}

// 筛选 Gemini CLI Token
function filterGeminiCliTokens(filter) {
  currentGeminiCliFilter = filter;
  localStorage.setItem("geminicliTokenFilter", filter);
  updateGeminiCliFilterButtonState(filter);
  renderGeminiCliTokens(cachedGeminiCliTokens);
}

// 更新筛选按钮状态
function updateGeminiCliFilterButtonState(filter) {
  document.querySelectorAll("#geminicliPage .stat-item").forEach((item) => {
    item.classList.remove("active");
  });
  const filterMap = {
    all: "geminicliTotalTokens",
    enabled: "geminicliEnabledTokens",
    disabled: "geminicliDisabledTokens",
  };
  const activeElement = document.getElementById(filterMap[filter]);
  if (activeElement) {
    activeElement.closest(".stat-item").classList.add("active");
  }
}

// 刷新 Gemini CLI Token
async function refreshGeminiCliToken(tokenId) {
  try {
    const response = await authFetch(
      `/admin/geminicli/tokens/${encodeURIComponent(tokenId)}/refresh`,
      {
        method: "POST",
      },
    );
    const data = await response.json();
    if (data.success) {
      showToast("Token 刷新成功", "success");
      loadGeminiCliTokens();
    } else {
      showToast(`刷新失败: ${data.message || "未知错误"}`, "error");
    }
  } catch (error) {
    if (error.message !== "Unauthorized") {
      showToast(`刷新失败: ${error.message}`, "error");
    }
  }
}

// 获取 Gemini CLI Token 的 Project ID
async function fetchGeminiCliProjectId(tokenId) {
  showLoading("正在获取 Project ID...");
  try {
    const response = await authFetch(
      `/admin/geminicli/tokens/${encodeURIComponent(tokenId)}/fetch-project-id`,
      {
        method: "POST",
      },
    );
    const data = await response.json();
    hideLoading();
    if (data.success) {
      showToast(`Project ID 获取成功: ${data.projectId}`, "success");
      loadGeminiCliTokens();
    } else {
      showToast(`获取失败: ${data.message || "未知错误"}`, "error");
    }
  } catch (error) {
    hideLoading();
    if (error.message !== "Unauthorized") {
      showToast(`获取失败: ${error.message}`, "error");
    }
  }
}

// 编辑 Gemini CLI Token 字段
function editGeminiCliField(event, tokenId, field, currentValue) {
  event.stopPropagation();
  const row = event.currentTarget;
  const valueSpan = row.querySelector(".info-value");

  if (row.querySelector("input")) return;

  const fieldLabels = { email: "邮箱" };

  const input = document.createElement("input");
  input.type = "email";
  input.value = currentValue;
  input.className = "inline-edit-input";
  input.placeholder = `输入${fieldLabels[field]}`;

  valueSpan.style.display = "none";
  row.insertBefore(input, valueSpan.nextSibling);
  input.focus();
  input.select();

  const save = async () => {
    const newValue = input.value.trim();
    input.disabled = true;

    try {
      const response = await authFetch(
        `/admin/geminicli/tokens/${encodeURIComponent(tokenId)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ [field]: newValue }),
        },
      );

      const data = await response.json();
      if (data.success) {
        showToast("已保存", "success");
        loadGeminiCliTokens();
      } else {
        showToast(data.message || "保存失败", "error");
        cancel();
      }
    } catch (error) {
      showToast("保存失败", "error");
      cancel();
    }
  };

  const cancel = () => {
    input.remove();
    valueSpan.style.display = "";
  };

  input.addEventListener("blur", () => {
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

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      cancel();
    }
  });
}

// 切换 Gemini CLI Token 状态
async function toggleGeminiCliToken(tokenId, enable) {
  const action = enable ? "启用" : "禁用";
  const confirmed = await showConfirm(
    `确定要${action}这个Token吗？`,
    `${action}确认`,
  );
  if (!confirmed) return;

  showLoading(`正在${action}...`);
  try {
    const response = await authFetch(
      `/admin/geminicli/tokens/${encodeURIComponent(tokenId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enable }),
      },
    );

    const data = await response.json();
    hideLoading();
    if (data.success) {
      showToast(`已${action}`, "success");
      loadGeminiCliTokens();
    } else {
      showToast(data.message || "操作失败", "error");
    }
  } catch (error) {
    hideLoading();
    showToast("操作失败: " + error.message, "error");
  }
}

// 删除 Gemini CLI Token
async function deleteGeminiCliToken(tokenId) {
  const confirmed = await showConfirm(
    "删除后无法恢复，确定删除？",
    "⚠️ 删除确认",
  );
  if (!confirmed) return;

  showLoading("正在删除...");
  try {
    const response = await authFetch(
      `/admin/geminicli/tokens/${encodeURIComponent(tokenId)}`,
      {
        method: "DELETE",
      },
    );

    const data = await response.json();
    hideLoading();
    if (data.success) {
      showToast("已删除", "success");
      loadGeminiCliTokens();
    } else {
      showToast(data.message || "删除失败", "error");
    }
  } catch (error) {
    hideLoading();
    showToast("删除失败: " + error.message, "error");
  }
}

// 导出 Gemini CLI Token
async function exportGeminiCliTokens() {
  const password = await showPasswordPrompt(
    "请输入管理员密码以导出 Gemini CLI Token",
  );
  if (!password) return;

  showLoading("正在导出...");
  try {
    const response = await authFetch("/admin/geminicli/tokens/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    const data = await response.json();
    hideLoading();

    if (data.success) {
      const blob = new Blob([JSON.stringify(data.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `geminicli-tokens-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("导出成功", "success");
    } else {
      if (response.status === 403) {
        showToast("密码错误，请重新输入", "error");
      } else {
        showToast(data.message || "导出失败", "error");
      }
    }
  } catch (error) {
    hideLoading();
    showToast("导出失败: " + error.message, "error");
  }
}

// 重载 Gemini CLI Token
async function reloadGeminiCliTokens() {
  showLoading("正在重载...");
  try {
    const response = await authFetch("/admin/geminicli/tokens/reload", {
      method: "POST",
    });
    const data = await response.json();
    hideLoading();
    if (data.success) {
      showToast("重载成功", "success");
      loadGeminiCliTokens();
    } else {
      showToast(data.message || "重载失败", "error");
    }
  } catch (error) {
    hideLoading();
    showToast("重载失败: " + error.message, "error");
  }
}

// 初始化 Gemini CLI 页面
function initGeminiCliPage() {
  updateGeminiCliFilterButtonState(currentGeminiCliFilter);
  loadGeminiCliTokens();
}

// ==================== 导入 Gemini CLI Token ====================

let geminicliImportTab = "file";
let geminicliImportFile = null;

// 存储导入弹窗的事件处理器引用，便于清理
let geminicliImportModalHandlers = null;

async function importGeminiCliTokens() {
  showGeminiCliImportModal();
}

function closeGeminiCliImportModal() {
  try {
    const h = geminicliImportModalHandlers;
    if (typeof h?.cleanup === "function") {
      h.cleanup();
    }
  } catch {
    // ignore
  }

  geminicliImportModalHandlers = null;

  const modal = document.getElementById("geminicliImportModal");
  if (modal) modal.remove();

  // 重置状态，避免下次打开沿用旧值
  geminicliImportTab = "file";
  geminicliImportFile = null;
}

function switchGeminiCliImportTab(tab) {
  geminicliImportTab = tab;

  const tabs = document.querySelectorAll("#geminicliImportModal .import-tab");
  tabs.forEach((t) => {
    const isActive = t.getAttribute("data-tab") === tab;
    t.classList.toggle("active", isActive);
  });

  const filePanel = document.getElementById("geminicliImportTabFile");
  const jsonPanel = document.getElementById("geminicliImportTabJson");
  if (filePanel) filePanel.classList.toggle("hidden", tab !== "file");
  if (jsonPanel) jsonPanel.classList.toggle("hidden", tab !== "json");
}

function clearGeminiCliImportFile() {
  geminicliImportFile = null;
  const info = document.getElementById("geminicliImportFileInfo");
  const input = document.getElementById("geminicliImportFileInput");
  if (input) input.value = "";
  if (info) info.classList.add("hidden");
}

function showGeminiCliImportModal() {
  // 如果已存在，先按“可清理”方式关闭
  const existing = document.getElementById("geminicliImportModal");
  if (existing) closeGeminiCliImportModal();

  const modal = document.createElement("div");
  modal.className = "modal form-modal";
  modal.id = "geminicliImportModal";
  modal.innerHTML = `
        <div class="modal-content modal-lg">
            <div class="modal-title">📥 导入 Gemini CLI Token</div>

            <div class="import-tabs">
                <button class="import-tab active" data-tab="file" onclick="switchGeminiCliImportTab('file')">📁 文件上传</button>
                <button class="import-tab" data-tab="json" onclick="switchGeminiCliImportTab('json')">📝 JSON导入</button>
            </div>

            <div class="import-tab-content" id="geminicliImportTabFile">
                <div class="import-dropzone" id="geminicliImportDropzone">
                    <div class="dropzone-icon">📁</div>
                    <div class="dropzone-text">拖拽文件到此处</div>
                    <div class="dropzone-hint">或点击选择文件</div>
                    <input type="file" id="geminicliImportFileInput" accept=".json" style="display: none;">
                </div>
                <div class="import-file-info hidden" id="geminicliImportFileInfo">
                    <div class="file-info-icon">📄</div>
                    <div class="file-info-details">
                        <div class="file-info-name" id="geminicliImportFileName">-</div>
                    </div>
                    <button class="btn btn-xs btn-secondary" onclick="clearGeminiCliImportFile()">✕</button>
                </div>
            </div>

            <div class="import-tab-content hidden" id="geminicliImportTabJson">
                <div class="form-group">
                    <label>📝 粘贴 JSON 内容</label>
                    <textarea id="geminicliImportJsonInput" rows="8" placeholder='{"tokens": [...], "exportTime": "..."}'></textarea>
                </div>
            </div>

            <div class="form-group">
                <label>导入模式</label>
                <select id="geminicliImportMode">
                    <option value="merge">合并（保留现有，添加/更新）</option>
                    <option value="replace">替换（清空现有，导入新的）</option>
                </select>
                <p style="font-size: 0.75rem; color: var(--text-light); margin-top: 0.25rem;">💡 以 refresh_token 去重：合并会更新同 refresh_token 的记录</p>
            </div>

            <div class="form-group">
                <label>管理员密码</label>
                <input type="password" id="geminicliImportPassword" placeholder="必填" autocomplete="current-password">
            </div>

            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeGeminiCliImportModal()">取消</button>
                <button class="btn btn-success" onclick="submitGeminiCliImport()">✅ 导入</button>
            </div>
        </div>
    `;
  document.body.appendChild(modal);

  // wire dropzone
  const dropzone = document.getElementById("geminicliImportDropzone");
  const fileInput = document.getElementById("geminicliImportFileInput");
  const fileInfo = document.getElementById("geminicliImportFileInfo");
  const fileName = document.getElementById("geminicliImportFileName");

  const setFile = (file) => {
    geminicliImportFile = file;
    if (fileName) fileName.textContent = file?.name || "-";
    if (fileInfo) fileInfo.classList.toggle("hidden", !file);
  };

  const cleanupDropzone =
    typeof wireJsonFileDropzone === "function"
      ? wireJsonFileDropzone({
          dropzone,
          fileInput,
          onFile: (file) => setFile(file),
          onError: (message) => showToast(message, "warning"),
        })
      : null;
  const cleanupBackdrop =
    typeof wireModalBackdropClose === "function"
      ? wireModalBackdropClose(modal, closeGeminiCliImportModal)
      : null;

  geminicliImportModalHandlers = {
    cleanup: () => {
      try {
        cleanupDropzone && cleanupDropzone();
      } catch {
        /* ignore */
      }
      try {
        cleanupBackdrop && cleanupBackdrop();
      } catch {
        /* ignore */
      }
    },
  };

  // reset state
  geminicliImportTab = "file";
  geminicliImportFile = null;
  switchGeminiCliImportTab("file");
}

function normalizeGeminiCliImportData(parsed) {
  // 后端期望: { tokens: [...] }
  if (Array.isArray(parsed)) return { tokens: parsed };
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.tokens)) return { tokens: parsed.tokens };
    if (Array.isArray(parsed.accounts)) return { tokens: parsed.accounts };
    // 允许用户直接粘贴 export 返回中的 data
    if (parsed.data && Array.isArray(parsed.data.tokens))
      return { tokens: parsed.data.tokens };
    if (parsed.data && Array.isArray(parsed.data.accounts))
      return { tokens: parsed.data.accounts };

    // 兼容 gcli 单文件凭证：直接是一个 credential 对象
    // 常见字段：refresh_token / refreshToken / token / access_token / accessToken
    const hasRefresh = parsed.refresh_token || parsed.refreshToken;
    const hasAccess = parsed.access_token || parsed.accessToken || parsed.token;
    if (hasRefresh || hasAccess) return { tokens: [parsed] };
  }
  return null;
}

async function submitGeminiCliImport() {
  const password = document
    .getElementById("geminicliImportPassword")
    ?.value?.trim();
  const mode = document.getElementById("geminicliImportMode")?.value || "merge";

  if (!password) {
    showToast("请输入管理员密码", "warning");
    return;
  }

  let rawText = "";
  if (geminicliImportTab === "file") {
    if (!geminicliImportFile) {
      showToast("请选择要导入的 JSON 文件", "warning");
      return;
    }
    rawText = await geminicliImportFile.text();
  } else {
    rawText = document.getElementById("geminicliImportJsonInput")?.value || "";
    if (!rawText.trim()) {
      showToast("请粘贴 JSON 内容", "warning");
      return;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    showToast("JSON 解析失败: " + (e?.message || e), "error");
    return;
  }

  const data = normalizeGeminiCliImportData(parsed);
  if (!data) {
    showToast('无效的导入格式：需要 {"tokens": [...]} 或 token 数组', "error");
    return;
  }

  showLoading("正在导入...");
  try {
    const response = await authFetch("/admin/geminicli/tokens/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, mode, data }),
    });
    const result = await response.json();
    hideLoading();

    if (result.success) {
      closeGeminiCliImportModal();
      showToast(result.message || "导入成功", "success");
      loadGeminiCliTokens();
    } else {
      if (response.status === 403) {
        showToast("密码错误，请重新输入", "error");
      } else {
        showToast(result.message || "导入失败", "error");
      }
    }
  } catch (error) {
    hideLoading();
    showToast("导入失败: " + error.message, "error");
  }
}
