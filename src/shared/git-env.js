export function buildGitEnv(credentials) {
  const env = { ...process.env };
  const extraArgs = [];
  if (credentials?.tokenEnv) {
    const token = process.env[credentials.tokenEnv];
    if (token) {
      const user = credentials.usernameEnv ? (process.env[credentials.usernameEnv] ?? '') : '';
      extraArgs.push('-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`);
    }
  }
  return { env, extraArgs };
}
