import { BlockList, isIP } from 'node:net';

/**
 * Addresses a fetch on the owner's behalf must never reach: loopback, private, link-local, shared, multicast and
 * reserved ranges, plus the IPv6 forms that embed an IPv4 address (NAT64, 6to4, Teredo, IPv4-translated).
 * BlockList checks ::ffff:a.b.c.d against the IPv4 ranges itself.
 */
const BLOCKED_NETS = (() => {
  const b = new BlockList();
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    b.addSubnet(net, bits, 'ipv4');
  for (const [net, bits] of [
    ['::', 96], // unspecified, loopback and IPv4-compatible
    ['::ffff:0:0:0', 96], // IPv4-translated
    ['64:ff9b::', 96], // NAT64
    ['100::', 64], // discard-only
    ['2001::', 32], // Teredo
    ['2002::', 16], // 6to4
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
  ] as const)
    b.addSubnet(net, bits, 'ipv6');
  return b;
})();

/** True for anything that isn't a public IP address, including strings that aren't IP addresses at all. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  return !family || BLOCKED_NETS.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** Suffixes of host names that only resolve inside a local network. A name with no dot is local too. */
const LOCAL_HOST_RE = /(^|\.)(localhost|local|internal|lan|localdomain|home\.arpa)$/;

/** The URL's host in lower case, without IPv6 brackets or a trailing dot. */
export const urlHost = (u: URL) =>
  u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

export type UrlProblem = 'not_https' | 'credentials' | 'private_host';

/**
 * Why `u` is not a public https URL, or null when it is. Checks the literal host only; the fetch must still check
 * every DNS answer and redirect.
 */
export function checkPublicHttpsUrl(u: URL): UrlProblem | null {
  if (u.protocol !== 'https:') return 'not_https';
  if (u.username || u.password) return 'credentials';
  const host = urlHost(u);
  if (isIP(host) ? isBlockedAddress(host) : !host.includes('.') || LOCAL_HOST_RE.test(host)) return 'private_host';
  return null;
}
