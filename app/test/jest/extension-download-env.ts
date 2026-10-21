// Jest runs CommonJS rather than Vite; supply the same public build input.
export const extensionDownloadBuild =
  process.env.QCLI_GIT_COMMIT_HASH ?? 'jest-build'
