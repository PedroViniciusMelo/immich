import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:background_downloader/background_downloader.dart' hide Request;
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:logging/logging.dart';

final uploadRepositoryProvider = Provider((ref) => UploadRepository());

class UploadRepository {
  final Logger logger = Logger('UploadRepository');
  final Map<String, int?> _chunkSizeByEndpoint = {};
  void Function(TaskStatusUpdate)? onUploadStatus;
  void Function(TaskProgressUpdate)? onTaskProgress;

  UploadRepository() {
    FileDownloader().registerCallbacks(
      group: kBackupGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kBackupLivePhotoGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kManualUploadGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
  }

  Future<List<bool>> enqueueBackgroundAll(List<UploadTask> tasks) {
    return FileDownloader().enqueueAll(tasks);
  }

  Future<void> deleteDatabaseRecords(String group) {
    return FileDownloader().database.deleteAllRecords(group: group);
  }

  Future<int> reset(String group) {
    return FileDownloader().reset(group: group);
  }

  /// Get a list of tasks that are ENQUEUED or RUNNING
  Future<List<Task>> getActiveTasks(String group) {
    return FileDownloader().allTasks(group: group);
  }

  Future<void> start() {
    return FileDownloader().start();
  }

  Future<UploadResult> uploadFile({
    required File file,
    required String originalFileName,
    required Map<String, String> fields,
    required Completer<void>? cancelToken,
    void Function(int bytes, int totalBytes)? onProgress,
    required String logContext,
    Client? httpClient,
  }) async {
    final String savedEndpoint = Store.get(StoreKey.serverEndpoint);
    try {
      final client = httpClient ?? NetworkRepository.client;
      final length = file.lengthSync();
      final chunkSize = await _getChunkSize(client, savedEndpoint);
      if (chunkSize != null && length > chunkSize) {
        return await _uploadChunked(
          client: client,
          endpoint: savedEndpoint,
          chunkSize: chunkSize,
          file: file,
          length: length,
          originalFileName: originalFileName,
          fields: fields,
          cancelToken: cancelToken,
          onProgress: onProgress,
          logContext: logContext,
        );
      }

      final response = await _sendWithResend(client, logContext, () {
        final request = ProgressMultipartRequest(
          'POST',
          Uri.parse('$savedEndpoint/assets'),
          abortTrigger: cancelToken?.future,
          onProgress: onProgress,
        );
        request.fields.addAll(fields);
        request.files.add(MultipartFile("assetData", file.openRead(), length, filename: originalFileName));
        return request;
      });

      return _toUploadResult(response.statusCode, await response.stream.bytesToString());
    } on RequestAbortedException {
      logger.warning("Upload $logContext was cancelled");
      return UploadResult.cancelled();
    } catch (error, stackTrace) {
      logger.warning("Error uploading $logContext", error, stackTrace);
      return UploadResult(isSuccess: false, isCancelled: false, errorMessage: error.toString(), error: error);
    }
  }

  Future<int?> _getChunkSize(Client client, String endpoint) async {
    if (_chunkSizeByEndpoint.containsKey(endpoint)) {
      return _chunkSizeByEndpoint[endpoint];
    }

    try {
      final response = await client.send(Request('GET', Uri.parse('$endpoint/config')));
      final body = await response.stream.bytesToString();
      if (response.statusCode == 404) {
        return _chunkSizeByEndpoint[endpoint] = null;
      }
      if (response.statusCode == 200) {
        final chunkSizeMb = jsonDecode(body)['server']?['uploadChunkSizeMb'];
        return _chunkSizeByEndpoint[endpoint] = chunkSizeMb is int ? chunkSizeMb * 1024 * 1024 : null;
      }
    } catch (error) {
      logger.warning("Failed to read the upload chunk size", error);
    }

    return null;
  }

  Future<UploadResult> _uploadChunked({
    required Client client,
    required String endpoint,
    required int chunkSize,
    required File file,
    required int length,
    required String originalFileName,
    required Map<String, String> fields,
    required Completer<void>? cancelToken,
    required void Function(int bytes, int totalBytes)? onProgress,
    required String logContext,
  }) async {
    final sessionsUrl = '$endpoint/assets/upload-sessions';
    final created = await _sendWithResend(
      client,
      logContext,
      () => _jsonRequest('POST', Uri.parse(sessionsUrl), {'filename': originalFileName, 'size': length}, cancelToken),
    );
    final createdBody = await created.stream.bytesToString();
    if (created.statusCode != 201) {
      return _toUploadResult(created.statusCode, createdBody);
    }

    final sessionUrl = '$sessionsUrl/${jsonDecode(createdBody)['id']}';
    var isFinished = false;

    try {
      for (var start = 0, index = 1; start < length; start += chunkSize, index++) {
        final end = min(start + chunkSize, length);
        final response = await _sendWithResend(
          client,
          logContext,
          () => FileChunkRequest(
            'PUT',
            Uri.parse('$sessionUrl/chunks/$index'),
            file: file,
            start: start,
            end: end,
            abortTrigger: cancelToken?.future,
            onProgress: onProgress != null ? (bytes) => onProgress(start + bytes, length) : null,
          ),
        );
        final body = await response.stream.bytesToString();
        if (response.statusCode == 413) {
          _chunkSizeByEndpoint.remove(endpoint);
        }
        if (response.statusCode != 204) {
          return _toUploadResult(response.statusCode, body);
        }
      }

      final finished = await _sendWithResend(
        client,
        logContext,
        () => _jsonRequest(
          'POST',
          Uri.parse('$sessionUrl/finish'),
          _toFinishBody(fields, originalFileName, length),
          cancelToken,
        ),
      );
      final result = _toUploadResult(finished.statusCode, await finished.stream.bytesToString());
      isFinished = result.isSuccess;
      return result;
    } finally {
      if (!isFinished) {
        unawaited(_cancelUploadSession(client, sessionUrl, logContext));
      }
    }
  }

  Future<void> _cancelUploadSession(Client client, String sessionUrl, String logContext) async {
    try {
      final response = await client.send(Request('DELETE', Uri.parse(sessionUrl)));
      await response.stream.drain<void>();
    } catch (error) {
      logger.warning("Failed to cancel the upload session of $logContext", error);
    }
  }

  Future<StreamedResponse> _sendWithResend(
    Client client,
    String logContext,
    BaseRequest Function() buildRequest,
  ) async {
    try {
      return await client.send(buildRequest());
    } on RequestAbortedException {
      rethrow;
    } on ClientException catch (error) {
      logger.warning("Upload $logContext failed before a response, resending once", error);
      return client.send(buildRequest());
    }
  }

  static Request _jsonRequest(String method, Uri url, Map<String, Object?> body, Completer<void>? cancelToken) {
    return AbortableRequest(method, url, abortTrigger: cancelToken?.future)
      ..headers['Content-Type'] = 'application/json'
      ..body = jsonEncode(body);
  }

  static Map<String, Object?> _toFinishBody(Map<String, String> fields, String filename, int size) {
    final duration = fields['duration'];
    final isFavorite = fields['isFavorite'];
    final metadata = fields['metadata'];
    return {
      'filename': filename,
      'size': size,
      'fileCreatedAt': fields['fileCreatedAt'],
      'fileModifiedAt': fields['fileModifiedAt'],
      if (duration != null) 'duration': int.parse(duration),
      if (isFavorite != null) 'isFavorite': isFavorite == 'true',
      if (fields['visibility'] != null) 'visibility': fields['visibility'],
      if (fields['livePhotoVideoId'] != null) 'livePhotoVideoId': fields['livePhotoVideoId'],
      if (metadata != null) 'metadata': jsonDecode(metadata),
    };
  }

  static UploadResult _toUploadResult(int statusCode, String body) {
    if (![200, 201].contains(statusCode)) {
      if (statusCode == 413) {
        return UploadResult.error(statusCode: statusCode, errorMessage: 'Error(413) File is too large to upload');
      }

      String? errorMessage;
      try {
        final error = jsonDecode(body);
        errorMessage = error['message'] ?? error['error'];
      } catch (_) {
        errorMessage = body.isNotEmpty ? body : 'Upload failed with status $statusCode';
      }

      return UploadResult.error(statusCode: statusCode, errorMessage: errorMessage);
    }

    try {
      final responseBody = jsonDecode(body);
      return UploadResult.success(remoteAssetId: responseBody['id'] as String);
    } catch (e) {
      return UploadResult.error(errorMessage: 'Failed to parse server response');
    }
  }
}

class FileChunkRequest extends BaseRequest with Abortable {
  FileChunkRequest(
    super.method,
    super.url, {
    required this.file,
    required this.start,
    required this.end,
    this.abortTrigger,
    this.onProgress,
  }) {
    contentLength = end - start;
    headers['Content-Type'] = 'application/octet-stream';
  }

