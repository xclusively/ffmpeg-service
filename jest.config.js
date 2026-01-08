/**
 * Jest configuration for ffmpeg-service
 * @type {import('jest').Config}
 */
const config = {
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
  testPathIgnorePatterns: ['/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/coverage/'],
  roots: ['<rootDir>'],
  verbose: true,
};

module.exports = config;
