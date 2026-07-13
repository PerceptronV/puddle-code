/**
 * Error carrying an HTTP status + machine-readable code. Thrown from stores
 * and services and rendered by the app-level error handler — a deliberate
 * shortcut over a separate domain-error hierarchy at this codebase's size.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static notFound(what: string, id: string | number): ApiError {
    return new ApiError(404, 'not_found', `${what} ${id} does not exist`);
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message);
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(400, code, message);
  }
}
