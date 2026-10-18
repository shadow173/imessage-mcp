/** Normalizes a phone number to E.164 (US default) or an email to lowercase. Returns null if neither. */
export function normalizeAddress(input: string): string | null {
  const s = input.trim();
  if (s.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null;
  if (!/^[+()\d\s.-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 4 && digits.length <= 6 && !s.startsWith('+')) return digits; // short code
  if (s.startsWith('+')) return digits.length >= 8 ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits.length >= 8 ? '+' + digits : null;
}

export function isShortCode(address: string): boolean {
  return /^\d{4,6}$/.test(address);
}

/** "+15555550142" -> "(555) 555-0142" */
export function prettyAddress(address: string): string {
  const m = address.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : address;
}

/** A stored handle in comparable form: E.164 phone, lowercase email, or the short code itself. */
export function addressKey(address: string): string {
  return normalizeAddress(address) ?? address.trim().toLowerCase();
}

/** Only digits, spaces, dashes, dots, parens and +: what someone types as (part of) a phone number. */
export function isPhoneShaped(input: string): boolean {
  return /^[+()\d\s.-]+$/.test(input.trim()) && /\d/.test(input);
}
