import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const prod = {
  NODE_ENV: 'production',
  AUTH_MODE: 'production',
  SESSION_SECRET: 'a'.repeat(40),
  DATABASE_URL: 'postgres://app:s3cret@db:5432/neuroflow',
  REDIS_URL: 'redis://redis:6379',
  SECRETS_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadConfig', () => {
  it('treats empty values as unset (copied .env.example)', () => {
    expect(loadConfig({ SESSION_SECRET: '', PORT: '' }).PORT).toBe(8080);
  });

  it('accepts a complete production configuration', () => {
    expect(loadConfig(prod).AUTH_MODE).toBe('production');
  });

  it('refuses development defaults and credentials in production', () => {
    expect(() => loadConfig({ ...prod, SESSION_SECRET: '' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: '' })).toThrow(/DATABASE_URL must be set/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: 'postgres://neuroflow:neuroflow@db/x' })).toThrow(/development password/);
    expect(() => loadConfig({ ...prod, AUTH_MODE: 'dev' })).toThrow(/AUTH_MODE/);
    expect(() => loadConfig({ ...prod, DEV_API_KEY: 'nf_x' })).toThrow(/DEV_API_KEY/);
  });
});
