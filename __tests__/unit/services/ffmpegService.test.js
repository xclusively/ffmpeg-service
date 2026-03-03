/**
 * FFmpegService Unit Tests
 * =========================
 * Tests for FFmpegService methods:
 * - getOptimalTargets (pure logic, no mocks needed)
 * - queueTranscoding (mocked Bull queue)
 * - getQueueStatus (mocked Bull queue)
 * - getJobStatus (mocked Bull queue)
 */

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock Bull queue
const mockJob = {
  id: 'job-1',
  getState: jest.fn().mockResolvedValue('completed'),
  progress: jest.fn().mockReturnValue(100),
  data: { fileKey: 'original/test.mp4', mediaContent: 'base64...' },
  timestamp: Date.now(),
  processedOn: Date.now(),
  finishedOn: Date.now(),
};

const mockQueue = {
  add: jest.fn().mockResolvedValue(mockJob),
  process: jest.fn(),
  on: jest.fn(),
  getWaiting: jest.fn().mockResolvedValue([]),
  getActive: jest.fn().mockResolvedValue([]),
  getCompleted: jest.fn().mockResolvedValue([]),
  getFailed: jest.fn().mockResolvedValue([]),
  getJob: jest.fn(),
};

jest.mock('bull', () => jest.fn(() => mockQueue));

// Mock HetznerService
jest.mock('../../../src/services/HetznerService', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('path/to/uploaded/file'),
}));

// Mock s3Client
jest.mock('../../../src/utils/s3Client', () => ({
  s3Client: { send: jest.fn() },
}));

let ffmpegService;

