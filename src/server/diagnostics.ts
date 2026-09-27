/**
 * Best-effort redaction for stored diagnostics. This is not a guarantee that all
 * sensitive text is removed; treat diagnostics as potentially sensitive and keep
 * them local.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|AIza[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, "[redacted token]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, "$1[redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret)["']?\s*[:=]\s*)["']?[^\s"',}]{8,}["']?/gi, "$1[redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]");
}

export function excerpt(text: string, limit = 1200): string {
  return redact(text.trim()).slice(0, limit);
}
