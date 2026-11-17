import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sanitize from 'sanitize-filename';
import { UPLOAD_SESSION_EXPIRATION_HOURS, UPLOAD_SESSION_FOLDER_SUFFIX } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { Asset, AuthSharedLink } from 'src/database.js';
import { OnJob } from 'src/decorators.js';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
  AssetRejectReason,
  AssetUploadAction,
  AssetUploadSessionResponseDto,
} from 'src/dtos/asset-media-response.dto.js';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaSize,
  AssetUploadSessionChunkParamDto,
  AssetUploadSessionCreateDto,
  AssetUploadSessionFinishDto,
  UploadFieldName,
} from 'src/dtos/asset-media.dto.js';
import { AssetDownloadOriginalDto } from 'src/dtos/asset.dto.js';
import { AuthDto, isEditedOnly, isMetadataHidden } from 'src/dtos/auth.dto.js';
import {
  AssetFileType,
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  Permission,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { BaseService } from 'src/services/base.service.js';
import type { UploadFile, UploadRequest } from 'src/types.js';
import { requireUploadAccess } from 'src/utils/access.js';
import { asUploadRequest, onBeforeLink } from 'src/utils/asset.util.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import {
  ImmichFileResponse,
  getDownloadFile,
  getFileNameWithoutExtension,
  getFilenameExtension,
} from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { fromChecksum } from 'src/utils/request.js';

const requireChunkSize = (size: number, maxChunkSize: number) => {
  if (size > maxChunkSize) {
    throw new PayloadTooLargeException(`Chunk is larger than the maximum chunk size of ${maxChunkSize} bytes`);
  }
};

async function* limitChunkSize(data: AsyncIterable<Buffer>, maxChunkSize: number) {
  let size = 0;
  for await (const buffer of data) {
    size += buffer.length;
    if (size <= maxChunkSize) {
      yield buffer;
    }
  }
  requireChunkSize(size, maxChunkSize);
}

export interface AssetMediaRedirectResponse {
  targetSize: AssetMediaSize | 'original';
}

@Injectable()
export class AssetMediaService extends BaseService {
  async getUploadAssetIdByChecksum(auth: AuthDto, checksum?: string): Promise<AssetMediaResponseDto | undefined> {
    if (!checksum) {
      return;
    }

    await this.requireAccess({ auth, permission: Permission.AssetUpload, ids: [auth.user.id] });

    const assetId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, fromChecksum(checksum));
    if (!assetId) {
      return;
    }

