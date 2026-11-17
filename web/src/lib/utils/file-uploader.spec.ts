import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { uploadManager } from '#lib/managers/upload-manager.svelte.ts';
import { queryClient } from '#lib/queries/client.ts';
import { getUserConfigQuery } from '#lib/queries/config-user.query.ts';
import { uploadAssetsStore } from '#lib/stores/upload.ts';
import { UploadState } from '#lib/types.ts';
import { uploadRequest } from '#lib/utils.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { setPage } from '#test/unit/mocks/app-state.svelte.ts';
import { AssetMediaStatus, AssetUploadAction, type AssetMediaResponseDto } from '@immich/sdk';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { fileUploadHandler, openFilePicker } from './file-uploader';

vi.mock('#lib/utils.ts', { spy: true });

describe('fileUploader error handling', () => {
  const newFile = () => new File(['content'], `${crypto.randomUUID()}.jpg`, { type: 'image/jpeg' });
  const mockUserObject = factory.user();
  const mockError = new Error('Upload failed');
  const mockUploadResponse = { id: 'mock-id', status: AssetMediaStatus.Created } as AssetMediaResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    uploadAssetsStore.reset();
    queryClient.clear();
  });

  for (const [name, mockUser] of [
    ['logged-in users', true],
    ['anonymous users', false],
  ] as const) {
    describe(`for ${name}`, () => {
      beforeEach(() => {
        if (mockUser) {
          authManager.setUser(mockUserObject);
        }
      });

      test(`should transition successful uploads to done`, async () => {
        vi.mocked(uploadRequest).mockResolvedValue({ status: 200, data: mockUploadResponse });

        await fileUploadHandler({ files: [newFile()] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.DONE);
      });

      test('should capture errors', async ({ logger }) => {
        vi.mocked(uploadRequest).mockRejectedValue(mockError);

        await fileUploadHandler({ files: [newFile()] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.ERROR);
        expect(logger.error).toHaveBeenCalledWith(/Upload failed/);
      });
    });
  }

  test('reports a duplicate without uploading it', async ({ api }) => {
    authManager.setUser(mockUserObject);
    const file = newFile();
    api.on({
      checkBulkUpload: () => ({
        json: {
          results: [{ id: file.name, action: AssetUploadAction.Reject, assetId: 'existing-id', isTrashed: true }],
        },
      }),
    });

    await fileUploadHandler({ files: [file] });

    const [item] = get(uploadAssetsStore);
    expect(item.state).toBe(UploadState.DUPLICATED);
    expect(item.assetId).toBe('existing-id');
    expect(item.isTrashed).toBe(true);
    expect(api.checkBulkUpload).toHaveBeenCalledWith({
      body: { assets: [{ id: file.name, checksum: expect.any(String) }] },
    });
    expect(uploadRequest).not.toHaveBeenCalled();
  });

  test('uploads the file when the duplicate check fails', async ({ api, logger }) => {
    authManager.setUser(mockUserObject);
    api.on({ checkBulkUpload: () => ({ status: 500, json: { message: 'Server error', statusCode: 500 } }) });
    vi.mocked(uploadRequest).mockResolvedValue({ status: 201, data: mockUploadResponse });

    await fileUploadHandler({ files: [newFile()] });

    const [item] = get(uploadAssetsStore);
    expect(item.state).toBe(UploadState.DONE);
    expect(uploadRequest).toHaveBeenCalled();
    expect(api.checkBulkUpload).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(/Error calculating sha1/);
    expect(logger.error).not.toHaveBeenCalledWith(/handleError/);
  });

  test('skips the duplicate check for shared links', async ({ api }) => {
    setPage({ route: { id: '/(user)/share/[key]/[[photos=photos]]/[[assetId=id]]' }, params: { key: 'shared-key' } });
    vi.mocked(uploadRequest).mockResolvedValue({ status: 201, data: mockUploadResponse });

    await fileUploadHandler({ files: [newFile()] });

    const [item] = get(uploadAssetsStore);
    expect(item.state).toBe(UploadState.DONE);
    expect(api.checkBulkUpload).not.toHaveBeenCalled();
  });

  test('should suppress errors on logout', async () => {
    authManager.setUser(mockUserObject);
    authManager.setPreferences(factory.preferences());
    vi.mocked(uploadRequest).mockImplementationOnce(() => {
      queryClient.clear();
      return Promise.reject(mockError);
    });

    await fileUploadHandler({ files: [newFile()] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.STARTED);
  });
});

describe('chunked upload', () => {
  const MIB = 1024 * 1024;
  const sessionId = 'f6d2e1c8-6a5b-4c3d-9e8f-7a6b5c4d3e2f';
  const assetId = 'a7c3b2d1-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const largeFile = () => new File([new Uint8Array(MIB * 2.5)], 'video.mp4', { type: 'video/mp4' });
  const chunkCalls = () =>
    vi
      .mocked(uploadRequest)
      .mock.calls.map(([options]) => ({ url: options.url, method: options.method, size: (options.data as Blob).size }));

  test.beforeEach(({ api }) => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.mp4', '.jpg']);
    uploadAssetsStore.reset();
    queryClient.clear();
    setPage({ route: { id: '/(user)/photos/[[assetId=id]]' }, params: {} });
    authManager.setUser(factory.user());
    queryClient.setQueryData(getUserConfigQuery().queryKey, { server: { uploadChunkSizeMb: 1 } } as never);
    api.on({
      createUploadSession: () => ({ status: 201, json: { id: sessionId, chunks: [] } }),
      finishUploadSession: () => ({ status: 201, json: { id: assetId, status: AssetMediaStatus.Created } }),
      cancelUploadSession: () => ({ status: 204 }),
    });
  });

  afterEach(() => {
    queryClient.removeQueries({ queryKey: getUserConfigQuery().queryKey });
  });

  test('uploads a file larger than the chunk size in numbered chunks', async ({ api }) => {
    vi.mocked(uploadRequest).mockResolvedValue({ status: 204, data: null });

    await expect(fileUploadHandler({ files: [largeFile()] })).resolves.toEqual([assetId]);

    expect(api.createUploadSession).toHaveBeenCalledWith({ body: { filename: 'video.mp4', size: MIB * 2.5 } });
    expect(chunkCalls()).toEqual([
      { url: `/api/assets/upload-sessions/${sessionId}/chunks/1`, method: 'PUT', size: MIB },
      { url: `/api/assets/upload-sessions/${sessionId}/chunks/2`, method: 'PUT', size: MIB },
      { url: `/api/assets/upload-sessions/${sessionId}/chunks/3`, method: 'PUT', size: MIB / 2 },
    ]);
    expect(api.finishUploadSession).toHaveBeenCalledWith({
      params: { id: sessionId },
      body: expect.objectContaining({ filename: 'video.mp4', size: MIB * 2.5, isFavorite: false }),
    });
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
  });

  test('uploads a file within the chunk size in a single request', async ({ api }) => {
    vi.mocked(uploadRequest).mockResolvedValue({
      status: 201,
      data: { id: assetId, status: AssetMediaStatus.Created },
    });

    await fileUploadHandler({ files: [new File(['content'], 'photo.jpg', { type: 'image/jpeg' })] });

    expect(chunkCalls()).toEqual([{ url: '/api/assets', method: undefined, size: undefined }]);
    expect(api.createUploadSession).not.toHaveBeenCalled();
  });

  test('resends a chunk once after a network error', async ({ api }) => {
    vi.mocked(uploadRequest)
      .mockResolvedValue({ status: 204, data: null })
      .mockRejectedValueOnce(new ProgressEvent('error'));

    await fileUploadHandler({ files: [largeFile()] });

    expect(chunkCalls().map(({ url }) => url.split('/').at(-1))).toEqual(['1', '1', '2', '3']);
    expect(api.createUploadSession).toHaveBeenCalled();
    expect(api.finishUploadSession).toHaveBeenCalled();
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
  });

  test('cancels the session when a chunk is rejected', async ({ api, logger }) => {
    vi.mocked(uploadRequest)
      .mockResolvedValueOnce({ status: 204, data: null })
      .mockRejectedValueOnce(new Error('Chunk is larger than the maximum chunk size'));

    await fileUploadHandler({ files: [largeFile()] });

    expect(chunkCalls()).toHaveLength(2);
    expect(api.createUploadSession).toHaveBeenCalled();
    await vi.waitFor(() => expect(api.cancelUploadSession.calls).toHaveLength(1));
    expect(api.cancelUploadSession).toHaveBeenCalledWith({ params: { id: sessionId } });
    expect(api.finishUploadSession).not.toHaveBeenCalled();
    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.ERROR);
    expect(logger.error).toHaveBeenCalledWith(/Chunk is larger/);
  });
});

describe('openFilePicker', () => {
  test('attaches the file input to the document until files are chosen', async () => {
    const file = new File(['content'], 'photo.jpg', { type: 'image/jpeg' });
    const picked = openFilePicker({ extensions: ['.jpg'] });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input).not.toBeNull();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input!.files = transfer.files;
    input!.dispatchEvent(new Event('change'));

    await expect(picked).resolves.toEqual([file]);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
