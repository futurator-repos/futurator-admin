import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify, createHash } from 'crypto';
import { signOciRequest } from '../oci-signer';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const keyId = 'ocid1.tenancy.oc1..aaa/ocid1.user.oc1..bbb/aa:bb:cc:dd';

/**
 * Rebuild the exact signing string OCI expects from the signed headers, so the
 * test verifies the signature against the same bytes the signer produced.
 */
function reconstructSigningString(
  method: string,
  url: string,
  headerNames: string[],
  headers: Record<string, string>,
): string {
  const u = new URL(url);
  return headerNames
    .map((name) => {
      if (name === '(request-target)') {
        return `(request-target): ${method.toLowerCase()} ${u.pathname}${u.search}`;
      }
      return `${name}: ${headers[name]}`;
    })
    .join('\n');
}

function parseAuth(auth: string): { headerNames: string[]; signature: string } {
  const headersMatch = auth.match(/headers="([^"]+)"/);
  const sigMatch = auth.match(/signature="([^"]+)"/);
  if (!headersMatch || !sigMatch) throw new Error(`unparseable authorization: ${auth}`);
  return { headerNames: headersMatch[1].split(' '), signature: sigMatch[1] };
}

describe('signOciRequest', () => {
  it('produces a well-formed authorization header for a GET (no body headers)', () => {
    const headers = signOciRequest({
      keyId,
      privateKeyPem,
      method: 'GET',
      url: 'https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances/ocid1.instance.oc1..xyz',
    });

    expect(headers.authorization).toMatch(
      /^Signature version="1",keyId=".+",algorithm="rsa-sha256",headers="\(request-target\) date host",signature=".+"$/,
    );
    expect(headers.date).toBeDefined();
    expect(headers.host).toBe('iaas.eu-frankfurt-1.oraclecloud.com');
    // GET has no body-related headers
    expect(headers['x-content-sha256']).toBeUndefined();
    expect(headers['content-type']).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
  });

  it('signature over a GET verifies with the public key', () => {
    const url = 'https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances/?compartmentId=c';
    const headers = signOciRequest({ keyId, privateKeyPem, method: 'GET', url });
    const { headerNames, signature } = parseAuth(headers.authorization);
    const signingString = reconstructSigningString('GET', url, headerNames, headers);

    const ok = createVerify('RSA-SHA256')
      .update(signingString)
      .verify(publicKeyPem, signature, 'base64');
    expect(ok).toBe(true);
  });

  it('includes and correctly computes body headers for a POST', () => {
    const url = 'https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances/';
    const body = { displayName: 'x', shape: 'VM.Standard.A1.Flex' };
    const headers = signOciRequest({ keyId, privateKeyPem, method: 'POST', url, body });

    const expectedSha = createHash('sha256').update(JSON.stringify(body)).digest('base64');
    expect(headers['x-content-sha256']).toBe(expectedSha);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['content-length']).toBe(String(Buffer.byteLength(JSON.stringify(body))));
    expect(headers.authorization).toMatch(
      /headers="\(request-target\) date host x-content-sha256 content-type content-length"/,
    );
  });

  it('signature over a POST verifies with the public key', () => {
    const url = 'https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances/';
    const body = { displayName: 'srv-1' };
    const headers = signOciRequest({ keyId, privateKeyPem, method: 'POST', url, body });
    const { headerNames, signature } = parseAuth(headers.authorization);
    const signingString = reconstructSigningString('POST', url, headerNames, headers);

    const ok = createVerify('RSA-SHA256')
      .update(signingString)
      .verify(publicKeyPem, signature, 'base64');
    expect(ok).toBe(true);
  });
});
