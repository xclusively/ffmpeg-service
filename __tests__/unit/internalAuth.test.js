const jwt = require('jsonwebtoken');
const internalAuth = require('../../src/utils/internalAuth');

const SECRET = 'test-internal-jwt-secret';
const STATIC = 'test-static-token';

const reqWith = (headers) => ({ headers });
const sign = (payload, secret = SECRET, opts = { expiresIn: 60 }) =>
  jwt.sign(payload, secret, opts);

describe('internalAuth (ARCH-007)', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ['INTERNAL_AUTH_MODE', 'INTERNAL_TOKEN', 'INTERNAL_JWT_SECRET']) {
      saved[k] = process.env[k];
    }
    process.env.INTERNAL_TOKEN = STATIC;
    process.env.INTERNAL_JWT_SECRET = SECRET;
    delete process.env.INTERNAL_AUTH_MODE;
    internalAuth._resetCache();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('dual mode (default)', () => {
    it('sends both the signed JWT and the static token', () => {
      const h = internalAuth.internalHeaders();
      expect(h['x-internal-token']).toBe(STATIC);
      expect(jwt.verify(h['x-internal-jwt'], SECRET).service).toBe('ffmpeg-service');
    });

    it('accepts the static token', () => {
      expect(internalAuth.isInternalRequest(reqWith({ 'x-internal-token': STATIC }))).toBe(true);
    });

    it('accepts x-internal-jwt and Bearer internal JWT', () => {
      const t = sign({ service: 'subscribe-microservice' });
      expect(internalAuth.internalCaller(reqWith({ 'x-internal-jwt': t })).service).toBe(
        'subscribe-microservice'
      );
      expect(internalAuth.isInternalRequest(reqWith({ authorization: `Bearer ${t}` }))).toBe(true);
    });
  });

  describe('jwt mode', () => {
    beforeEach(() => {
      process.env.INTERNAL_AUTH_MODE = 'jwt';
    });

    it('sends only the signed JWT', () => {
      const h = internalAuth.internalHeaders();
      expect(h['x-internal-token']).toBeUndefined();
      expect(h['x-internal-jwt']).toBeTruthy();
    });

    it('rejects the static token', () => {
      expect(internalAuth.isInternalRequest(reqWith({ 'x-internal-token': STATIC }))).toBe(false);
    });

    it('accepts a valid internal JWT', () => {
      expect(
        internalAuth.isInternalRequest(reqWith({ 'x-internal-jwt': sign({ service: 'x' }) }))
      ).toBe(true);
    });
  });

  it.each([
    ['wrong secret', () => sign({ service: 'x' }, 'other-secret')],
    ['expired', () => sign({ service: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, {})],
    ['no service claim (an end-user token)', () => sign({ user_id: 'u1' })],
  ])('rejects a JWT with %s', (_label, make) => {
    const t = make();
    expect(internalAuth.isInternalRequest(reqWith({ 'x-internal-jwt': t }))).toBe(false);
    expect(internalAuth.isInternalRequest(reqWith({ authorization: `Bearer ${t}` }))).toBe(false);
  });

  it('rejects a request with no credential', () => {
    expect(internalAuth.isInternalRequest(reqWith({}))).toBe(false);
  });

  it('requireInternal: 403 without credential, next() + req.internalCaller with one', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    internalAuth.requireInternal(reqWith({}), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    const req = reqWith({ 'x-internal-jwt': sign({ service: 'dating-microservice' }) });
    internalAuth.requireInternal(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.internalCaller.service).toBe('dating-microservice');
  });

  it('isValidStaticToken honours the static token only in dual mode', () => {
    expect(internalAuth.isValidStaticToken(STATIC)).toBe(true);
    expect(internalAuth.isValidStaticToken('wrong')).toBe(false);
    expect(internalAuth.isValidStaticToken(undefined)).toBe(false);
    process.env.INTERNAL_AUTH_MODE = 'jwt';
    expect(internalAuth.isValidStaticToken(STATIC)).toBe(false);
  });

  describe('assertInternalAuthConfigured (boot guard)', () => {
    let exit;
    beforeEach(() => {
      exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('dual mode exits without INTERNAL_TOKEN', () => {
      delete process.env.INTERNAL_TOKEN;
      internalAuth.assertInternalAuthConfigured();
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('jwt mode exits without INTERNAL_JWT_SECRET, ignores missing INTERNAL_TOKEN', () => {
      process.env.INTERNAL_AUTH_MODE = 'jwt';
      delete process.env.INTERNAL_TOKEN;
      internalAuth.assertInternalAuthConfigured();
      expect(exit).not.toHaveBeenCalled();
      delete process.env.INTERNAL_JWT_SECRET;
      internalAuth.assertInternalAuthConfigured();
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
