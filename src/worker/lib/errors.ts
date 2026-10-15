// Errors that map to HTTP responses and MCP tool errors. Messages are safe to
// show to the user: they never contain secrets, tokens or phrases.

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "invalid_request", message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, "forbidden", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, "conflict", message, details);
  }
}

/** A write guard found that a row changed between reading and writing it. */
export class StaleWriteError extends ConflictError {
  constructor() {
    super("Someone else changed this at the same moment. Please try again.");
  }
}

/** A Claude write named a run that is missing, finished, expired or not this user's. */
export class RunNotOpenError extends AppError {
  constructor(message = "The run is not open. Call start_run first and pass its run_id.") {
    super(409, "run_not_open", message);
  }
}
