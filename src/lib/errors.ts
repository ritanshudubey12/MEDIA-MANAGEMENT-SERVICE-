export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, details?: unknown) => new ApiError(400, 'VALIDATION_ERROR', m, details);
export const forbidden = (m = 'Forbidden', code = 'FORBIDDEN') => new ApiError(403, code, m);
export const notFound = (m = 'Media not found', code = 'MEDIA_NOT_FOUND') => new ApiError(404, code, m);
export const conflict = (code: string, m: string) => new ApiError(409, code, m);
