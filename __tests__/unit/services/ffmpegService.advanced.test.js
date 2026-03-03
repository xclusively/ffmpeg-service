/**
 * FFmpegService – Internal Methods Tests
 * ========================================
 * Covers the previously-untested internals:
 *  - setupQueue event callbacks (completed, failed, stalled, process handler)
 *  - probeVideo (success, no video stream, exec error, invalid JSON, missing duration)
 *  - cleanupSingleFile (exists, missing, unlink error)
 *  - transcodeOptimal / transcodeConservative / transcodeSimple /
 *    transcodeCopy / transcodeLastResort  (each with audio and no-audio variants)
 *  - processVariantWithFallbacks (first-strategy success, fallback, all-fail via
 *    small file, output missing)
 *  - processVideoVariants (success, mkdir when path absent, stream write error,
 *    probe error cleanup)
 */

// ─── Mocks (all hoisted by Jest) ─────────────────────────────────────────────

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('child_process', () => ({ exec: jest.fn() }));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  createWriteStream: jest.fn(),
  readFileSync: jest.fn().mockReturnValue(Buffer.alloc(6000)),
  statSync: jest.fn().mockReturnValue({ size: 6000 }),
  unlinkSync: jest.fn(),
}));

jest.mock('../../../src/services/HetznerService', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('path/uploaded.mp4'),
}));

jest.mock('../../../src/utils/s3Client', () => ({
  s3Client: { send: jest.fn() },
}));

// Capture Bull queue event callbacks at construction time
const mockBullCallbacks = {};
const mockBullProcessFn = { fn: null };
const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  process: jest.fn((name, concurrency, fn) => {
    mockBullProcessFn.fn = fn;
  }),
  on: jest.fn((event, fn) => {
    mockBullCallbacks[event] = fn;
  }),
  getWaiting: jest.fn().mockResolvedValue([]),
  getActive: jest.fn().mockResolvedValue([]),
  getCompleted: jest.fn().mockResolvedValue([]),
  getFailed: jest.fn().mockResolvedValue([]),
  getJob: jest.fn(),
};
jest.mock('bull', () => jest.fn(() => mockQueue));

// ─── Mock references ──────────────────────────────────────────────────────────
const { exec: mockExec } = require('child_process');
const mockFs = require('fs');
const HetznerService = require('../../../src/services/HetznerService');

// ─── exec helpers ─────────────────────────────────────────────────────────────
/** Configure exec mock to succeed with optional stdout value.
 * Resolves with { stdout, stderr } so util.promisify destructuring works. */
const makeExecSucceed = (stdout = '') => {
  mockExec.mockImplementation((cmd, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    callback(null, { stdout, stderr: '' });
  });
};

/** Configure exec mock to fail with the given message */
const makeExecFail = (msg = 'exec failed') => {
  mockExec.mockImplementation((cmd, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    callback(new Error(msg));
  });
};

// ─── Shared valid ffprobe JSON ─────────────────────────────────────────────────
const validProbeOutput = JSON.stringify({
  streams: [
    { codec_type: 'video', width: 1920, height: 1080, codec_name: 'h264', r_frame_rate: '30/1' },
    { codec_type: 'audio' },
  ],
  format: { duration: '60.5' },
});

// ─── Service singleton ────────────────────────────────────────────────────────
let ffmpegService;

