import { describe, expect, it } from 'vitest';
import { extractOutputString, resolveBackendConfig } from './index.js';

describe('resolveBackendConfig', () => {
  it('returns null when state bucket/key are missing', () => {
    const result = resolveBackendConfig({}, {});
    expect(result).toBeNull();
  });

  it('builds config from input and env', () => {
    const result = resolveBackendConfig(
      {
        stateBucket: 'tf-state',
        stateKey: 'studio/terraform.tfstate',
      },
      {
        YC_REGION: 'ru-central1',
        YC_ACCESS_KEY: 'ak',
        YC_SECRET_KEY: 'sk',
      },
    );

    expect(result).toEqual({
      bucket: 'tf-state',
      key: 'studio/terraform.tfstate',
      region: 'ru-central1',
      endpoint: 'https://storage.yandexcloud.net',
      accessKey: 'ak',
      secretKey: 'sk',
    });
  });

  it('throws when credentials are missing', () => {
    expect(() =>
      resolveBackendConfig(
        {
          stateBucket: 'tf-state',
          stateKey: 'studio/terraform.tfstate',
        },
        {},
      ),
    ).toThrow('Backend credentials are required');
  });
});

describe('extractOutputString', () => {
  it('returns output value when present', () => {
    const value = extractOutputString(
      {
        assets_bucket: {
          value: 'my-assets-bucket',
        },
      },
      'assets_bucket',
    );

    expect(value).toBe('my-assets-bucket');
  });

  it('returns undefined for missing or null-like values', () => {
    expect(extractOutputString({}, 'assets_bucket')).toBeUndefined();
    expect(
      extractOutputString({ assets_bucket: { value: null } }, 'assets_bucket'),
    ).toBeUndefined();
    expect(
      extractOutputString({ assets_bucket: { value: 'null' } }, 'assets_bucket'),
    ).toBeUndefined();
    expect(
      extractOutputString({ assets_bucket: { value: '  ' } }, 'assets_bucket'),
    ).toBeUndefined();
  });
});