  final File file;
  final int start;
  final int end;

  @override
  final Future<void>? abortTrigger;

  final void Function(int bytes)? onProgress;

  @override
  ByteStream finalize() {
    super.finalize();
    var bytes = 0;
    return ByteStream(
      file.openRead(start, end).map((data) {
        bytes += data.length;
        onProgress?.call(bytes);
        return data;
      }),
    );
  }
}

class ProgressMultipartRequest extends MultipartRequest with Abortable {
  ProgressMultipartRequest(super.method, super.url, {this.abortTrigger, this.onProgress});

  @override
  final Future<void>? abortTrigger;

  final void Function(int bytes, int totalBytes)? onProgress;

  @override
  ByteStream finalize() {
    final byteStream = super.finalize();
    if (onProgress == null) {
      return byteStream;
    }

    final total = contentLength;
    var bytes = 0;
    final stream = byteStream.transform(
      StreamTransformer.fromHandlers(
        handleData: (List<int> data, EventSink<List<int>> sink) {
          bytes += data.length;
          onProgress!(bytes, total);
          sink.add(data);
        },
      ),
    );
    return ByteStream(stream);
  }
}

class UploadResult {
  final bool isSuccess;
  final bool isCancelled;
  final String? remoteAssetId;
  final String? errorMessage;
  final int? statusCode;
  final Object? error;

  const UploadResult({
    required this.isSuccess,
    required this.isCancelled,
    this.remoteAssetId,
    this.errorMessage,
    this.statusCode,
    this.error,
  });

  factory UploadResult.success({required String remoteAssetId}) {
    return UploadResult(isSuccess: true, isCancelled: false, remoteAssetId: remoteAssetId);
  }

  factory UploadResult.error({String? errorMessage, int? statusCode}) {
    return UploadResult(isSuccess: false, isCancelled: false, errorMessage: errorMessage, statusCode: statusCode);
  }

  factory UploadResult.cancelled() {
    return const UploadResult(isSuccess: false, isCancelled: true);
  }
}
