import { describe, expect, it } from 'vitest';
import { ConfigError, type ResolvedDataset } from '../../lib/config';
import { checkOptionsAgainstConfig, readOptions } from '../../lib/options';
import { base } from './helpers';

const read = (ctx: Record<string, unknown>) => readOptions((k) => ctx[k]);
const errorOf = (ctx: Record<string, unknown>): string => {
  try {
    read(ctx);
    return 'no error';
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.message;
  }
};

describe('readOptions', () => {
  it('既定値', () => {
    expect(read({})).toEqual({
      exposure: 'restPublic',
      auth: 'iam',
      vpcEndpointId: undefined,
      grafanaUser: false,
      grafanaRoleTrust: undefined,
      logRetentionDays: 7,
      throttleRate: 10,
      throttleBurst: 20,
      sample: false,
      cold: false,
      coldIngest: 'scheduled',
      coldScanLimitGb: 1,
      coldRemovalPolicy: 'retain',
      bucketSuffix: undefined,
    });
  });

  it('-c の値は文字列で届くので変換する', () => {
    expect(read({ exposure: 'functionUrl', grafanaUser: 'true', sample: 'true', logRetentionDays: '30' })).toMatchObject({
      exposure: 'functionUrl',
      grafanaUser: true,
      sample: true,
      logRetentionDays: 30,
    });
    expect(read({ exposure: 'restPrivate', vpcEndpointId: 'vpce-0123456789abcdef0', auth: 'apiKey', throttleRate: '5' })).toMatchObject({ throttleRate: 5 });
  });

  it.each([
    [{ exposure: 'lambda' }, '-c exposure=lambda: must be one of restPublic / functionUrl / restPrivate'],
    [{ auth: 'basic' }, '-c auth=basic: must be one of iam / apiKey'],
    [{ logRetentionDays: '10' }, '-c logRetentionDays=10'],
    [{ throttleRate: '0' }, '-c throttleRate=0: must be an integer of 1 or more'],
    [{ exposure: 'functionUrl', auth: 'apiKey' }, 'auth=apiKey works only with the REST API'],
    [{ exposure: 'restPrivate' }, 'vpcEndpointId=vpce-xxxx'],
    [{ vpcEndpointId: 'vpce-0123456789abcdef0' }, 'vpcEndpointId can be used only with exposure=restPrivate'],
    [{ exposure: 'restPrivate', vpcEndpointId: 'abc' }, 'must be an ID that starts with vpce-'],
    [{ grafanaRoleTrust: 'foo' }, 'must be the ARN of an IAM role / user / account (:root)'],
    [{ auth: 'apiKey', grafanaUser: 'true' }, 'can be used only with auth=iam'],
    [{ coldIngest: 'stream' }, 'can be used only with -c cold=true'],
    [{ cold: 'true', coldIngest: 'kinesis' }, '-c coldIngest=kinesis'],
    [{ cold: 'true', coldScanLimitGb: '0' }, '-c coldScanLimitGb=0'],
    [{ bucket_suffix: 'Upper' }, '-c bucket_suffix=Upper'],
  ])('%j → %s', (ctx, expected) => {
    expect(errorOf(ctx)).toContain(expected);
  });

  it('誤りはまとめて表示する', () => {
    const msg = errorOf({ exposure: 'functionUrl', auth: 'apiKey', logRetentionDays: '10', grafanaRoleTrust: 'foo' });
    expect(msg.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(4);
  });

  it('grafanaRoleTrust はロール・ユーザー・アカウントの ARN を受け付ける', () => {
    for (const arn of ['arn:aws:iam::123456789012:role/x', 'arn:aws:iam::123456789012:user/y', 'arn:aws:iam::123456789012:root']) {
      expect(read({ grafanaRoleTrust: arn }).grafanaRoleTrust).toBe(arn);
    }
  });
});

describe('checkOptionsAgainstConfig', () => {
  const errorOfCheck = (datasets: Record<string, ResolvedDataset>, ctx: Record<string, unknown>): string => {
    try {
      checkOptionsAgainstConfig(datasets, read(ctx));
      return 'no error';
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      return e.message;
    }
  };
  const cold = base({ cold: {}, keys: { pattern: '.*' } });

  it('cold のデータセットがあるのに -c cold=true がなければエラー', () => {
    expect(errorOfCheck({ ds: cold }, {})).toContain('-c cold=true is not set');
  });

  it('scheduled ではキーを列挙できる必要がある（keys.values / keys.list）', () => {
    expect(errorOfCheck({ ds: cold }, { cold: 'true' })).toContain('requires keys.values or keys.list');
    expect(errorOfCheck({ ds: cold }, { cold: 'true', coldIngest: 'stream' })).toBe('no error');
    expect(errorOfCheck({ ds: base({ cold: {} }) }, { cold: 'true' })).toBe('no error');
  });

  it('cold がなければ何も確かめない。-c cold=true なのに cold のデータセットがなければエラー', () => {
    expect(errorOfCheck({ ds: base() }, {})).toBe('no error');
    expect(errorOfCheck({ ds: base() }, { cold: 'true' })).toContain('no dataset in datasets.yaml has cold');
  });
});
