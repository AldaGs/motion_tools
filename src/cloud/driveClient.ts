// src/cloud/driveClient.ts
//
// Thin wrapper over Google Drive API v3, scoped entirely to the hidden
// appDataFolder. Every call attaches a fresh access token from googleAuth and
// constrains list queries to spaces=appDataFolder so we can never see or touch
// the user's other files.

import { getAccessToken } from './googleAuth';
import { DRIVE_API_FILES, DRIVE_UPLOAD_FILES } from './config';
import type { DriveFileMeta } from './types';

const authHeader = async (): Promise<Record<string, string>> => ({
  Authorization: `Bearer ${await getAccessToken()}`,
});

const check = async (resp: Response, ctx: string): Promise<Response> => {
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Drive ${ctx} failed: ${resp.status} ${body}`);
  }
  return resp;
};

/** Lists all files the app has created in appDataFolder. */
export const listAppFiles = async (): Promise<DriveFileMeta[]> => {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'files(id,name,size,modifiedTime,appProperties)',
    pageSize: '1000',
  });
  const resp = await check(
    await fetch(`${DRIVE_API_FILES}?${params}`, { headers: await authHeader() }),
    'list',
  );
  const j = await resp.json();
  return (j.files ?? []).map((f: any) => ({
    id: f.id,
    name: f.name,
    size: f.size != null ? Number(f.size) : undefined,
    modifiedTime: f.modifiedTime,
    appProperties: f.appProperties,
  }));
};

/** Finds a single file by exact name in appDataFolder, or null. */
export const findByName = async (name: string): Promise<DriveFileMeta | null> => {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${name.replace(/'/g, "\\'")}'`,
    fields: 'files(id,name,size,modifiedTime,appProperties)',
    pageSize: '1',
  });
  const resp = await check(
    await fetch(`${DRIVE_API_FILES}?${params}`, { headers: await authHeader() }),
    'find',
  );
  const j = await resp.json();
  const f = (j.files ?? [])[0];
  if (!f) return null;
  return {
    id: f.id,
    name: f.name,
    size: f.size != null ? Number(f.size) : undefined,
    modifiedTime: f.modifiedTime,
    appProperties: f.appProperties,
  };
};

/** Reads a file's raw text content by id. */
export const downloadText = async (id: string): Promise<string> => {
  const resp = await check(
    await fetch(`${DRIVE_API_FILES}/${id}?alt=media`, { headers: await authHeader() }),
    'download',
  );
  return resp.text();
};

const MULTIPART_BOUNDARY = 'mtag-boundary-7d3f9a';

const buildMultipartBody = (
  metadata: object,
  content: string,
  contentType: string,
): string =>
  `--${MULTIPART_BOUNDARY}\r\n` +
  `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
  `${JSON.stringify(metadata)}\r\n` +
  `--${MULTIPART_BOUNDARY}\r\n` +
  `Content-Type: ${contentType}\r\n\r\n` +
  `${content}\r\n` +
  `--${MULTIPART_BOUNDARY}--`;

/**
 * Creates a new file in appDataFolder. Returns the new file id.
 * `appProperties` can carry small metadata (e.g. updatedAt) queryable later.
 */
export const createFile = async (
  name: string,
  content: string,
  opts: { contentType?: string; appProperties?: Record<string, string> } = {},
): Promise<string> => {
  const metadata = {
    name,
    parents: ['appDataFolder'],
    ...(opts.appProperties ? { appProperties: opts.appProperties } : {}),
  };
  const body = buildMultipartBody(metadata, content, opts.contentType ?? 'application/json');
  const resp = await check(
    await fetch(`${DRIVE_UPLOAD_FILES}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: {
        ...(await authHeader()),
        'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
      },
      body,
    }),
    'create',
  );
  const j = await resp.json();
  return j.id;
};

/** Overwrites an existing file's content (and optionally appProperties). */
export const updateFile = async (
  id: string,
  content: string,
  opts: { contentType?: string; appProperties?: Record<string, string> } = {},
): Promise<void> => {
  // If we need to update appProperties too, use a multipart update; otherwise a
  // simple media update is lighter.
  if (opts.appProperties) {
    const body = buildMultipartBody({ appProperties: opts.appProperties }, content, opts.contentType ?? 'application/json');
    await check(
      await fetch(`${DRIVE_UPLOAD_FILES}/${id}?uploadType=multipart&fields=id`, {
        method: 'PATCH',
        headers: {
          ...(await authHeader()),
          'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
        },
        body,
      }),
      'update',
    );
    return;
  }
  await check(
    await fetch(`${DRIVE_UPLOAD_FILES}/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        ...(await authHeader()),
        'Content-Type': opts.contentType ?? 'application/json',
      },
      body: content,
    }),
    'update',
  );
};

/** Creates or overwrites a named file in one call. Returns the file id. */
export const upsertFile = async (
  name: string,
  content: string,
  opts: { contentType?: string; appProperties?: Record<string, string> } = {},
): Promise<string> => {
  const existing = await findByName(name);
  if (existing) {
    await updateFile(existing.id, content, opts);
    return existing.id;
  }
  return createFile(name, content, opts);
};

/** Deletes a file by id. */
export const deleteFile = async (id: string): Promise<void> => {
  await check(
    await fetch(`${DRIVE_API_FILES}/${id}`, { method: 'DELETE', headers: await authHeader() }),
    'delete',
  );
};

/** Total bytes used by the app's files in appDataFolder — for the space
 * warning UI. */
export const appDataUsage = async (): Promise<{ bytes: number; count: number }> => {
  const files = await listAppFiles();
  const bytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  return { bytes, count: files.length };
};
