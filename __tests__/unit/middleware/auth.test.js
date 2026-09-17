const jwt = require('jsonwebtoken');

// auth.js reads INTERNAL_TOKEN into a module-level const at require time — must be
// set BEFORE the require below, not in a beforeEach.
process.env.INTERNAL_TOKEN = 'shared-secret';
process.env.INTERNAL_JWT_SECRET = 'internal-jwt-secret';
process.env.JWT_ACCESS_SECRET = 'user-jwt-secret';

const { verifyToken } = require('../../../src/middleware/auth');

const mockRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('ffmpeg-service verifyToken middleware', () => {
  test('allows the static internal token', () => {
    const req = { headers: { 'x-internal-token': 'shared-secret' } };
    const res = mockRes();
    const next = jest.fn();

    verifyToken(req, res, next);

    expect(req.user).toEqual({ internal: true });
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ARCH-007 Phase 2: gateway-minted internal JWT, on its own dedicated header.
  // This service previously had no internal-JWT verify path at all.
  test('allows a valid gateway internal JWT (x-internal-jwt)', () => {
    const token = jwt.sign({ service: 'api-gateway' }, 'internal-jwt-secret');
    const req = { headers: { 'x-internal-jwt': token } };
    const res = mockRes();
    const next = jest.fn();

    verifyToken(req, res, next);

    expect(req.user).toMatchObject({ internal: true, service: 'api-gateway' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects an invalid x-internal-jwt and falls through to requiring a bearer token', () => {
    const req = { headers: { 'x-internal-jwt': 'not-a-real-token' } };
    const res = mockRes();
    const next = jest.fn();

    verifyToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('accepts a normal user access token', () => {
    const token = jwt.sign({ user_id: 'user-123' }, 'user-jwt-secret');
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    verifyToken(req, res, next);

    expect(req.user).toMatchObject({ user_id: 'user-123' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects a request with no credentials at all', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    verifyToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