describe('FFmpegService – Internal Methods', () => {
  beforeAll(() => {
    ffmpegService = require('../../../src/services/ffmpegService');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ size: 6000 });
    mockFs.readFileSync.mockReturnValue(Buffer.alloc(6000));
    HetznerService.uploadBuffer.mockResolvedValue('path/uploaded.mp4');
  });

  // ─── setupQueue callbacks ──────────────────────────────────────────────────
  describe('setupQueue() event callbacks', () => {
    test('queue process handler delegates to processVideoVariants', async () => {
      const spy = jest
        .spyOn(ffmpegService, 'processVideoVariants')
        .mockResolvedValue({ success: true });
      const job = { data: { fileKey: 'original/v.mp4', mediaContent: 'abc' } };
      await mockBullProcessFn.fn(job);
      expect(spy).toHaveBeenCalledWith(job.data);
      spy.mockRestore();
    });

    test('completed callback logs job completion', () => {
      const logger = require('../../../src/config/logger');
      const cb = mockBullCallbacks['completed'];
      expect(cb).toBeDefined();
      cb({ id: '42', data: { fileKey: 'videos/original.mp4' } }, {});
      expect(logger.info).toHaveBeenCalled();
    });

    test('failed callback logs job failure with error message', () => {
      const logger = require('../../../src/config/logger');
      const cb = mockBullCallbacks['failed'];
      expect(cb).toBeDefined();
      cb({ id: '42', data: { fileKey: 'videos/original.mp4' } }, new Error('ETIMEDOUT'));
      expect(logger.error).toHaveBeenCalled();
    });

    test('stalled callback logs stall warning', () => {
      const logger = require('../../../src/config/logger');
      const cb = mockBullCallbacks['stalled'];
      expect(cb).toBeDefined();
      cb({ id: '42', data: { fileKey: 'videos/original.mp4' } });
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ─── probeVideo ───────────────────────────────────────────────────────────
  describe('probeVideo()', () => {
    test('returns parsed video metadata on success', async () => {
      makeExecSucceed(validProbeOutput);
      const result = await ffmpegService.probeVideo('test.mp4');
      expect(result).toMatchObject({
        width: 1920,
        height: 1080,
        hasAudio: true,
        codec: 'h264',
        fps: 30,
        duration: 60.5,
      });
    });

    test('hasAudio is false when no audio stream present', async () => {
      const noAudio = JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            width: 1280,
            height: 720,
            codec_name: 'vp9',
            r_frame_rate: '24/1',
          },
        ],
        format: { duration: '10.0' },
      });
      makeExecSucceed(noAudio);
      const result = await ffmpegService.probeVideo('silent.mp4');
      expect(result.hasAudio).toBe(false);
      expect(result.width).toBe(1280);
    });

    test('returns safe defaults when probe output has no video stream', async () => {
      makeExecSucceed(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} }));
      const result = await ffmpegService.probeVideo('audio-only.mp4');
      expect(result).toMatchObject({
        height: 720,
        width: 1280,
        duration: 0,
        hasAudio: false,
        codec: 'unknown',
        fps: 30,
      });
    });

    test('returns safe defaults on exec error', async () => {
      makeExecFail('ffprobe: command not found');
      const result = await ffmpegService.probeVideo('bad.mp4');
      expect(result).toMatchObject({
        height: 720,
        width: 1280,
        duration: 0,
        hasAudio: false,
        codec: 'unknown',
        fps: 30,
      });
    });

    test('returns safe defaults on invalid JSON output', async () => {
      makeExecSucceed('{not:valid:json}');
      const result = await ffmpegService.probeVideo('corrupt.mp4');
      expect(result.height).toBe(720);
      expect(result.codec).toBe('unknown');
    });

    test('duration defaults to 0 when format.duration is missing', async () => {
      const noFormat = JSON.stringify({
        streams: [{ codec_type: 'video', width: 640, height: 360 }],
        format: {},
      });
      makeExecSucceed(noFormat);
      const result = await ffmpegService.probeVideo('short.mp4');
      expect(result.duration).toBe(0);
    });
  });

  // ─── cleanupSingleFile ─────────────────────────────────────────────────────
  describe('cleanupSingleFile()', () => {
    test('unlinks file when it exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      ffmpegService.cleanupSingleFile('/tmp/videos/output.mp4');
      expect(mockFs.unlinkSync).toHaveBeenCalledWith('/tmp/videos/output.mp4');
    });

    test('does nothing when file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      ffmpegService.cleanupSingleFile('/tmp/videos/missing.mp4');
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });

    test('swallows errors from unlinkSync', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.unlinkSync.mockImplementationOnce(() => {
        throw new Error('EPERM: operation not permitted');
      });
      expect(() => ffmpegService.cleanupSingleFile('/tmp/videos/locked.mp4')).not.toThrow();
    });
  });

  // ─── transcodeOptimal ──────────────────────────────────────────────────────
  describe('transcodeOptimal()', () => {
    test('builds aac audio command when hasAudio is true', async () => {
      makeExecSucceed('');
      await ffmpegService.transcodeOptimal('in.mp4', 'out.mp4', 720, true);
      const cmd = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-c:a aac');
      expect(cmd).toContain('scale=-2:720');
      expect(cmd).toContain('-c:v libx264');
    });

    test('builds no-audio command when hasAudio is false', async () => {
      makeExecSucceed('');
      await ffmpegService.transcodeOptimal('in.mp4', 'out.mp4', 480, false);
      expect(mockExec.mock.calls[0][0]).toContain('-an');
    });

    test('rejects when exec fails', async () => {
      makeExecFail('ffmpeg signal SIGKILL');
      await expect(ffmpegService.transcodeOptimal('in.mp4', 'out.mp4', 1080, true)).rejects.toThrow(
        'ffmpeg signal SIGKILL'
      );
    });
  });

  // ─── transcodeConservative ─────────────────────────────────────────────────
  describe('transcodeConservative()', () => {
    test('includes aac audio when hasAudio is true', async () => {
      makeExecSucceed('');
      await ffmpegService.transcodeConservative('in.mp4', 'out.mp4', 480, true);
      expect(mockExec.mock.calls[0][0]).toContain('-c:a aac');
      expect(mockExec.mock.calls[0][0]).toContain('-crf 25');
    });

    test('includes -an when hasAudio is false', async () => {
      makeExecSucceed('');
      await ffmpegService.transcodeConservative('in.mp4', 'out.mp4', 360, false);
      expect(mockExec.mock.calls[0][0]).toContain('-an');
    });
  });

  // ─── transcodeSimple ───────────────────────────────────────────────────────
  describe('transcodeSimple()', () => {
    test('copies audio stream when hasAudio is true', async () => {
      makeExecSucceed('');
      await ffmpegService.transcodeSimple('in.mp4', 'out.mp4', 360, true);
      expect(mockExec.mock.calls[0][0]).toContain('-c:a copy');
      expect(mockExec.mock.calls[0][0]).toContain('-preset ultrafast');
    });

    test('suppresses audio when hasAudio is false', async () => {
      makeExecSucceed('');
      await ffmpegService.transcodeSimple('in.mp4', 'out.mp4', 360, false);
      expect(mockExec.mock.calls[0][0]).toContain('-an');
    });
  });

  // ─── transcodeCopy ─────────────────────────────────────────────────────────
  describe('transcodeCopy()', () => {
    test('uses stream-copy mode (-c copy)', async () => {
      makeExecSucceed('');
      await ffmpegService.transcodeCopy('in.mp4', 'out.mp4', 720);
      expect(mockExec.mock.calls[0][0]).toContain('-c copy');
    });
  });

  // ─── transcodeLastResort ───────────────────────────────────────────────────
  describe('transcodeLastResort()', () => {
    test('uses mpeg4/mp3 codecs as final fallback', async () => {
      makeExecSucceed('');
      await ffmpegService.transcodeLastResort('in.mp4', 'out.mp4', 360);
      const cmd = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-c:v mpeg4');
      expect(cmd).toContain('-c:a mp3');
      expect(cmd).toContain('-f mp4');
    });
  });

  // ─── processVariantWithFallbacks ───────────────────────────────────────────
  describe('processVariantWithFallbacks()', () => {
    const target = { h: 720, key: 'p720', path: 'videos/720p/vid.mp4' };
    const outputPath = '/tmp/videos/output-tmp123-720p.mp4';

    test('uploads via HetznerService on first-strategy success', async () => {
      makeExecSucceed('');
      await ffmpegService.processVariantWithFallbacks(
        target,
        'input.mp4',
        'tmp123',
        true,
        outputPath
      );
      expect(HetznerService.uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), target.path);
    });

    test('falls back to strategy 2 when strategy 1 exec fails', async () => {
      let calls = 0;
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        calls++;
        if (calls === 1) callback(new Error('strategy 1 failed'));
        else callback(null, { stdout: '', stderr: '' });
      });
      await ffmpegService.processVariantWithFallbacks(
        target,
        'input.mp4',
        'tmp123',
        false,
        outputPath
      );
      expect(mockExec).toHaveBeenCalledTimes(2);
      expect(HetznerService.uploadBuffer).toHaveBeenCalled();
    });

    test('tries all 5 strategies when output is always too small', async () => {
      makeExecSucceed('');
      mockFs.statSync.mockReturnValue({ size: 500 }); // below 1024 threshold
      await ffmpegService.processVariantWithFallbacks(
        target,
        'input.mp4',
        'tmp123',
        true,
        outputPath
      );
      expect(mockExec).toHaveBeenCalledTimes(5);
      expect(HetznerService.uploadBuffer).not.toHaveBeenCalled();
    });

    test('skips upload when output file does not exist after transcode', async () => {
      makeExecSucceed('');
      mockFs.existsSync.mockReturnValue(false);
      await ffmpegService.processVariantWithFallbacks(
        target,
        'input.mp4',
        'tmp123',
        true,
        outputPath
      );
      expect(HetznerService.uploadBuffer).not.toHaveBeenCalled();
    });

    test('runs without audio flags when hasAudio is false', async () => {
      makeExecSucceed('');
      await ffmpegService.processVariantWithFallbacks(
        { h: 480, key: 'p480', path: 'videos/480p/vid.mp4' },
        'input.mp4',
        'tmp456',
        false,
        '/tmp/videos/output-tmp456-480p.mp4'
      );
      expect(HetznerService.uploadBuffer).toHaveBeenCalled();
    });
  });

  // ─── processVideoVariants ─────────────────────────────────────────────────
  describe('processVideoVariants()', () => {
    const baseOptions = {
      fileKey: 'original/video.mp4',
      mediaContent: 'dGVzdA==', // base64 "test"
      timestamp: 1700000000000,
    };

    let readableSpy;
    let mockWriteStream;

    beforeEach(() => {
      const { Readable } = require('stream');
      const { EventEmitter } = require('events');

      // WriteStream mock: automatically emits 'finish' after being created
      mockWriteStream = new EventEmitter();
      mockFs.createWriteStream.mockImplementation(() => {
        setImmediate(() => mockWriteStream.emit('finish'));
        return mockWriteStream;
      });

      // Readable.from mock: pipe() does nothing; finish is triggered by writeStream
      const fakeReadable = new EventEmitter();
      fakeReadable.pipe = jest.fn(() => fakeReadable);
      readableSpy = jest.spyOn(Readable, 'from').mockReturnValue(fakeReadable);
    });

    afterEach(() => {
      readableSpy.mockRestore();
    });

    test('success path returns { success: true, variants }', async () => {
      const probeSpy = jest.spyOn(ffmpegService, 'probeVideo').mockResolvedValue({
        width: 1920,
        height: 1080,
        hasAudio: true,
        codec: 'h264',
        fps: 30,
        duration: 5,
      });
      const pvfSpy = jest
        .spyOn(ffmpegService, 'processVariantWithFallbacks')
        .mockResolvedValue(undefined);
      const cleanupSpy = jest
        .spyOn(ffmpegService, 'cleanupSingleFile')
        .mockImplementation(() => {});

      const result = await ffmpegService.processVideoVariants(baseOptions);

      expect(result).toEqual({ success: true, variants: 3 }); // 1080p source → 720p/480p/360p
      expect(probeSpy).toHaveBeenCalled();
      expect(pvfSpy).toHaveBeenCalledTimes(3);
      expect(cleanupSpy).toHaveBeenCalled();

      probeSpy.mockRestore();
      pvfSpy.mockRestore();
      cleanupSpy.mockRestore();
    });

    test('creates SHARED_VIDEO_PATH when directory does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const probeSpy = jest.spyOn(ffmpegService, 'probeVideo').mockResolvedValue({
        width: 1920,
        height: 1080,
        hasAudio: false,
        codec: 'h264',
        fps: 30,
        duration: 5,
      });
      const pvfSpy = jest
        .spyOn(ffmpegService, 'processVariantWithFallbacks')
        .mockResolvedValue(undefined);
      const cleanupSpy = jest
        .spyOn(ffmpegService, 'cleanupSingleFile')
        .mockImplementation(() => {});

      await ffmpegService.processVideoVariants(baseOptions);
      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/tmp/videos', { recursive: true });

      probeSpy.mockRestore();
      pvfSpy.mockRestore();
      cleanupSpy.mockRestore();
    });

    test('returns 4 variants for 4K source (3840×2160)', async () => {
      const probeSpy = jest.spyOn(ffmpegService, 'probeVideo').mockResolvedValue({
        width: 3840,
        height: 2160,
        hasAudio: true,
        codec: 'hevc',
        fps: 60,
        duration: 5,
      });
      const pvfSpy = jest
        .spyOn(ffmpegService, 'processVariantWithFallbacks')
        .mockResolvedValue(undefined);
      const cleanupSpy = jest
        .spyOn(ffmpegService, 'cleanupSingleFile')
        .mockImplementation(() => {});

      const result = await ffmpegService.processVideoVariants(baseOptions);
      expect(result.variants).toBe(4);

      probeSpy.mockRestore();
      pvfSpy.mockRestore();
      cleanupSpy.mockRestore();
    });

    test('throws and still runs cleanup when probeVideo rejects', async () => {
      const probeSpy = jest
        .spyOn(ffmpegService, 'probeVideo')
        .mockRejectedValue(new Error('probe crashed'));
      const cleanupSpy = jest
        .spyOn(ffmpegService, 'cleanupSingleFile')
        .mockImplementation(() => {});

      await expect(ffmpegService.processVideoVariants(baseOptions)).rejects.toThrow(
        'probe crashed'
      );
      expect(cleanupSpy).toHaveBeenCalled();

      probeSpy.mockRestore();
      cleanupSpy.mockRestore();
    });

    test('throws when stream writeStream emits error', async () => {
      const { Readable } = require('stream');
      const { EventEmitter } = require('events');

      // Replace write stream to emit error instead of finish
      const errorStream = new EventEmitter();
      mockFs.createWriteStream.mockImplementation(() => {
        setImmediate(() => errorStream.emit('error', new Error('ENOSPC: no space left')));
        return errorStream;
      });
      readableSpy.mockRestore();
      const fakeReadable = new EventEmitter();
      fakeReadable.pipe = jest.fn(() => fakeReadable);
      readableSpy = jest.spyOn(Readable, 'from').mockReturnValue(fakeReadable);

      const cleanupSpy = jest
        .spyOn(ffmpegService, 'cleanupSingleFile')
        .mockImplementation(() => {});
      await expect(ffmpegService.processVideoVariants(baseOptions)).rejects.toThrow(
        'ENOSPC: no space left'
      );
      expect(cleanupSpy).toHaveBeenCalled();

      cleanupSpy.mockRestore();
    });
  });
});
