// 认证相关：登录、登出、OAuth

// 不再使用 localStorage 存储 token，改用 HttpOnly Cookie
let isLoggedIn = false;
let oauthPort = null;
let generatedOAuthUrls = [];

const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

// 封装fetch，自动处理401，使用 credentials: 'include' 发送 Cookie
const authFetch = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    credentials: "include",
  });
  if (response.status === 401) {
    silentLogout();
    showToast("登录已过期，请重新登录", "warning");
    throw new Error("Unauthorized");
  }
  return response;
};

function showMainContent() {
  isLoggedIn = true;
  document.documentElement.classList.add("logged-in");
  document.getElementById("loginForm").classList.add("hidden");
  document.getElementById("mainContent").classList.remove("hidden");
}

function silentLogout() {
  isLoggedIn = false;
  // 清除旧版本的 localStorage token（如果存在）
  localStorage.removeItem("authToken");
  document.documentElement.classList.remove("logged-in");
  document.getElementById("loginForm").classList.remove("hidden");
  document.getElementById("mainContent").classList.add("hidden");
}

async function logout() {
  const confirmed = await showConfirm("确定要退出登录吗？", "退出确认");
  if (!confirmed) return;

  try {
    // 调用后端登出接口清除 Cookie
    await fetch("/admin/logout", {
      method: "POST",
      credentials: "include",
    });
  } catch (e) {
    // 忽略错误
  }

  silentLogout();
  showToast("已退出登录", "info");
}

function generateOAuthPorts(count = 1) {
  const ports = new Set();
  while (ports.size < count) {
    ports.add(Math.floor(Math.random() * 10000) + 50000);
  }
  return Array.from(ports);
}

function getOAuthUrls(count = 1) {
  const normalizedCount = Math.max(1, Math.min(100, Number(count) || 1));
  const ports = generateOAuthPorts(normalizedCount);

  if (normalizedCount === 1) {
    oauthPort = ports[0];
  }

  return ports.map((port) => {
    const redirectUri = `http://localhost:${port}/oauth-callback`;
    return (
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `access_type=offline&client_id=${CLIENT_ID}&prompt=consent&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&` +
      `scope=${encodeURIComponent(SCOPES)}&state=${Date.now()}_${port}`
    );
  });
}

function getOAuthUrl() {
  return getOAuthUrls(1)[0];
}

function getOAuthUrlCount() {
  const countInput = document.getElementById("oauthUrlCount");
  return Math.max(1, Math.min(100, Number(countInput?.value) || 1));
}

function escapeOAuthHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderGeneratedOAuthUrls(urls) {
  const preview = document.getElementById("oauthGeneratedUrls");
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
        已生成 ${urls.length} 条授权链接，建议逐条打开或按条复制。
      </div>
      <button type="button" class="btn btn-secondary oauth-generated-copy-btn" onclick="copyOAuthUrl()">📋 复制全部</button>
    </div>
    <div class="oauth-generated-list">
      ${urls
        .map(
          (url, index) => `
            <div class="oauth-generated-item">
              <div class="oauth-generated-item-header">
                <span>授权链接 ${index + 1}</span>
                <button type="button" class="btn btn-secondary oauth-generated-copy-btn" onclick="copySingleOAuthUrl(${index})">复制此条</button>
              </div>
              <textarea readonly onclick="this.focus();this.select();" rows="2">${escapeOAuthHtml(url)}</textarea>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function copySingleOAuthUrl(index) {
  const url = generatedOAuthUrls[index];
  if (!url) {
    showToast("未找到要复制的授权链接", "error");
    return;
  }

  navigator.clipboard
    .writeText(url)
    .then(() => {
      showToast(`已复制第 ${index + 1} 条授权链接`, "success");
    })
    .catch(() => {
      showToast("复制失败", "error");
    });
}

function generateOAuthUrlList() {
  generatedOAuthUrls = getOAuthUrls(getOAuthUrlCount());
  renderGeneratedOAuthUrls(generatedOAuthUrls);
  showToast(`已生成 ${generatedOAuthUrls.length} 条授权链接`, "success");
}

function openOAuthWindow() {
  const urls = generatedOAuthUrls.length
    ? generatedOAuthUrls
    : getOAuthUrls(getOAuthUrlCount());
  urls.forEach((url) => window.open(url, "_blank"));
}

function copyOAuthUrl() {
  const urls = generatedOAuthUrls.length
    ? generatedOAuthUrls
    : getOAuthUrls(getOAuthUrlCount());
  navigator.clipboard
    .writeText(urls.join("\n"))
    .then(() => {
      showToast(`已复制 ${urls.length} 条授权链接`, "success");
    })
    .catch(() => {
      showToast("复制失败", "error");
    });
}

function showOAuthModal() {
  showToast("点击后请在新窗口完成授权", "info");
  generatedOAuthUrls = [];
  const modal = document.createElement("div");
  modal.className = "modal form-modal oauth-modal";
  modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">🔐 OAuth授权登录</div>
            <div class="oauth-steps">
                <p><strong>📝 授权流程：</strong></p>
                <p>1️⃣ 设置要生成的授权链接数量</p>
                <p>2️⃣ 点击下方按钮打开Google授权页面</p>
                <p>3️⃣ 每完成一次授权后，复制浏览器地址栏的完整URL</p>
                <p>4️⃣ 每行粘贴一个回调URL后提交</p>
            </div>
            <div class="oauth-generator-row">
                <label for="oauthUrlCount" style="white-space: nowrap;">生成数量</label>
                <input type="number" id="oauthUrlCount" min="1" max="100" value="1" style="width: 100px;">
                <button type="button" onclick="generateOAuthUrlList()" class="btn btn-secondary" style="flex: 1;">🔗 生成授权链接</button>
            </div>
            <div id="oauthGeneratedUrls" class="oauth-generated-panel"></div>
            <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                <button type="button" onclick="openOAuthWindow()" class="btn btn-success" style="flex: 1;">🔐 打开授权页面</button>
                <button type="button" onclick="copyOAuthUrl()" class="btn btn-info" style="flex: 1;">📋 复制授权链接</button>
            </div>
            <textarea id="modalCallbackUrl" rows="6" placeholder="每行粘贴一个完整的回调URL&#10;http://localhost:xxxxx/oauth-callback?code=..."></textarea>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">取消</button>
                <button class="btn btn-success" onclick="processOAuthCallbackModal()">✅ 提交</button>
            </div>
        </div>
    `;
  document.body.appendChild(modal);
  renderGeneratedOAuthUrls([]);
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
}

async function processOAuthCallbackModal() {
  const modal = document.querySelector(".form-modal");
  const callbackInput = document
    .getElementById("modalCallbackUrl")
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
    let fallbackCount = 0;
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

        const response = await authFetch("/admin/oauth/exchange", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code, port }),
        });

        const result = await response.json();
        if (!result.success) {
          throw new Error("交换失败: " + result.message);
        }

        successCount += 1;
        if (result.fallbackMode) {
          fallbackCount += 1;
        }
      } catch (error) {
        errors.push(`第${index + 1}行: ${error.message}`);
      }
    }

    hideLoading();

    if (successCount > 0) {
      modal.remove();
      loadTokens();
      const summary = [`成功添加 ${successCount} 个Token`];
      if (fallbackCount > 0) {
        summary.push(
          `其中 ${fallbackCount} 个账号无资格并已自动使用随机ProjectId`,
        );
      }
      if (errors.length > 0) {
        summary.push(`失败 ${errors.length} 条`);
      }
      showToast(
        summary.join("，"),
        errors.length > 0 || fallbackCount > 0 ? "warning" : "success",
      );
    } else {
      showToast(errors.join("；") || "处理失败", "error");
    }
  } catch (error) {
    hideLoading();
    showToast("处理失败: " + error.message, "error");
  }
}

// 检查登录状态（通过尝试访问需要认证的接口）
async function checkLoginStatus() {
  try {
    const response = await fetch("/admin/tokens", {
      credentials: "include",
    });
    return response.status === 200;
  } catch (e) {
    return false;
  }
}
