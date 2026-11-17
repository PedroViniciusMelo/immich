import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:logging/logging.dart';
import 'package:mocktail/mocktail.dart';

class _MockHttpClient extends Mock implements http.Client {}

class _FakeBaseRequest extends Fake implements http.BaseRequest {}

// keeps the FileDownloader singleton off the disk and off the platform channels
class _NoStorage extends Fake implements PersistentStorage {
  @override
  Future<void> initialize() async {}
}

void main() {
  late _MockHttpClient client;
  late UploadRepository sut;
  late File file;
  late File largeFile;
  late http.StreamedResponse Function() configResponse;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    FileDownloader(persistentStorage: _NoStorage());
    final db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
    await Store.put(StoreKey.serverEndpoint, 'http://demo.immich.app/api');
    registerFallbackValue(_FakeBaseRequest());
    final directory = Directory.systemTemp.createTempSync();
    file = File('${directory.path}/photo.jpg')..writeAsStringSync('bytes');
    largeFile = File('${directory.path}/video.mp4')..writeAsBytesSync(List.filled(_mib * 5 ~/ 2, 7));
  });

  setUp(() {
    client = _MockHttpClient();
    sut = UploadRepository();
    configResponse = () => response(404, '{"message":"Not Found"}');
  });

  // consumes the body like a real client would, so a reused request would blow up on the second send
  void stubSend(FutureOr<http.StreamedResponse> Function(int attempt) answer) {
    var attempt = 0;
    when(() => client.send(any())).thenAnswer((invocation) async {
      final request = invocation.positionalArguments.single as http.BaseRequest;
      await request.finalize().drain<void>();
      if (request.url.path.endsWith('/config')) {
        return configResponse();
      }
      return answer(++attempt);
    });
  }

  Future<UploadResult> upload() => sut.uploadFile(
    file: file,
    originalFileName: 'photo.jpg',
    fields: const {'deviceAssetId': 'a1'},
    cancelToken: null,
    logContext: 'a1',
    httpClient: client,
  );

  test('resends once when the first send dies before a response', () async {
    stubSend((attempt) {
      if (attempt == 1) {
        throw http.ClientException('Broken pipe');
      }
      return response(201, '{"id":"remote-1"}');
    });

    final result = await upload();

    expect(result.isSuccess, isTrue);
    expect(result.remoteAssetId, 'remote-1');
    verify(() => client.send(any(that: _isPath('/api/assets')))).called(2);
  });

  test('a second transport failure is an error, no third send', () async {
    stubSend((_) => throw http.ClientException('Connection reset'));

    final result = await upload();

    expect(result.isSuccess, isFalse);
    expect(result.isCancelled, isFalse);
    verify(() => client.send(any(that: _isPath('/api/assets')))).called(2);
  });

  test('a cancelled upload is not resent', () async {
    stubSend((_) => throw http.RequestAbortedException());

    final result = await upload();

    expect(result.isCancelled, isTrue);
    verify(() => client.send(any(that: _isPath('/api/assets')))).called(1);
  });

  test('a cancel during the resend still counts as cancelled', () async {
    stubSend((attempt) {
      if (attempt == 1) {
        throw http.ClientException('Broken pipe');
      }
      throw http.RequestAbortedException();
    });

    final result = await upload();

    expect(result.isCancelled, isTrue);
    verify(() => client.send(any(that: _isPath('/api/assets')))).called(2);
  });

  test('a server error response is not resent', () async {
    stubSend((_) => response(500, '{"message":"boom"}'));

    final result = await upload();

    expect(result.statusCode, 500);
    expect(result.errorMessage, 'boom');
    verify(() => client.send(any(that: _isPath('/api/assets')))).called(1);
  });

  test('a transport failure is logged as the error, not in the message', () async {
    final error = http.ClientException('Failed to connect to /203.0.113.9:2283');
    stubSend((_) => throw error);
    final level = Logger.root.level;
    addTearDown(() => Logger.root.level = level);
    Logger.root.level = Level.ALL;
    final records = <LogRecord>[];
    final subscription = sut.logger.onRecord.listen(records.add);

    final result = await upload();
    await subscription.cancel();

    expect(records.map((r) => r.error), [error, error]);
    expect(records.map((r) => r.message), everyElement(isNot(contains('203.0.113.9'))));
    expect(result.error, error);
  });

  group('chunked upload', () {
    late List<({String method, String path, List<int> body})> requests;

    setUp(() {
      requests = [];
      configResponse = () => response(200, '{"server":{"uploadChunkSizeMb":1}}');
    });

    void stubServer({FutureOr<http.StreamedResponse?> Function(String method, String path, int attempt)? answer}) {
      final attempts = <String, int>{};
      when(() => client.send(any())).thenAnswer((invocation) async {
        final request = invocation.positionalArguments.single as http.BaseRequest;
        final body = await request.finalize().toBytes();
        final path = request.url.path.replaceFirst('/api', '');
        if (path == '/config') {
          return configResponse();
        }
        requests.add((method: request.method, path: path, body: body));
        final key = '${request.method} $path';
        attempts[key] = (attempts[key] ?? 0) + 1;
        final custom = await answer?.call(request.method, path, attempts[key]!);
        if (custom != null) {
          return custom;
        }
        return switch ((request.method, path)) {
          ('POST', '/assets/upload-sessions') => response(201, '{"id":"session-1","chunks":[]}'),
          ('PUT', _) => response(204, ''),
          ('POST', '/assets/upload-sessions/session-1/finish') => response(201, '{"id":"remote-1","status":"created"}'),
          _ => response(204, ''),
        };
      });
    }

    Future<UploadResult> uploadLarge({Completer<void>? cancelToken, void Function(int, int)? onProgress}) =>
        sut.uploadFile(
          file: largeFile,
          originalFileName: 'video.mp4',
          fields: const {
            'deviceAssetId': 'a1',
            'deviceId': 'd1',
            'fileCreatedAt': '2026-01-01T00:00:00.000Z',
            'fileModifiedAt': '2026-01-02T00:00:00.000Z',
            'isFavorite': 'true',
            'duration': '1500',
            'visibility': 'hidden',
            'metadata': '[{"key":"mobile-app","value":{"iCloudId":"1"}}]',
          },
          cancelToken: cancelToken,
          onProgress: onProgress,
          logContext: 'a1',
          httpClient: client,
        );

    test('splits a file larger than the server chunk size into numbered chunks', () async {
      stubServer();

      final result = await uploadLarge();

      expect(result.isSuccess, isTrue);
      expect(result.remoteAssetId, 'remote-1');
      expect(requests.map((r) => '${r.method} ${r.path}'), [
        'POST /assets/upload-sessions',
        'PUT /assets/upload-sessions/session-1/chunks/1',
        'PUT /assets/upload-sessions/session-1/chunks/2',
        'PUT /assets/upload-sessions/session-1/chunks/3',
        'POST /assets/upload-sessions/session-1/finish',
      ]);
      expect(jsonDecode(utf8.decode(requests.first.body)), {'filename': 'video.mp4', 'size': _mib * 5 ~/ 2});
      expect(requests.where((r) => r.method == 'PUT').map((r) => r.body.length), [_mib, _mib, _mib ~/ 2]);
      expect(jsonDecode(utf8.decode(requests.last.body)), {
        'filename': 'video.mp4',
        'size': _mib * 5 ~/ 2,
        'fileCreatedAt': '2026-01-01T00:00:00.000Z',
        'fileModifiedAt': '2026-01-02T00:00:00.000Z',
        'duration': 1500,
        'isFavorite': true,
        'visibility': 'hidden',
        'metadata': [
          {
            'key': 'mobile-app',
            'value': {'iCloudId': '1'},
          },
        ],
      });
    });

    test('reports progress across all chunks', () async {
      stubServer();
      final progress = <int>[];

      await uploadLarge(onProgress: (bytes, total) => progress.add(bytes));

      expect(progress.last, _mib * 5 ~/ 2);
      expect(progress, orderedEquals([...progress]..sort()));
    });

    test('reads the chunk size from the server once', () async {
      stubServer();

      await uploadLarge();
      await uploadLarge();

      verify(() => client.send(any(that: _isPath('/api/config')))).called(1);
    });

    test('a file within the chunk size is sent in a single request', () async {
      stubServer();

      final result = await upload();

      expect(result.isSuccess, isFalse);
      expect(requests.map((r) => '${r.method} ${r.path}'), ['POST /assets']);
    });

    test('a server without a chunk size gets a single request', () async {
      configResponse = () => response(200, '{"server":{}}');
      stubServer(answer: (method, path, _) => path == '/assets' ? response(201, '{"id":"remote-1"}') : null);

      final result = await uploadLarge();

      expect(result.remoteAssetId, 'remote-1');
      expect(requests.map((r) => '${r.method} ${r.path}'), ['POST /assets']);
    });

    test('resends a chunk once when it dies before a response', () async {
      stubServer(
        answer: (method, path, attempt) =>
            path.endsWith('/chunks/2') && attempt == 1 ? throw http.ClientException('Broken pipe') : null,
      );

      final result = await uploadLarge();

      expect(result.isSuccess, isTrue);
      expect(requests.where((r) => r.path.endsWith('/chunks/2')), hasLength(2));
    });

    test('a rejected chunk stops the upload and discards the session', () async {
      stubServer(
        answer: (method, path, _) => path.endsWith('/chunks/2') ? response(413, '{"message":"too large"}') : null,
      );

      final result = await uploadLarge();
      await pumpEventQueue();

      expect(result.statusCode, 413);
      expect(requests.map((r) => '${r.method} ${r.path}'), [
        'POST /assets/upload-sessions',
        'PUT /assets/upload-sessions/session-1/chunks/1',
        'PUT /assets/upload-sessions/session-1/chunks/2',
        'DELETE /assets/upload-sessions/session-1',
      ]);
    });

    test('a cancelled upload discards the session', () async {
      stubServer(answer: (method, path, _) => path.endsWith('/chunks/2') ? throw http.RequestAbortedException() : null);

      final result = await uploadLarge();
      await pumpEventQueue();

      expect(result.isCancelled, isTrue);
      expect(requests.last.method, 'DELETE');
    });
  });
}

const _mib = 1024 * 1024;

http.StreamedResponse response(int status, String body) =>
    http.StreamedResponse(Stream.value(utf8.encode(body)), status);

Matcher _isPath(String path) => isA<http.BaseRequest>().having((r) => r.url.path, 'path', path);