describe('FFmpegService', () => {
  beforeAll(() => {
    ffmpegService = require('../../../src/services/ffmpegService');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset default mock implementations
    mockQueue.add.mockResolvedValue(mockJob);
    mockQueue.getWaiting.mockResolvedValue([{}, {}]);
    mockQueue.getActive.mockResolvedValue([{}]);
    mockQueue.getCompleted.mockResolvedValue([{}, {}, {}]);
    mockQueue.getFailed.mockResolvedValue([]);
    mockJob.getState.mockResolvedValue('completed');
  });

  // ─── getOptimalTargets ──────────────────────────────────────────────────────
  describe('getOptimalTargets()', () => {
    const paths = {
      p1080: '1080p/video.mp4',
      p720: '720p/video.mp4',
      p480: '480p/video.mp4',
      p360: '360p/video.mp4',
    };

    test('should return all 4 variants for 4K source (3840x2160)', () => {
      const targets = ffmpegService.getOptimalTargets(3840, 2160, paths);
      expect(targets.length).toBe(4);
      expect(targets.map((t) => t.h)).toEqual([1080, 720, 480, 360]);
    });

    test('should return 3 variants for 1080p source (1920x1080)', () => {
      // 1080 > 720, 480, 360 but NOT > 1080
      const targets = ffmpegService.getOptimalTargets(1920, 1080, paths);
      expect(targets.some((t) => t.h === 1080)).toBe(false);
      expect(targets.some((t) => t.h === 720)).toBe(true);
      expect(targets.some((t) => t.h === 480)).toBe(true);
      expect(targets.some((t) => t.h === 360)).toBe(true);
    });

    test('should return 2 variants for 720p source (1280x720)', () => {
      // 720 > 480, 360 but NOT > 720
      const targets = ffmpegService.getOptimalTargets(1280, 720, paths);
      expect(targets.some((t) => t.h === 1080)).toBe(false);
      expect(targets.some((t) => t.h === 720)).toBe(false);
      expect(targets.some((t) => t.h === 480)).toBe(true);
      expect(targets.some((t) => t.h === 360)).toBe(true);
    });

    test('should return 1 variant for 480p source (854x480)', () => {
      // 480 > 360 but NOT > 480
      const targets = ffmpegService.getOptimalTargets(854, 480, paths);
      expect(targets.some((t) => t.h === 480)).toBe(false);
      expect(targets.some((t) => t.h === 360)).toBe(true);
      expect(targets.length).toBe(1);
    });

    test('should return no variants for 360p or below source (640x360)', () => {
      const targets = ffmpegService.getOptimalTargets(640, 360, paths);
      expect(targets.length).toBe(0);
    });

    test('each target should have h, key, and path properties', () => {
      const targets = ffmpegService.getOptimalTargets(1920, 1080, paths);
      targets.forEach((target) => {
        expect(target).toHaveProperty('h');
        expect(target).toHaveProperty('key');
        expect(target).toHaveProperty('path');
      });
    });
  });

  // ─── queueTranscoding ───────────────────────────────────────────────────────
  describe('queueTranscoding()', () => {
    test('should add job to queue and return jobId with status queued', async () => {
      mockQueue.add.mockResolvedValue({ ...mockJob, id: 'job-abc' });

      const result = await ffmpegService.queueTranscoding({
        fileKey: 'original/video.mp4',
        mediaContent: 'base64encodedcontent',
        timestamp: 1700000000000,
      });

      expect(result.jobId).toBe('job-abc');
      expect(result.status).toBe('queued');
      expect(mockQueue.add).toHaveBeenCalledWith(
        'transcode-user',
        expect.objectContaining({ fileKey: 'original/video.mp4' }),
        expect.objectContaining({ attempts: 3 })
      );
    });

    test('should throw when queue.add fails', async () => {
      mockQueue.add.mockRejectedValue(new Error('Redis unavailable'));

      await expect(
        ffmpegService.queueTranscoding({
          fileKey: 'original/video.mp4',
          mediaContent: 'data',
        })
      ).rejects.toThrow('Redis unavailable');
    });
  });

  // ─── getQueueStatus ─────────────────────────────────────────────────────────
  describe('getQueueStatus()', () => {
    test('should return correct counts for waiting, active, completed, and failed', async () => {
      mockQueue.getWaiting.mockResolvedValue([{}, {}, {}]);
      mockQueue.getActive.mockResolvedValue([{}]);
      mockQueue.getCompleted.mockResolvedValue([{}, {}, {}, {}, {}]);
      mockQueue.getFailed.mockResolvedValue([{}]);

      const status = await ffmpegService.getQueueStatus();

      expect(status.waiting).toBe(3);
      expect(status.active).toBe(1);
      expect(status.completed).toBe(5);
      expect(status.failed).toBe(1);
    });

    test('should return zeros when queue is empty', async () => {
      mockQueue.getWaiting.mockResolvedValue([]);
      mockQueue.getActive.mockResolvedValue([]);
      mockQueue.getCompleted.mockResolvedValue([]);
      mockQueue.getFailed.mockResolvedValue([]);

      const status = await ffmpegService.getQueueStatus();

      expect(status.waiting).toBe(0);
      expect(status.active).toBe(0);
      expect(status.completed).toBe(0);
      expect(status.failed).toBe(0);
    });
  });

  // ─── getJobStatus ───────────────────────────────────────────────────────────
  describe('getJobStatus()', () => {
    test('should return not_found when job does not exist', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      const result = await ffmpegService.getJobStatus('nonexistent-job');

      expect(result).toEqual({ status: 'not_found' });
      expect(mockQueue.getJob).toHaveBeenCalledWith('nonexistent-job');
    });

    test('should return full job details when job exists', async () => {
      const now = Date.now();
      const job = {
        id: 'job-xyz',
        getState: jest.fn().mockResolvedValue('active'),
        progress: jest.fn().mockReturnValue(45),
        data: { fileKey: 'original/clip.mp4' },
        timestamp: now,
        processedOn: now + 100,
        finishedOn: null,
      };
      mockQueue.getJob.mockResolvedValue(job);

      const result = await ffmpegService.getJobStatus('job-xyz');

      expect(result.id).toBe('job-xyz');
      expect(result.status).toBe('active');
      expect(result.progress).toBe(45);
      expect(result.data.fileKey).toBe('original/clip.mp4');
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.processedAt).toBeInstanceOf(Date);
      expect(result.finishedAt).toBeNull();
    });

    test('should return completed status for a completed job', async () => {
      const now = Date.now();
      const job = {
        id: 'job-done',
        getState: jest.fn().mockResolvedValue('completed'),
        progress: jest.fn().mockReturnValue(100),
        data: { fileKey: 'original/done.mp4' },
        timestamp: now,
        processedOn: now + 200,
        finishedOn: now + 5000,
      };
      mockQueue.getJob.mockResolvedValue(job);

      const result = await ffmpegService.getJobStatus('job-done');

      expect(result.status).toBe('completed');
      expect(result.progress).toBe(100);
      expect(result.finishedAt).toBeInstanceOf(Date);
    });
  });
});
