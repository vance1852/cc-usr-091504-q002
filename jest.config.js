module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '\\.e2e-spec\\.ts$',
  maxWorkers: 1,
  testTimeout: 30000,
};
