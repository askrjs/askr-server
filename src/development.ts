/** True unless `NODE_ENV` is `"production"`; development-only diagnostics check this per call. */
export function isDevelopment(): boolean {
  const processLike = (
    globalThis as {
      process?: { env?: { NODE_ENV?: string } };
    }
  ).process;
  return processLike?.env?.NODE_ENV !== "production";
}
