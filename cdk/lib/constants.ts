/** リソース名の接頭辞（Lambda、ロググループ、REST API、IAM など。アカウント内で一意なのでサフィックスは付けない） */
export const PROJECT = 'dynamodb-timeseries-api';

/** -c sample=true で作るサンプルテーブル（config/datasets.yaml のサンプルと scripts/seed.ts が使う） */
export const SAMPLE_TABLE = `${PROJECT}-sample`;
