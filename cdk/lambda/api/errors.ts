/** 利用者に理由を返すエラー（400 / 404）。それ以外の例外は 500 として扱う */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
