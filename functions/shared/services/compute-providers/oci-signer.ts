import { createSign, createHash } from 'crypto';

/**
 * Signs an OCI REST request using the draft-cavage HTTP Signatures scheme that
 * Oracle Cloud Infrastructure requires (rsa-sha256 over a canonical signing
 * string). Returns the headers to attach to the outgoing `fetch` — including
 * `authorization`, `date`, `host`, and (for requests with a body) the
 * `x-content-sha256`, `content-type`, and `content-length` headers OCI folds
 * into the signature.
 *
 * `keyId` is the OCI convention `tenancyOcid/userOcid/fingerprint`.
 */
export function signOciRequest(opts: {
  keyId: string;
  privateKeyPem: string;
  method: string;
  url: string;
  body?: unknown;
}): Record<string, string> {
  const u = new URL(opts.url);
  const date = new Date().toUTCString();
  const names = ['(request-target)', 'date', 'host'];
  const lines = [
    `(request-target): ${opts.method.toLowerCase()} ${u.pathname}${u.search}`,
    `date: ${date}`,
    `host: ${u.host}`,
  ];
  const headers: Record<string, string> = { date, host: u.host };

  if (opts.body !== undefined) {
    const bodyStr = JSON.stringify(opts.body);
    const sha = createHash('sha256').update(bodyStr).digest('base64');
    headers['x-content-sha256'] = sha;
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(bodyStr));
    names.push('x-content-sha256', 'content-type', 'content-length');
    lines.push(
      `x-content-sha256: ${sha}`,
      `content-type: application/json`,
      `content-length: ${headers['content-length']}`,
    );
  }

  const signature = createSign('RSA-SHA256')
    .update(lines.join('\n'))
    .sign(opts.privateKeyPem, 'base64');

  headers['authorization'] =
    `Signature version="1",keyId="${opts.keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"`;

  return headers;
}
