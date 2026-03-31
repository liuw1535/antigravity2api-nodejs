// HTML 转义函数 - 防止 XSS 注入
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 转义用于 JavaScript 字符串的内容
function escapeJs(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

// 字体大小设置
function initFontSize() {
  const savedSize = localStorage.getItem("fontSize") || "18";
  document.documentElement.style.setProperty(
    "--font-size-base",
    savedSize + "px",
  );
  updateFontSizeInputs(savedSize);
}

function changeFontSize(size) {
  size = Math.max(10, Math.min(24, parseInt(size) || 14));
  document.documentElement.style.setProperty("--font-size-base", size + "px");
  localStorage.setItem("fontSize", size);
  updateFontSizeInputs(size);
}

function updateFontSizeInputs(size) {
  const rangeInput = document.getElementById("fontSizeRange");
  const numberInput = document.getElementById("fontSizeInput");
  if (rangeInput) rangeInput.value = size;
  if (numberInput) numberInput.value = size;
}

// 敏感信息隐藏功能
let sensitiveInfoHidden =
  localStorage.getItem("sensitiveInfoHidden") !== "false";

function initSensitiveInfo() {
  updateSensitiveInfoDisplay();
  updateSensitiveBtn();
}

function toggleSensitiveInfo() {
  sensitiveInfoHidden = !sensitiveInfoHidden;
  localStorage.setItem("sensitiveInfoHidden", sensitiveInfoHidden);
  updateSensitiveInfoDisplay();
  updateSensitiveBtn();
}

function updateSensitiveBtn() {
  const btn = document.getElementById("toggleSensitiveBtn");
  if (btn) {
    if (sensitiveInfoHidden) {
      btn.innerHTML = "🙈 隐藏";
      btn.title = "点击显示敏感信息";
      btn.classList.remove("btn-info");
      btn.classList.add("btn-secondary");
    } else {
      btn.innerHTML = "👁️ 显示";
      btn.title = "点击隐藏敏感信息";
      btn.classList.remove("btn-secondary");
      btn.classList.add("btn-info");
    }
  }
}

function updateSensitiveInfoDisplay() {
  // 隐藏/显示包含敏感信息的整行
  document.querySelectorAll(".sensitive-row").forEach((row) => {
    if (sensitiveInfoHidden) {
      row.style.display = "none";
    } else {
      row.style.display = "";
    }
  });
  // 同时隐藏/显示 token-info 容器
  document.querySelectorAll(".token-info").forEach((container) => {
    if (sensitiveInfoHidden) {
      container.style.display = "none";
    } else {
      container.style.display = "";
    }
  });
}

// 从 403 错误文本中提取 validation_url 或 appeal_url
// 错误文本格式通常为: "API请求返回403: {JSON...}"
function parse403ErrorUrls(errorText) {
  if (!errorText) return null;
  try {
    // 尝试从错误文本中提取 JSON 部分
    const jsonMatch = errorText.match(/\{[\s\S]*\}$/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed?.error || parsed.error.code !== 403) return null;

    const details = parsed.error.details;
    if (!Array.isArray(details)) return null;

    const result = {
      message: parsed.error.message || "",
      reason: "",
      urls: [],
    };

    for (const detail of details) {
      if (detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo") {
        result.reason = detail.reason || "";
        const metadata = detail.metadata || {};

        // VALIDATION_REQUIRED 类型 - 需要验证账号
        if (metadata.validation_url) {
          result.urls.push({
            type: "validation",
            label: metadata.validation_url_link_text || "验证账号",
            url: metadata.validation_url,
            description: metadata.validation_error_message || "需要验证账号",
          });
        }

        // TOS_VIOLATION 类型 - 需要申诉
        if (metadata.appeal_url) {
          result.urls.push({
            type: "appeal",
            label: metadata.appeal_url_link_text || "提交申诉",
            url: metadata.appeal_url,
            description:
              metadata.uiMessage === "true"
                ? parsed.error.message
                : "服务因违反条款被禁用",
          });
        }
      }
    }

    return result.urls.length > 0 ? result : null;
  } catch (e) {
    return null;
  }
}

// 渲染 403 错误 URL 操作区域的 HTML
function render403ActionUrls(errorText) {
  const parsed = parse403ErrorUrls(errorText);
  if (!parsed) return "";

  let html = '<div class="error-403-actions">';

  for (const urlInfo of parsed.urls) {
    const icon = urlInfo.type === "validation" ? "🔐" : "📋";
    const safeUrl = escapeHtml(urlInfo.url);
    const safeLabel = escapeHtml(urlInfo.label);
    const safeDesc = escapeHtml(urlInfo.description);
    const badgeClass =
      urlInfo.type === "validation" ? "badge-validation" : "badge-appeal";
    const badgeText =
      urlInfo.type === "validation" ? "VALIDATION_REQUIRED" : "TOS_VIOLATION";

    html += `
            <div class="error-403-url-item">
                <div class="error-403-url-header">
                    <span class="error-403-badge ${badgeClass}">${icon} ${badgeText}</span>
                </div>
                <div class="error-403-url-desc">${safeDesc}</div>
                <div class="error-403-url-row">
                    <input type="text" class="error-403-url-input" value="${safeUrl}" readonly onclick="this.select()">
                    <button class="btn btn-xs btn-info error-403-copy-btn" onclick="copy403Url(this, '${escapeJs(urlInfo.url)}')" title="复制链接">📋</button>
                </div>
            </div>`;
  }

  html += "</div>";
  return html;
}

// 复制 403 错误中的 URL
function copy403Url(btn, url) {
  navigator.clipboard
    .writeText(url)
    .then(() => {
      const originalText = btn.textContent;
      btn.textContent = "✅";
      btn.classList.remove("btn-info");
      btn.classList.add("btn-success");
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove("btn-success");
        btn.classList.add("btn-info");
      }, 1500);
      if (typeof showToast === "function") {
        showToast("链接已复制到剪贴板", "success");
      }
    })
    .catch(() => {
      // 降级方案：选中输入框内容
      const input = btn.previousElementSibling;
      if (input) {
        input.select();
        document.execCommand("copy");
        if (typeof showToast === "function") {
          showToast("链接已复制到剪贴板", "success");
        }
      }
    });
}
