import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';

export function planShards({ files, contents, shardChars, maxShards }) {
  const shards = [];
  let truncated = false;
  let current = { index: 0, files: [], charCount: 0 };

  const flush = () => {
    if (current.files.length > 0) {
      shards.push(current);
      current = { index: shards.length, files: [], charCount: 0 };
    }
  };

  for (const f of files) {
    const text = contents?.[f.path] ?? '';
    const size = String(text).length;
    if (size > shardChars) {
      flush();
      shards.push({ index: shards.length, files: [f], charCount: size });
      truncated = true;
      current = { index: shards.length, files: [], charCount: 0 };
      continue;
    }
    if (current.charCount + size > shardChars) {
      flush();
    }
    current.files.push(f);
    current.charCount += size;
  }
  flush();

  if (shards.length > maxShards) {
    throw new AppError(ErrorCodes.SHARD_LIMIT_EXCEEDED, '分片数超过上限', [`shards=${shards.length}`, `maxShards=${maxShards}`]);
  }
  return { shards, truncated };
}
