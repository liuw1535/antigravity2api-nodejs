import { SocksProxyAgent } from 'socks-proxy-agent';

// Build axios proxy / agent configuration from a proxy URL string.
// Supports http/https via axios `proxy` option and socks proxies via agents.
export function buildAxiosProxyOptions(proxyString) {
  if (!proxyString) return {};

  const proxyUrl = new URL(proxyString);
  const protocol = proxyUrl.protocol.replace(':', '');

  // SOCKS proxies are handled via agents (axios proxy option does not support them)
  if (protocol.startsWith('socks')) {
    const agent = new SocksProxyAgent(proxyUrl.href);
    return {
      proxy: false,
      httpAgent: agent,
      httpsAgent: agent
    };
  }

  // Default ports if not provided
  const port = proxyUrl.port
    ? parseInt(proxyUrl.port, 10)
    : (protocol === 'https' ? 443 : 80);

  const auth = proxyUrl.username
    ? {
        username: decodeURIComponent(proxyUrl.username),
        password: decodeURIComponent(proxyUrl.password || '')
      }
    : undefined;

  return {
    proxy: {
      protocol,
      host: proxyUrl.hostname,
      port,
      auth
    }
  };
}
