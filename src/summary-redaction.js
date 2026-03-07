const SUMMARY_SECRET_LINE_PATTERNS = [
  /(^|\n)([ \t>*+\-]*(?:[*_`~]+\s*)*(?:user(?:name)?\s*\/\s*pass(?:word)?|username\s*\/\s*password|credentials?|api[ _-]*key|access[ _-]*token|refresh[ _-]*token|client[ _-]*secret|secret|password|pass|pwd|authorization|bearer)(?:\s*[*_`~]+)*\s*:\s*)([^\n]+)/gi,
  /(^|\n)([ \t>*+\-]*(?:[*_`~]+\s*)*(?:user(?:name)?|email|login)(?:\s*[*_`~]+)*\s*:\s*)([^\n]+)(\n[ \t>*+\-]*(?:[*_`~]+\s*)*(?:pass(?:word)?|pwd)(?:\s*[*_`~]+)*\s*:\s*)([^\n]+)/gi,
];

export function redactSensitiveSummaryText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let redacted = text;
  for (const pattern of SUMMARY_SECRET_LINE_PATTERNS) {
    redacted = redacted.replace(pattern, (...parts) => {
      const leading = parts[1] || "";
      const prefix = parts[2] || "";
      const secondPrefix = parts[4];
      if (typeof secondPrefix === "string") {
        return `${leading}${prefix}[REDACTED]${secondPrefix}[REDACTED]`;
      }
      return `${leading}${prefix}[REDACTED]`;
    });
  }

  redacted = redacted.replace(/\bol_api_[A-Za-z0-9]+\b/g, "ol_api_[REDACTED]");
  redacted = redacted.replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|pk)_[A-Za-z0-9_]+\b/g, "[REDACTED_TOKEN]");
  redacted = redacted.replace(/(https?:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, "$1[REDACTED]@");

  return redacted;
}

export function summarizeSafeText(text, maxChars) {
  const redacted = redactSensitiveSummaryText(text);
  if (typeof redacted !== "string") {
    return redacted;
  }
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}...` : redacted;
}
