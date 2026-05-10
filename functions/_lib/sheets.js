// Google Sheets API 클라이언트 (Workers 환경, fetch + Web Crypto)
// googleapis SDK 없이 JWT(RS256) 직접 서명해서 access token 발급

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

function b64urlEncode(buf) {
  let s;
  if (buf instanceof ArrayBuffer || ArrayBuffer.isView(buf)) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    s = btoa(bin);
  } else if (typeof buf === 'string') {
    // utf-8 → base64
    s = btoa(unescape(encodeURIComponent(buf)));
  } else {
    s = btoa(JSON.stringify(buf));
  }
  return s.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToArrayBuffer(pem) {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(cleaned);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

let _tokenCache = null; // { token, exp }

async function getAccessToken(env) {
  if (_tokenCache && _tokenCache.exp > Date.now() + 30_000) return _tokenCache.token;

  const credsRaw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credsRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 시크릿이 설정되지 않았습니다.');
  const creds = JSON.parse(credsRaw);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;

  const keyBuf = pemToArrayBuffer(creds.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(data),
  );
  const sigB64 = b64urlEncode(sigBuf);
  const jwt = `${data}.${sigB64}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google OAuth 실패: ${res.status} ${text}`);
  }
  const { access_token, expires_in } = await res.json();
  _tokenCache = { token: access_token, exp: Date.now() + (expires_in * 1000) };
  return access_token;
}

async function sheetsRequest(env, method, urlPath, body) {
  const token = await getAccessToken(env);
  const res = await fetch(`${SHEETS_BASE}${urlPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets API ${method} ${urlPath} 실패: ${res.status} ${text}`);
  }
  return res.json();
}

export async function valuesGet(env, spreadsheetId, range) {
  const enc = encodeURIComponent(range);
  return sheetsRequest(env, 'GET', `/${spreadsheetId}/values/${enc}`);
}

export async function valuesAppend(env, spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
  const enc = encodeURIComponent(range);
  return sheetsRequest(
    env,
    'POST',
    `/${spreadsheetId}/values/${enc}:append?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`,
    { values },
  );
}

export async function valuesUpdate(env, spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
  const enc = encodeURIComponent(range);
  return sheetsRequest(
    env,
    'PUT',
    `/${spreadsheetId}/values/${enc}?valueInputOption=${valueInputOption}`,
    { values },
  );
}

export function getAuthInfo(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return { kind: 'none' };
  try {
    const c = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return { kind: 'service-account', email: c.client_email };
  } catch (e) {
    return { kind: 'invalid', error: e.message };
  }
}
