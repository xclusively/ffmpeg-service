/**
 * Transcode Routes Unit Tests
 * ============================
 * Tests for POST /transcode, GET /transcode/status/:jobId,
 * GET /transcode/queue, GET /transcode/health
 */

const request = require('supertest');
const express = require('express');

process.env.INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'test-internal-token';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-secret';

// Mock logger before requiring routes
jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

// Mock ffmpegService
const mockFfmpegService = {
  queueTranscoding: jest.fn(),
  getJobStatus: jest.fn(),
  getQueueStatus: jest.fn(),
};

jest.mock('../../../src/services/ffmpegService', () => mockFfmpegService);

const transcodeRouter = require('../../../src/routes/transcode');

const app = express();
app.use(express.json());
app.use('/transcode', transcodeRouter);

describe('Transcode Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── POST /transcode ────────────────────────────────────────────────────────
  describe('POST /transcode', () => {
    test('should queue a transcoding job and return 200 with jobId', async () => {
      mockFfmpegService.queueTranscoding.mockResolvedValue({
        jobId: 'job-123',
        status: 'queued',
      });

      const res = await request(app)
        .post('/transcode')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .send({ fileKey: 'original/video.mp4', mediaContent: 'base64data' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.jobId).toBe('job-123');
      expect(res.body.status).toBe('queued');
      expect(res.body.fileKey).toBe('original/video.mp4');
      expect(mockFfmpegService.queueTranscoding).toHaveBeenCalledWith(
        expect.objectContaining({
          fileKey: 'original/video.mp4',
          mediaContent: 'base64data',
        })
      );
    });

    test('should return 400 when fileKey is missing', async () => {
      const res = await request(app)
        .post('/transcode')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .send({ mediaContent: 'base64data' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/fileKey/i);
      expect(mockFfmpegService.queueTranscoding).not.toHaveBeenCalled();
    });

    test('should return 400 when mediaContent is missing', async () => {
      const res = await request(app)
        .post('/transcode')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .send({ fileKey: 'original/video.mp4' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/mediaContent/i);
      expect(mockFfmpegService.queueTranscoding).not.toHaveBeenCalled();
    });

    test('should return 400 when body is empty', async () => {
      const res = await request(app)
        .post('/transcode')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    test('should return 500 when queueTranscoding throws an error', async () => {
      mockFfmpegService.queueTranscoding.mockRejectedValue(new Error('Redis connection failed'));

      const res = await request(app)
        .post('/transcode')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .send({ fileKey: 'original/video.mp4', mediaContent: 'base64data' })
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Failed to queue transcoding job');
    });
  });

  // ─── GET /transcode/status/:jobId ───────────────────────────────────────────
  describe('GET /transcode/status/:jobId', () => {
    test('should return job status for a valid jobId', async () => {
      mockFfmpegService.getJobStatus.mockResolvedValue({
        id: 'job-123',
        status: 'completed',
        progress: 100,
        data: { fileKey: 'original/video.mp4' },
        createdAt: new Date('2024-01-01'),
        processedAt: new Date('2024-01-01'),
        finishedAt: new Date('2024-01-01'),
      });

      const res = await request(app)
        .get('/transcode/status/job-123')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.job.id).toBe('job-123');
      expect(res.body.job.status).toBe('completed');
      expect(mockFfmpegService.getJobStatus).toHaveBeenCalledWith('job-123');
    });

    test('should return not_found status when job does not exist', async () => {
      mockFfmpegService.getJobStatus.mockResolvedValue({ status: 'not_found' });

      const res = await request(app)
        .get('/transcode/status/nonexistent-job')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.job.status).toBe('not_found');
    });

    test('should return 500 when getJobStatus throws an error', async () => {
      mockFfmpegService.getJobStatus.mockRejectedValue(new Error('Queue unreachable'));

      const res = await request(app)
        .get('/transcode/status/job-error')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Failed to get job status');
    });
  });

  // ─── GET /transcode/queue ───────────────────────────────────────────────────
  describe('GET /transcode/queue', () => {
    test('should return queue status', async () => {
      mockFfmpegService.getQueueStatus.mockResolvedValue({
        waiting: 3,
        active: 1,
        completed: 15,
        failed: 2,
      });

      const res = await request(app)
        .get('/transcode/queue')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.queue.waiting).toBe(3);
      expect(res.body.queue.active).toBe(1);
      expect(res.body.queue.completed).toBe(15);
      expect(res.body.queue.failed).toBe(2);
    });

    test('should return 500 when getQueueStatus throws an error', async () => {
      mockFfmpegService.getQueueStatus.mockRejectedValue(new Error('Queue unreachable'));

      const res = await request(app)
        .get('/transcode/queue')
        .set('x-internal-token', process.env.INTERNAL_TOKEN)
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Failed to get queue status');
    });
  });

  // ─── GET /transcode/health ──────────────────────────────────────────────────
  describe('GET /transcode/health', () => {
    test('should return healthy status', async () => {
      const res = await request(app).get('/transcode/health').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.service).toBe('ffmpeg-service');
      expect(res.body.status).toBe('healthy');
      expect(res.body.timestamp).toBeDefined();
    });
  });
});
