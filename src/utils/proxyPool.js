import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "../config/config.js";
import logger from "./logger.js";
import { getDataDir } from "./paths.js";

const PROXY_ROTATION_STATE_FILE = "proxy_rotation.json";

export function normalizeProxyProtocol(protocol = "http") {
  const normalized = String(protocol || "http")
    .trim()
    .toLowerCase();

  if (
    normalized === "socket5" ||
    normalized === "socks" ||
    normalized === "socks5"
  ) {
    return "socks5";
  }

  if (normalized === "https") {
    return "https";
  }

  return "http";
}

function normalizeLines(value = "") {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function splitPoolLines(poolRaw = "") {
  return normalizeLines(poolRaw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildProxyUrl({ protocol, host, port, username = "", password = "" }) {
  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password || "")}@`
    : "";

  return `${protocol}://${auth}${host}:${port}`;
}

function parseProxyUrl(proxyUrl) {
  const rawValue = String(proxyUrl).trim();
  if (!rawValue.includes("://")) {
    return null;
  }

  try {
    const parsedUrl = new URL(rawValue);
    const protocol = normalizeProxyProtocol(
      parsedUrl.protocol.replace(":", ""),
    );

    return {
      raw: rawValue,
      protocol,
      host: parsedUrl.hostname,
      port: Number.parseInt(parsedUrl.port, 10) || undefined,
      username: decodeURIComponent(parsedUrl.username || ""),
      password: decodeURIComponent(parsedUrl.password || ""),
      url: rawValue,
    };
  } catch {
    return null;
  }
}

function parseProxyPoolLine(line, protocol) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const urlProxy = parseProxyUrl(trimmed);
  if (urlProxy) {
    return urlProxy;
  }

  const segments = trimmed.split(":");
  if (segments.length < 2) {
    throw new Error(`代理格式无效: ${trimmed}`);
  }

  const [host, portRaw, usernameRaw = "", ...passwordParts] = segments;
  const port = Number.parseInt(portRaw, 10);
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`代理格式无效: ${trimmed}`);
  }

  const username = usernameRaw || "";
  const password = passwordParts.join(":");

  return {
    raw: trimmed,
    protocol,
    host,
    port,
    username,
    password,
    url: buildProxyUrl({ protocol, host, port, username, password }),
  };
}

export function parseProxyPool(poolRaw = "", protocol = "http") {
  const normalizedProtocol = normalizeProxyProtocol(protocol);
  return splitPoolLines(poolRaw)
    .map((line) => parseProxyPoolLine(line, normalizedProtocol))
    .filter(Boolean);
}

function getRotationStatePath() {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  return path.join(dataDir, PROXY_ROTATION_STATE_FILE);
}

function loadRotationState() {
  try {
    const statePath = getRotationStatePath();
    if (!fs.existsSync(statePath)) {
      return { poolKey: null, nextIndex: 0 };
    }

    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);

    return {
      poolKey: typeof parsed.poolKey === "string" ? parsed.poolKey : null,
      nextIndex: Number.isInteger(parsed.nextIndex) ? parsed.nextIndex : 0,
    };
  } catch (error) {
    logger.warn(`读取代理轮询状态失败: ${error.message}`);
    return { poolKey: null, nextIndex: 0 };
  }
}

function saveRotationState({ poolKey, nextIndex, updatedAt = Date.now() }) {
  try {
    const statePath = getRotationStatePath();
    fs.writeFileSync(
      statePath,
      JSON.stringify({ poolKey, nextIndex, updatedAt }, null, 2),
      "utf8",
    );
  } catch (error) {
    logger.warn(`保存代理轮询状态失败: ${error.message}`);
  }
}

function buildPoolKey(protocol, poolRaw) {
  return crypto
    .createHash("sha1")
    .update(`${normalizeProxyProtocol(protocol)}\n${normalizeLines(poolRaw)}`)
    .digest("hex");
}

function resolveProxyEntries(proxyConfig) {
  if (!proxyConfig) return [];

  if (typeof proxyConfig === "string") {
    const parsedUrl = parseProxyUrl(proxyConfig);
    if (parsedUrl) return [parsedUrl];
    return parseProxyPool(proxyConfig, "http");
  }

  if (typeof proxyConfig !== "object" || proxyConfig.enabled === false) {
    return [];
  }

  if (proxyConfig.poolRaw) {
    return parseProxyPool(proxyConfig.poolRaw, proxyConfig.protocol);
  }

  if (proxyConfig.url) {
    const parsedUrl = parseProxyUrl(proxyConfig.url);
    if (parsedUrl) return [parsedUrl];
    return parseProxyPool(proxyConfig.url, proxyConfig.protocol);
  }

  return [];
}

export function getNextProxyConfig(proxyOverride = undefined) {
  const effectiveProxy =
    proxyOverride !== undefined ? proxyOverride : config.proxy;
  const entries = resolveProxyEntries(effectiveProxy);

  if (entries.length === 0) {
    return null;
  }

  if (entries.length === 1) {
    return entries[0];
  }

  const protocol = normalizeProxyProtocol(
    typeof effectiveProxy === "object"
      ? effectiveProxy.protocol
      : entries[0].protocol,
  );
  const poolRaw =
    typeof effectiveProxy === "object" && effectiveProxy.poolRaw
      ? effectiveProxy.poolRaw
      : entries.map((entry) => entry.raw).join("\n");

  const poolKey = buildPoolKey(protocol, poolRaw);
  const state = loadRotationState();
  const nextIndex = state.poolKey === poolKey ? state.nextIndex : 0;
  const index =
    ((nextIndex % entries.length) + entries.length) % entries.length;
  const selected = entries[index];

  saveRotationState({
    poolKey,
    nextIndex: (index + 1) % entries.length,
  });

  return {
    ...selected,
    index,
  };
}