    return { id: assetId, status: AssetMediaStatus.DUPLICATE };
  }

  canUploadFile({ auth, fieldName, file, body }: UploadRequest): true {
    requireUploadAccess(auth);

    const filename = body.filename || file.originalName;

    switch (fieldName) {
      case UploadFieldName.ASSET_DATA: {
        if (mimeTypes.isAsset(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.SIDECAR_DATA: {
        if (mimeTypes.isSidecar(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.PROFILE_DATA: {
        if (mimeTypes.isProfile(filename)) {
          return true;
        }
        break;
      }
    }

    this.logger.error(`Unsupported file type ${filename}`);
    throw new BadRequestException(`Unsupported file type ${filename}`);
  }

  getUploadFilename({ auth, fieldName, file, body }: UploadRequest): string {
    requireUploadAccess(auth);

    const extension = getFilenameExtension(body.filename || file.originalName);
    const lookup = {
      [UploadFieldName.ASSET_DATA]: extension,
      [UploadFieldName.SIDECAR_DATA]: '.xmp',
      [UploadFieldName.PROFILE_DATA]: extension,
    };

    return sanitize(`${file.uuid}${lookup[fieldName]}`);
  }

  getUploadFolder({ auth, fieldName, file }: UploadRequest): string {
    auth = requireUploadAccess(auth);

    let folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, file.uuid);
    if (fieldName === UploadFieldName.PROFILE_DATA) {
      folder = StorageCore.getFolderLocation(StorageFolder.Profile, auth.user.id);
    }

    this.storageRepository.mkdirSync(folder);

    return folder;
  }

  async onUploadError(request: AuthRequest, file: Express.Multer.File) {
    const uploadFilename = this.getUploadFilename(asUploadRequest(request, file));
    const uploadFolder = this.getUploadFolder(asUploadRequest(request, file));
    const uploadPath = `${uploadFolder}/${uploadFilename}`;

    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [uploadPath] } });
  }

  async uploadAsset(
    auth: AuthDto,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    sidecarFile?: UploadFile,
  ): Promise<AssetMediaResponseDto> {
    let asset: Asset | undefined;
    try {
      await this.requireAccess({
        auth,
        permission: Permission.AssetUpload,
        // do not need an id here, but the interface requires it
        ids: [auth.user.id],
      });

      this.requireQuota(auth, file.size);

      if (dto.livePhotoVideoId) {
        if (auth.sharedLink) {
          const ids = new Set([dto.livePhotoVideoId]);
          const [assetIds1, assetIds2] = await Promise.all([
            this.accessRepository.asset.checkSharedLinkAccess(auth.sharedLink.id, ids),
            this.accessRepository.asset.checkOwnerAccess(auth.user.id, ids, false),
          ]);

          if (!assetIds1.intersection(assetIds2).has(dto.livePhotoVideoId)) {
            throw new BadRequestException(`Not found or no ${Permission.AssetUpdate} permission`);
          }
        } else {
          await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [dto.livePhotoVideoId] });
        }
        await onBeforeLink(
          { asset: this.assetRepository, event: this.eventRepository },
          { userId: auth.user.id, livePhotoVideoId: dto.livePhotoVideoId },
        );
      }

      asset = await this.assetRepository.create({
        ownerId: auth.user.id,
        libraryId: null,

        checksum: file.checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: file.originalPath,

        fileCreatedAt: dto.fileCreatedAt,
        fileModifiedAt: dto.fileModifiedAt,
        localDateTime: dto.fileCreatedAt,

        type: mimeTypes.assetType(file.originalPath),
        isFavorite: dto.isFavorite,
        duration: dto.duration || null,
        visibility: dto.visibility ?? AssetVisibility.Timeline,
        livePhotoVideoId: dto.livePhotoVideoId,
        originalFileName: dto.filename || file.originalName,
      });

      if (dto.metadata?.length) {
        await this.assetRepository.upsertMetadata(asset.id, dto.metadata);
      }

      if (sidecarFile) {
        await this.assetRepository.upsertFile({
          assetId: asset.id,
          path: sidecarFile.originalPath,
          type: AssetFileType.Sidecar,
        });
        await this.storageRepository.utimes(sidecarFile.originalPath, new Date(), new Date(dto.fileModifiedAt));
      }
      await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: file.size },
        lockedPropertiesBehavior: 'override',
      });

      await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

      if (auth.sharedLink) {
        await this.addToSharedLink(auth.sharedLink, asset.id);
      }

      await this.eventRepository.emit('AssetCreate', { asset, file });

      return { id: asset.id, status: AssetMediaStatus.CREATED };
    } catch (error: any) {
      // clean up files
      await this.jobRepository.queue({
        name: JobName.FileDelete,
        data: { files: [file.originalPath, sidecarFile?.originalPath] },
      });

      // handle duplicates with a success response
      if (isAssetChecksumConstraint(error)) {
        const duplicateId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, file.checksum);
        if (!duplicateId) {
          this.logger.error(`Error locating duplicate for checksum constraint`);
          throw new InternalServerErrorException();
        }

        if (auth.sharedLink) {
          await this.addToSharedLink(auth.sharedLink, duplicateId);
        }

        this.logger.debug(`Duplicate asset upload rejected: existing asset ${duplicateId}`);
        return { status: AssetMediaStatus.DUPLICATE, id: duplicateId };
      }

      // clean up the asset row if one was created
      if (asset) {
        await this.assetRepository.remove({ id: asset.id });
      }

      this.logger.error(`Error uploading file ${error}`, error?.stack);
      throw error;
    }
  }

  async createUploadSession(auth: AuthDto, dto: AssetUploadSessionCreateDto): Promise<AssetUploadSessionResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpload, ids: [auth.user.id] });
    this.requireAssetFilename(dto.filename);
    this.requireQuota(auth, dto.size);

    const id = this.cryptoRepository.randomUUID();
    this.storageRepository.mkdirSync(this.getUploadSessionPaths(auth, id).sessionFolder);

    return { id, chunks: [] };
  }

  async getUploadSession(auth: AuthDto, id: string): Promise<AssetUploadSessionResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpload, ids: [auth.user.id] });
    const { sessionFolder } = this.getUploadSessionPaths(auth, id);
    const chunks = await this.getUploadSessionChunks(sessionFolder);
    return { id, chunks: chunks.map(({ index, size }) => ({ index, size })) };
  }

  async uploadSessionChunk(
    auth: AuthDto,
    { id, index }: AssetUploadSessionChunkParamDto,
    data: Readable,
    declaredSize = 0,
  ) {
    await this.requireAccess({ auth, permission: Permission.AssetUpload, ids: [auth.user.id] });
    const { sessionFolder } = this.getUploadSessionPaths(auth, id);
    const chunks = await this.getUploadSessionChunks(sessionFolder);
    this.requireQuota(
      auth,
      chunks.reduce((total, chunk) => total + chunk.size, 0),
    );

    const { server } = await this.getConfig({ withCache: true });
    const maxChunkSize = server.uploadChunkSizeMb * 1024 * 1024;
    requireChunkSize(declaredSize, maxChunkSize);

    const chunkPath = join(sessionFolder, String(index));
    const partPath = `${chunkPath}.${this.cryptoRepository.randomUUID()}.part`;
    try {
      await this.storageRepository.writeStream(partPath, Readable.from(limitChunkSize(data, maxChunkSize)));
      await this.storageRepository.rename(partPath, chunkPath);
    } catch (error) {
      await this.storageRepository.unlink(partPath);
      throw error;
    }
  }

  async finishUploadSession(
    auth: AuthDto,
    id: string,
    { size, checksum, ...dto }: AssetUploadSessionFinishDto,
  ): Promise<AssetMediaResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpload, ids: [auth.user.id] });
    this.requireAssetFilename(dto.filename);

    const { folder, sessionFolder } = this.getUploadSessionPaths(auth, id);
    const chunks = await this.getUploadSessionChunks(sessionFolder);
    if (chunks.length === 0 || chunks.some((chunk, position) => chunk.index !== position + 1)) {
      throw new BadRequestException('Upload session is missing chunks');
    }

    const receivedSize = chunks.reduce((total, chunk) => total + chunk.size, 0);
    if (receivedSize !== size) {
      throw new BadRequestException(`Expected ${size} bytes, but received ${receivedSize}`);
    }

    const originalPath = join(folder, sanitize(`${id}${getFilenameExtension(dto.filename)}`));
    let fileChecksum: Buffer;
    try {
      await this.storageRepository.concatFiles(
        chunks.map((chunk) => chunk.path),
        originalPath,
      );

      fileChecksum = await this.cryptoRepository.hashFile(originalPath);
      if (checksum && !fileChecksum.equals(fromChecksum(checksum))) {
        throw new BadRequestException('Checksum does not match the received chunks');
      }
    } catch (error) {
      await this.storageRepository.unlink(originalPath);
      throw error;
    }

    await this.storageRepository.unlinkDir(sessionFolder, { recursive: true, force: true });

    return this.uploadAsset(auth, dto, {
      uuid: id,
      checksum: fileChecksum,
      originalPath,
      originalName: dto.filename,
      size,
    });
  }

  async cancelUploadSession(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetUpload, ids: [auth.user.id] });
    const { sessionFolder } = this.getUploadSessionPaths(auth, id);
    await this.getUploadSessionChunks(sessionFolder);
    await this.storageRepository.unlinkDir(sessionFolder, { recursive: true, force: true });
  }

  @OnJob({ name: JobName.UploadSessionCleanup, queue: QueueName.BackgroundTask })
  async handleUploadSessionCleanup(): Promise<JobStatus> {
    const expiredBefore = DateTime.now().minus({ hours: UPLOAD_SESSION_EXPIRATION_HOURS }).toJSDate();
    const sessionFolders = await this.storageRepository.findDirectories(
      StorageCore.getBaseFolder(StorageFolder.Upload),
      `*/*/*/*${UPLOAD_SESSION_FOLDER_SUFFIX}`,
    );

    let removed = 0;
    for (const sessionFolder of sessionFolders) {
      const { mtime } = await this.storageRepository.stat(sessionFolder);
      if (mtime >= expiredBefore) {
        continue;
      }

      await this.storageRepository.unlinkDir(sessionFolder, { recursive: true, force: true });
      removed++;
    }

    this.logger.log(`Removed ${removed} expired upload sessions`);

    return JobStatus.Success;
  }

  private getUploadSessionPaths(auth: AuthDto, id: string) {
    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, id);
    return { folder, sessionFolder: join(folder, `${id}${UPLOAD_SESSION_FOLDER_SUFFIX}`) };
  }

  private async getUploadSessionChunks(sessionFolder: string) {
    let names: string[];
    try {
      names = await this.storageRepository.readdir(sessionFolder);
    } catch {
      throw new NotFoundException('Upload session not found');
    }

    const chunks = await Promise.all(
      names
        .filter((name) => /^\d+$/.test(name))
        .map(async (name) => {
          const path = join(sessionFolder, name);
          const { size } = await this.storageRepository.stat(path);
          return { index: Number(name), size, path };
        }),
    );

    return chunks.toSorted((a, b) => a.index - b.index);
  }

  private requireAssetFilename(filename: string) {
    if (!mimeTypes.isAsset(filename)) {
      throw new BadRequestException(`Unsupported file type ${filename}`);
    }
  }

  async downloadOriginal(auth: AuthDto, id: string, dto: AssetDownloadOriginalDto): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });

    const config = await this.getConfig({ withCache: true });

    const asset = await this.assetRepository.getForOriginal(id, isEditedOnly(auth, dto.edited));
    const { path, name, extension } = getDownloadFile(asset, config);

    return new ImmichFileResponse({
      path,
      fileName: name + extension,
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async viewThumbnail(
    auth: AuthDto,
    id: string,
    dto: AssetMediaOptionsDto,
  ): Promise<ImmichFileResponse | AssetMediaRedirectResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    const edited = isEditedOnly(auth, dto.edited);
    const size = (dto.size ?? AssetMediaSize.THUMBNAIL) as unknown as AssetFileType;
    const { originalPath, originalFileName, path } = await this.assetRepository.getForThumbnail(id, size, edited);

    if (size === AssetFileType.FullSize && mimeTypes.isWebSupportedImage(originalPath) && !edited) {
      // use original file for web supported images
      return { targetSize: 'original' };
    }

    if (dto.size === AssetMediaSize.FULLSIZE && !path) {
      // downgrade to preview if fullsize is not available.
      // e.g. disabled or not yet (re)generated
      return { targetSize: AssetMediaSize.PREVIEW };
    }

    if (!path) {
      throw new NotFoundException('Asset media not found');
    }

    const fileNameBase = isMetadataHidden(auth) ? id : getFileNameWithoutExtension(originalFileName);
    const fileName = `${fileNameBase}_${size}${getFilenameExtension(path)}`;

    return new ImmichFileResponse({
      fileName,
      path,
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async playbackVideo(auth: AuthDto, id: string): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    const asset = await this.assetRepository.getForVideo(id);

    if (!asset) {
      throw new NotFoundException('Asset not found or asset is not a video');
    }

    const filepath = asset.encodedVideoPath || asset.originalPath;

    return new ImmichFileResponse({
      path: filepath,
      contentType: mimeTypes.lookup(filepath),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async bulkUploadCheck(auth: AuthDto, dto: AssetBulkUploadCheckDto): Promise<AssetBulkUploadCheckResponseDto> {
    const checksums: Buffer[] = dto.assets.map((asset) => fromChecksum(asset.checksum));
    const results = await this.assetRepository.getByChecksums(auth.user.id, checksums);
    const checksumMap: Record<string, { id: string; isTrashed: boolean }> = {};

    for (const { id, deletedAt, checksum } of results) {
      checksumMap[checksum.toString('hex')] = { id, isTrashed: !!deletedAt };
    }

    return {
      results: dto.assets.map(({ id, checksum }) => {
        const duplicate = checksumMap[fromChecksum(checksum).toString('hex')];
        if (duplicate) {
          return {
            id,
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            assetId: duplicate.id,
            isTrashed: duplicate.isTrashed,
          };
        }

        return {
          id,
          action: AssetUploadAction.ACCEPT,
        };
      }),
    };
  }

  private async addToSharedLink(sharedLink: AuthSharedLink, assetId: string) {
    if (!sharedLink.albumId) {
      await this.sharedLinkRepository.addAssets(sharedLink.id, [assetId]);
      return;
    }

    const album = await this.albumRepository.getById(sharedLink.albumId);
    if (!album) {
      return;
    }

    await this.albumRepository.addAssetIds(album.id, [assetId]);
    const userIds = album.albumUsers.map(({ user }) => user.id);
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds,
      recipientIds: userIds,
    });
  }

  private requireQuota(auth: AuthDto, size: number) {
    if (auth.user.quotaSizeInBytes !== null && auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + size) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }
}
