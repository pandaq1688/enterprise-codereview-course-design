import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/shared/app-error.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

test('AppError serializes code, Chinese message, and details', () => {
  const err = new AppError(ErrorCodes.INVALID_REQUEST, '请求无效', ['sourceMode']);
  assert.equal(err.code, 'INVALID_REQUEST');
  assert.equal(err.message, '请求无效');
  assert.deepEqual(err.toJSON(), {
    error: { code: 'INVALID_REQUEST', message: '请求无效', details: ['sourceMode'] }
  });
});
