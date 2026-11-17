import request from 'supertest';
import { AssetMediaController } from 'src/controllers/asset-media.controller.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMetadataKey } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

const makeUploadDto = (options?: { omit: string }): Record<string, any> => {
  const dto: Record<string, any> = {
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
    isFavorite: 'false',
  };

  const omit = options?.omit;
  if (omit) {
    delete dto[omit];
  }

  return dto;
};

const makeFinishDto = () => ({ ...makeUploadDto(), isFavorite: false, filename: 'example.png', size: 3 });

describe(AssetMediaController.name, () => {
  let ctx: ControllerContext;
  const assetData = Buffer.from('123');
  const filename = 'example.png';
  const service = mockBaseService(AssetMediaService);

  beforeAll(async () => {
    ctx = await controllerSetup(AssetMediaController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: AssetMediaService, useValue: service },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    service.uploadAsset.mockResolvedValue({ status: AssetMediaStatus.DUPLICATE, id: factory.uuid() });

    ctx.reset();
  });

  describe('POST /assets', () => {
    it('should accept metadata', async () => {
      const mobileMetadata = { key: AssetMetadataKey.MobileApp, value: { iCloudId: '123' } };
      const { status } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({
          ...makeUploadDto(),
          metadata: JSON.stringify([mobileMetadata]),
        });

      expect(service.uploadAsset).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ metadata: [mobileMetadata] }),
        expect.objectContaining({ originalName: 'example.png' }),
        undefined,
      );

      expect(status).toBe(200);
    });

    it('should handle invalid metadata json', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({
          ...makeUploadDto(),
          metadata: 'not-a-string-string',
        });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['metadata'], message: 'Invalid input: expected JSON string, received string' },
        ]),
      );
    });

    it('should require `fileCreatedAt`', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto({ omit: 'fileCreatedAt' }) });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileCreatedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received undefined' },
        ]),
      );
    });

    it('should require `fileModifiedAt`', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field(makeUploadDto({ omit: 'fileModifiedAt' }));
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileModifiedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received undefined' },
        ]),
      );
    });

    it('should accept a non-UTC timezone offset', async () => {
      const fileCreatedAt = '2026-05-28T19:51:20.555+02:00';
      const { status } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), fileCreatedAt });

      expect(status).toBe(200);
      expect(service.uploadAsset).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          fileCreatedAt: new Date(fileCreatedAt),
        }),
        expect.objectContaining({ originalName: 'example.png' }),
        undefined,
      );
    });

    it('should reject a timezone-less datetime', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), fileCreatedAt: '2026-05-28T19:51:20.555706' });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileCreatedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received string' },
        ]),
      );
    });

    it('should throw if `isFavorite` is not a boolean', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), isFavorite: 'not-a-boolean' });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['isFavorite'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });

    it('should throw if `visibility` is not an enum', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), visibility: 'not-an-option' });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['visibility'], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
    });

    // TODO figure out how to deal with `sendFile`

    // TODO figure out how to deal with `sendFile`
    describe('GET /assets/:id/thumbnail', () => {
      it('should reject size=original', async () => {
        const { status } = await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/thumbnail?size=original`);
        expect(status).toBe(400);
        expect(service.viewThumbnail).not.toHaveBeenCalled();
      });
    });
  });

  describe('POST /assets/upload-sessions', () => {
    it('should require a filename and size', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/assets/upload-sessions').send({});
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['filename'], message: expect.any(String) },
          { path: ['size'], message: expect.any(String) },
        ]),
      );
    });

    it('should create a session', async () => {
      const id = factory.uuid();
      service.createUploadSession.mockResolvedValue({ id, chunks: [] });

      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets/upload-sessions')
        .send({ filename, size: 1024 });

      expect(status).toBe(201);
      expect(body).toEqual({ id, chunks: [] });
      expect(service.createUploadSession).toHaveBeenCalledWith(undefined, { filename, size: 1024 });
    });
  });

  describe('PUT /assets/upload-sessions/:id/chunks/:index', () => {
    it('should reject an invalid chunk number', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/assets/upload-sessions/${factory.uuid()}/chunks/0`)
        .set('Content-Type', 'application/octet-stream')
        .send(assetData);

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([{ path: ['index'], message: expect.stringContaining('>=1') }]),
      );
    });

    it('should pass the request stream to the service', async () => {
      const id = factory.uuid();
      service.uploadSessionChunk.mockImplementation(async (_auth, _dto, data) => {
        await data.toArray();
      });

      const { status } = await request(ctx.getHttpServer())
        .put(`/assets/upload-sessions/${id}/chunks/3`)
        .set('Content-Type', 'application/octet-stream')
        .send(assetData);

      expect(status).toBe(204);
      expect(service.uploadSessionChunk).toHaveBeenCalledWith(undefined, { id, index: 3 }, expect.anything(), 3);
    });
  });

  describe('POST /assets/upload-sessions/:id/finish', () => {
    it('should require the filename and size', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/assets/upload-sessions/${factory.uuid()}/finish`)
        .send({ ...makeUploadDto(), isFavorite: false });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['filename'], message: expect.any(String) },
          { path: ['size'], message: expect.any(String) },
        ]),
      );
    });

    it('should return 201 for a new asset', async () => {
      const assetId = factory.uuid();
      service.finishUploadSession.mockResolvedValue({ status: AssetMediaStatus.CREATED, id: assetId });

      const { status, body } = await request(ctx.getHttpServer())
        .post(`/assets/upload-sessions/${factory.uuid()}/finish`)
        .send(makeFinishDto());

      expect(status).toBe(201);
      expect(body).toEqual({ status: AssetMediaStatus.CREATED, id: assetId });
    });

    it('should return 200 for a duplicate', async () => {
      service.finishUploadSession.mockResolvedValue({ status: AssetMediaStatus.DUPLICATE, id: factory.uuid() });

      const { status } = await request(ctx.getHttpServer())
        .post(`/assets/upload-sessions/${factory.uuid()}/finish`)
        .send(makeFinishDto());

      expect(status).toBe(200);
    });
  });

  describe('DELETE /assets/upload-sessions/:id', () => {
    it('should reject an invalid id', async () => {
      const { status } = await request(ctx.getHttpServer()).delete('/assets/upload-sessions/invalid');
      expect(status).toBe(400);
    });

    it('should cancel the session', async () => {
      const id = factory.uuid();
      const { status } = await request(ctx.getHttpServer()).delete(`/assets/upload-sessions/${id}`);
      expect(status).toBe(204);
      expect(service.cancelUploadSession).toHaveBeenCalledWith(undefined, id);
    });
  });
});
