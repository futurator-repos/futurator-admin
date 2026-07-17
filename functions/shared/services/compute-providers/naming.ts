/**
 * Provider resource naming (Servers module).
 *
 * A server's `name` is an operator-facing LABEL — "Google GCP Free trial 1" is
 * a perfectly good one. Provider resource names are IDENTIFIERS with rules:
 * GCE enforces RFC1035 (`[a-z]([-a-z0-9]{0,61}[a-z0-9])?` — lowercase, no
 * spaces, ≤63) and rejects anything else outright; Hetzner wants RFC1123.
 * Passing the label through verbatim made the provider reject the request
 * after we had already minted an IAM user.
 *
 * So: labels stay free-form in DynamoDB and the UI; adapters name provider
 * resources through this function. The serverId's own suffix is appended so
 * two servers labelled the same can't collide, and so a box in the provider's
 * console can be traced back to its fleet row.
 */

const MAX_LEN = 63;

/**
 * Slugify a label into an RFC1035-safe resource name, suffixed with the
 * serverId's unique part.
 *
 * `('Google GCP Free trial 1', 'srv_gcp_ab12cd')` → `'google-gcp-free-trial-1-ab12cd'`
 * `('🚀', 'srv_gcp_ab12cd')`                      → `'srv-gcp-ab12cd'`
 */
export function toProviderResourceName(label: string, serverId: string): string {
  // serverId is `srv_<provider>_<6 chars>`; hyphens are legal, underscores are not.
  const suffix = (serverId.split('_').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fallback = serverId.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics becomes one hyphen
    .replace(/^-+|-+$/g, '');

  if (!slug) return trimToRules(fallback);
  const suffixed = suffix ? `${slug}-${suffix}` : slug;
  return trimToRules(suffixed);
}

/** Enforce: starts with a letter, ends alphanumeric, ≤63 chars. */
function trimToRules(value: string): string {
  let out = value.slice(0, MAX_LEN);
  // Must start with a letter — a leading digit is legal in the label but not here.
  if (!/^[a-z]/.test(out)) out = `s-${out}`.slice(0, MAX_LEN);
  // Must not end on a hyphen (possible after the length trim).
  out = out.replace(/-+$/, '');
  return out;
}
